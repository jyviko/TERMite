import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load .env file into process.env. No dependencies.
 * Only sets variables that aren't already set (CLI/shell takes precedence).
 */
export function loadEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return; // No .env file — fine
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
