import { describe, it, expect } from "vitest";
import { resolve, relative } from "node:path";

/**
 * Tests for the execute_tool path validation logic used in src/body/agent.ts.
 *
 * The body agent's handleExecuteTool validates that tool commands resolve to
 * files directly inside /workspace/tools/ — no traversal, no subdirectories.
 * We replicate that logic here since the body agent doesn't export its functions.
 */

const TOOLS_DIR = "/workspace/tools";

function validateToolPath(command: string): { ok: true; resolved: string } | { ok: false; error: string } {
  const resolved = resolve(command);
  const rel = relative(TOOLS_DIR, resolved);
  if (rel.startsWith("..") || rel.includes("/")) {
    return { ok: false, error: "Tool path must be directly inside /workspace/tools/" };
  }
  return { ok: true, resolved };
}

describe("execute_tool path validation", () => {
  it("accepts a valid tool path", () => {
    const result = validateToolPath("/workspace/tools/write");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe("/workspace/tools/write");
  });

  it("accepts tool with dashes and underscores", () => {
    const result = validateToolPath("/workspace/tools/my-custom_tool");
    expect(result.ok).toBe(true);
  });

  it("rejects traversal to parent directory", () => {
    const result = validateToolPath("/workspace/tools/../../../etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects absolute path outside tools dir", () => {
    const result = validateToolPath("/etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects subdirectory paths", () => {
    const result = validateToolPath("/workspace/tools/subdir/script");
    expect(result.ok).toBe(false);
  });

  it("rejects /workspace/tools/../tools/../../escape", () => {
    const result = validateToolPath("/workspace/tools/../tools/../../escape");
    expect(result.ok).toBe(false);
  });

  it("rejects /workspace/toolsX (sibling directory trick)", () => {
    const result = validateToolPath("/workspace/toolsX/malicious");
    expect(result.ok).toBe(false);
  });

  it("rejects empty-looking traversal /workspace/tools/./../../bin/sh", () => {
    const result = validateToolPath("/workspace/tools/./../../bin/sh");
    expect(result.ok).toBe(false);
  });
});
