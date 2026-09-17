import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse } from "dotenv";

export function resolveTypeSafeApiKey(
  env: NodeJS.ProcessEnv = process.env,
  envPath = join(homedir(), ".codex", ".env"),
): string | undefined {
  const direct = env.TYPESAFE_API_KEY?.trim();
  if (direct) return direct;
  if (!existsSync(envPath)) return undefined;

  try {
    const value = parse(readFileSync(envPath)).TYPESAFE_API_KEY?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
