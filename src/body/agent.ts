// Body agent — runs INSIDE an isolated Docker container.
// execSync is intentional: the organism's shell access IS the feature.
// The container is the sandbox boundary.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { createInterface } from "node:readline";

const WORKSPACE = "/workspace";
const MAX_OUTPUT = 4000;
const SHELL_TIMEOUT = 30_000;

interface Command {
  id: string;
  cmd: string;
  command?: string;
  path?: string;
  content?: string;
}

interface Response {
  id: string;
  ok: boolean;
  result?: string;
  error?: string;
}

function respond(res: Response): void {
  process.stdout.write(JSON.stringify(res) + "\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated, ${s.length} total chars)`;
}

function handlePing(cmd: Command): Response {
  return { id: cmd.id, ok: true, result: "pong" };
}

function handleExecuteShell(cmd: Command): Response {
  if (!cmd.command) {
    return { id: cmd.id, ok: false, error: "Missing command" };
  }
  // Intentional: execSync runs inside Docker container sandbox.
  // The organism needs shell access to solve quests.
  try {
    const output = execSync(cmd.command, {
      cwd: WORKSPACE,
      timeout: SHELL_TIMEOUT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { id: cmd.id, ok: true, result: truncate(output, MAX_OUTPUT) };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = (e.stdout ?? "") + (e.stderr ?? "");
    return {
      id: cmd.id,
      ok: false,
      error: truncate(output || e.message || "Shell execution failed", MAX_OUTPUT),
    };
  }
}

function handleWriteFile(cmd: Command): Response {
  if (!cmd.path || cmd.content === undefined) {
    return { id: cmd.id, ok: false, error: "Missing path or content" };
  }

  // Path traversal protection
  const fullPath = resolve(WORKSPACE, cmd.path);
  const rel = relative(WORKSPACE, fullPath);
  if (rel.startsWith("..") || resolve(fullPath) === resolve(WORKSPACE + "/..")) {
    return { id: cmd.id, ok: false, error: "Path traversal rejected" };
  }

  try {
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, cmd.content, "utf-8");
    return { id: cmd.id, ok: true, result: `wrote ${fullPath}` };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { id: cmd.id, ok: false, error: e.message ?? "Write failed" };
  }
}

function handleCommand(cmd: Command): Response | null {
  switch (cmd.cmd) {
    case "ping": return handlePing(cmd);
    case "execute_shell": return handleExecuteShell(cmd);
    case "write_file": return handleWriteFile(cmd);
    case "shutdown": return null;
    default: return { id: cmd.id, ok: false, error: `Unknown command: ${cmd.cmd}` };
  }
}

// Main
process.stdout.write(JSON.stringify({ ready: true }) + "\n");

const rl = createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  if (!line.trim()) return;

  let cmd: Command;
  try {
    cmd = JSON.parse(line);
  } catch {
    respond({ id: "unknown", ok: false, error: "JSON parse error" });
    return;
  }

  if (cmd.cmd === "shutdown") {
    respond({ id: cmd.id, ok: true, result: "shutting down" });
    process.exit(0);
  }

  const result = handleCommand(cmd);
  if (result) respond(result);
});

rl.on("close", () => {
  process.exit(0);
});
