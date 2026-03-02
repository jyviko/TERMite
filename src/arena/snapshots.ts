import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SnapshotRef {
  id: string;
  description: string;
  timestamp: string;
}

type VcsBackend = "jj" | "git";

export class SnapshotManager {
  private runDir: string;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshotCount = 0;
  private backend: VcsBackend | null = null;

  /** Promise chain serializes snapshots — no concurrent VCS operations. */
  private chain: Promise<void> = Promise.resolve();

  constructor(config: { runDir: string; intervalMs?: number }) {
    this.runDir = config.runDir;
    this.intervalMs = config.intervalMs ?? 60_000;
  }

  /** Initialize VCS in the run directory. Prefers jj if installed, falls back to git. */
  async init(): Promise<void> {
    this.backend = await detectBackend();

    if (this.backend === "jj") {
      // jj git init creates a jj repo with git backend
      if (!existsSync(join(this.runDir, ".jj"))) {
        await execFileAsync("jj", ["git", "init"], { cwd: this.runDir });
      }
      // Initial snapshot
      await this.doSnapshotJj("init");
    } else {
      // git init + initial commit
      if (!existsSync(join(this.runDir, ".git"))) {
        await execFileAsync("git", ["init"], { cwd: this.runDir });
        await execFileAsync("git", ["-c", "user.name=termite", "-c", "user.email=termite@arena", "commit", "--allow-empty", "-m", "init"], { cwd: this.runDir });
      }
      await this.doSnapshotGit("init");
    }
  }

  /** Start the periodic snapshot timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.snapshot();
    }, this.intervalMs);
  }

  /** Stop the timer and take a final blocking snapshot. */
  async stop(label?: string): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.snapshotSync(label ?? "stop");
  }

  /** Queue a non-blocking snapshot. Safe to call from timers. */
  snapshot(label?: string): void {
    this.chain = this.chain.then(async () => { await this.doSnapshot(label); }).catch((err) => {
      console.error(`[SNAPSHOT] Error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Take a blocking snapshot and return the ref id. */
  async snapshotSync(label?: string): Promise<string | null> {
    let refId: string | null = null;
    await new Promise<void>((resolve) => {
      this.chain = this.chain
        .then(async () => {
          refId = await this.doSnapshot(label);
          resolve();
        })
        .catch((err) => {
          console.error(`[SNAPSHOT] Error: ${err instanceof Error ? err.message : String(err)}`);
          resolve();
        });
    });
    return refId;
  }

  /** List snapshots in reverse chronological order. */
  async list(): Promise<SnapshotRef[]> {
    if (!this.backend) return [];

    try {
      if (this.backend === "jj") {
        return await this.listJj();
      } else {
        return await this.listGit();
      }
    } catch {
      return [];
    }
  }

  /** Restore files to a previous snapshot. Does not rewrite history. */
  async rewind(ref: string): Promise<void> {
    if (!this.backend) {
      throw new Error("Snapshot manager not initialized");
    }

    if (this.backend === "jj") {
      await execFileAsync("jj", ["restore", "--from", ref], { cwd: this.runDir });
    } else {
      // git: checkout files from ref without changing HEAD
      await execFileAsync("git", ["checkout", ref, "--", "."], { cwd: this.runDir });
    }
  }

  private async doSnapshot(label?: string): Promise<string | null> {
    if (!this.backend) return null;

    this.snapshotCount++;
    const desc = label
      ? `snapshot #${this.snapshotCount} [${new Date().toISOString()}] ${label}`
      : `snapshot #${this.snapshotCount} [${new Date().toISOString()}]`;

    if (this.backend === "jj") {
      return this.doSnapshotJj(desc);
    } else {
      return this.doSnapshotGit(desc);
    }
  }

  private async doSnapshotJj(description: string): Promise<string | null> {
    try {
      // jj automatically tracks all changes — just commit the working copy
      const { stdout } = await execFileAsync(
        "jj",
        ["commit", "-m", description],
        { cwd: this.runDir, timeout: 30_000 },
      );
      // Extract the change id from jj output (first word after "Working copy now at: ")
      const match = stdout.match(/Working copy now at:\s+(\S+)/);
      // The committed change is the parent — get its id
      const { stdout: logOut } = await execFileAsync(
        "jj",
        ["log", "-r", "@-", "--no-graph", "-T", "change_id"],
        { cwd: this.runDir, timeout: 10_000 },
      );
      return logOut.trim() || match?.[1] || null;
    } catch (err) {
      // If nothing changed, jj still succeeds — ignore errors
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("No changes to commit")) {
        console.error(`[SNAPSHOT] jj commit failed: ${msg}`);
      }
      return null;
    }
  }

  private async doSnapshotGit(description: string): Promise<string | null> {
    try {
      // Stage everything
      await execFileAsync("git", ["add", "-A"], { cwd: this.runDir, timeout: 30_000 });

      // Check if there are changes to commit
      const { stdout: status } = await execFileAsync(
        "git", ["status", "--porcelain"],
        { cwd: this.runDir, timeout: 10_000 },
      );

      if (status.trim().length === 0) {
        return null; // Nothing to commit
      }

      // Commit
      await execFileAsync(
        "git",
        ["-c", "user.name=termite", "-c", "user.email=termite@arena", "commit", "-m", description],
        { cwd: this.runDir, timeout: 30_000 },
      );

      // Get the commit hash
      const { stdout: hash } = await execFileAsync(
        "git", ["rev-parse", "HEAD"],
        { cwd: this.runDir, timeout: 10_000 },
      );
      return hash.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SNAPSHOT] git commit failed: ${msg}`);
      return null;
    }
  }

  private async listJj(): Promise<SnapshotRef[]> {
    const { stdout } = await execFileAsync(
      "jj",
      ["log", "--no-graph", "-T", `change_id ++ "\\t" ++ description ++ "\\t" ++ committer.timestamp() ++ "\\n"`],
      { cwd: this.runDir, timeout: 10_000 },
    );

    return stdout
      .split("\n")
      .filter((line) => line.includes("snapshot"))
      .map((line) => {
        const [id, description, timestamp] = line.split("\t");
        return { id: id?.trim() ?? "", description: description?.trim() ?? "", timestamp: timestamp?.trim() ?? "" };
      })
      .filter((ref) => ref.id.length > 0);
  }

  private async listGit(): Promise<SnapshotRef[]> {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--format=%H\t%s\t%aI", "--all"],
      { cwd: this.runDir, timeout: 10_000 },
    );

    return stdout
      .split("\n")
      .filter((line) => line.includes("snapshot"))
      .map((line) => {
        const [id, description, timestamp] = line.split("\t");
        return { id: id?.trim() ?? "", description: description?.trim() ?? "", timestamp: timestamp?.trim() ?? "" };
      })
      .filter((ref) => ref.id.length > 0);
  }
}

/** Detect whether jj or git is available. Prefers jj. */
async function detectBackend(): Promise<VcsBackend> {
  try {
    await execFileAsync("jj", ["--version"]);
    return "jj";
  } catch {
    // jj not found — fall back to git
    return "git";
  }
}
