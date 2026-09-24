import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Settings {
  enabled: boolean;
  maxContinuations: number;
  message: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  maxContinuations: 3,
  message:
    "Your previous response hit the output token limit. Continue exactly where you stopped, without repeating previous content. Finish the original request.",
});

export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`Unknown setting: ${key}`);
  }
  const settings = { ...DEFAULT_SETTINGS, ...input };
  if (typeof settings.enabled !== "boolean") throw new Error("enabled must be a boolean.");
  if (!Number.isSafeInteger(settings.maxContinuations) || settings.maxContinuations < 0) {
    throw new Error("maxContinuations must be a non-negative safe integer.");
  }
  if (typeof settings.message !== "string" || !settings.message.trim()) {
    throw new Error("message must be a non-empty string.");
  }
  return settings;
}

export function readSettings(path: string): Settings {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw error;
  }
  return validateSettings(JSON.parse(content));
}

export function updateSettings(path: string, patch: Partial<Settings>): Settings {
  // Re-read so a command preserves unrelated changes made by another Pi process.
  const settings = validateSettings({ ...readSettings(path), ...patch });
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return settings;
}
