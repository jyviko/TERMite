import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

interface ExecutorConfig {
  workingDir?: string;
  image?: string;
  containerName?: string;
}

interface PipeMessage {
  id: string;
  ok: boolean;
  result?: string;
  error?: string;
  ready?: boolean;
}

const PIPE_TIMEOUT = 35_000;
const READY_TIMEOUT = 10_000;
const STOP_TIMEOUT = 5_000;

export class Executor {
  private config: Required<ExecutorConfig>;
  private process: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<string, {
    resolve: (msg: PipeMessage) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private mutex = Promise.resolve();
  private started = false;

  constructor(config?: ExecutorConfig) {
    this.config = {
      workingDir: resolve(config?.workingDir ?? process.cwd() + "/workspace"),
      image: config?.image ?? "termite-body",
      containerName: config?.containerName ?? `termite-${randomUUID().slice(0, 8)}`,
    };
  }

  get workingDir(): string {
    return this.config.workingDir;
  }

  get containerName(): string {
    return this.config.containerName;
  }

  async start(): Promise<void> {
    // Check docker is available
    try {
      execFileSync("docker", ["info"], { stdio: "ignore" });
    } catch {
      throw new Error("Docker is not running");
    }

    // Build image if Dockerfile exists
    try {
      execFileSync("docker", [
        "build", "-t", this.config.image, "-f", "Dockerfile.body", ".",
      ], { stdio: "ignore", cwd: process.cwd() });
    } catch {
      // Image may already exist
    }

    // Start container
    execFileSync("docker", [
      "run", "-d", "--name", this.config.containerName,
      "-v", `${this.config.workingDir}:/workspace`,
      this.config.image, "tail", "-f", "/dev/null",
    ], { stdio: "ignore" });

    // Open pipe to body agent via docker exec
    this.process = spawn("docker", [
      "exec", "-i", this.config.containerName,
      "tsx", "/agent/body-agent.ts",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[body-agent stderr] ${chunk.toString()}`);
    });

    this.process.on("exit", (code) => {
      this.started = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Body agent exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Wait for ready signal
    await this.waitForReady();

    // Ping to verify
    const pong = await this.send({ cmd: "ping" });
    if (pong.result !== "pong") {
      throw new Error("Body agent ping failed");
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.process) {
      try {
        await this.send({ cmd: "shutdown" }, STOP_TIMEOUT);
      } catch {
        // Ignore shutdown errors
      }
      this.process.kill();
      this.process = null;
    }

    try {
      execFileSync("docker", ["stop", this.config.containerName], {
        timeout: STOP_TIMEOUT,
        stdio: "ignore",
      });
    } catch {
      // Already stopped
    }

    try {
      execFileSync("docker", ["rm", "-f", this.config.containerName], { stdio: "ignore" });
    } catch {
      // Already removed
    }

    this.started = false;
  }

  async executeShell(command: string): Promise<string> {
    const result = await this.send({ cmd: "execute_shell", command });
    if (!result.ok) throw new Error(result.error ?? "Shell execution failed");
    return result.result ?? "";
  }

  async writeFile(path: string, content: string): Promise<string> {
    const result = await this.send({ cmd: "write_file", path, content });
    if (!result.ok) throw new Error(result.error ?? "Write file failed");
    return result.result ?? "";
  }

  private async send(
    msg: Record<string, unknown>,
    timeout = PIPE_TIMEOUT,
  ): Promise<PipeMessage> {
    // Mutex — one command at a time
    const prev = this.mutex;
    let release: () => void;
    this.mutex = new Promise((r) => { release = r; });

    await prev;

    try {
      return await this.sendRaw(msg, timeout);
    } finally {
      release!();
    }
  }

  private sendRaw(
    msg: Record<string, unknown>,
    timeout: number,
  ): Promise<PipeMessage> {
    return new Promise((resolve, reject) => {
      const id = randomUUID().slice(0, 8);
      const payload = JSON.stringify({ ...msg, id }) + "\n";

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pipe timeout after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      if (!this.process?.stdin?.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Body agent pipe not writable"));
        return;
      }

      this.process.stdin.write(payload);
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg: PipeMessage = JSON.parse(line);
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          pending.resolve(msg);
        }
      } catch {
        // Ignore unparseable lines
      }
    }
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Body agent did not send ready signal"));
      }, READY_TIMEOUT);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes('"ready"')) {
          clearTimeout(timer);
          this.process?.stdout?.off("data", onData);
          resolve();
        }
      };

      this.process?.stdout?.on("data", onData);
    });
  }
}
