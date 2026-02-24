import type { Task } from "../types/index.js";
import type { Executor } from "../executor/index.js";

export interface VerifyResult {
  passed: boolean;
  output: string;
}

export class TaskVerifier {
  async verify(_task: Task, executor: Executor): Promise<VerifyResult> {
    try {
      const output = await executor.executeShell("bash /workspace/tools/check 2>&1");
      return { passed: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { passed: false, output: msg };
    }
  }
}
