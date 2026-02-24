import type { Task } from "../types/index.js";
import type { Executor } from "../executor/index.js";

export interface VerifyResult {
  passed: boolean;
  output: string;
}

export class TaskVerifier {
  async verify(_task: Task, executor: Executor, verifyScript: string): Promise<VerifyResult> {
    try {
      const b64 = Buffer.from(verifyScript).toString("base64");
      const output = await executor.executeShell(`echo '${b64}' | base64 -d | bash 2>&1`);
      return { passed: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { passed: false, output: msg };
    }
  }
}
