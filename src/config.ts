import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface GateConfig {
  enabled: boolean;
  mode: "shadow" | "active";
  provider: "clef" | "jev";
  model: string;
  minOutputChars: number;
  chunkTargetChars: number;
  keepThreshold: number;
  timeoutMs: number;
  eligibleTools: string[];
  archive: { enabled: boolean };
}

export const defaults: GateConfig = {
  enabled: false, mode: "shadow", provider: "clef", model: "clef-flash",
  minOutputChars: 12_000, chunkTargetChars: 6_000, keepThreshold: 0.10,
  timeoutMs: 8_000, eligibleTools: ["bash", "grep", "find"], archive: { enabled: true },
};

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown, env: NodeJS.ProcessEnv = {}): GateConfig {
  if (!object(value)) throw new Error("config-object");
  const keys = Object.keys(defaults);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("config-key");
  const v: Record<string, unknown> = { ...defaults, ...value };
  // Environment overrides cannot opt a project in or activate filtering.
  if (env.PI_SYSTEM_ONE_GATE_DISABLED === "1") v.enabled = false;
  if (env.PI_SYSTEM_ONE_GATE_PROVIDER) v.provider = env.PI_SYSTEM_ONE_GATE_PROVIDER;
  v.model = env.PI_SYSTEM_ONE_GATE_MODEL ?? value.model ?? (v.provider === "jev" ? "jev-latest" : "clef-flash");
  if (typeof v.enabled !== "boolean" || !["shadow", "active"].includes(String(v.mode))) throw new Error("config-mode");
  if (!["clef", "jev"].includes(String(v.provider))) throw new Error("config-provider");
  if (typeof v.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(v.model)) throw new Error("config-model");
  if (v.provider === "clef" && !["clef-flash", "clef"].includes(v.model)) throw new Error("config-clef-model");
  for (const [key, min, max] of [["minOutputChars", 1, 1_000_000], ["chunkTargetChars", 256, 12_000], ["timeoutMs", 100, 30_000]] as const) {
    if (!Number.isInteger(v[key]) || (v[key] as number) < min || (v[key] as number) > max) throw new Error(`config-${key}`);
  }
  if (typeof v.keepThreshold !== "number" || !Number.isFinite(v.keepThreshold) || v.keepThreshold < 0 || v.keepThreshold > 1) throw new Error("config-threshold");
  if (!Array.isArray(v.eligibleTools) || !v.eligibleTools.every(t => typeof t === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(t))) throw new Error("config-tools");
  if (!object(v.archive) || Object.keys(v.archive).some(k => k !== "enabled") || typeof v.archive.enabled !== "boolean") throw new Error("config-archive");
  return v as unknown as GateConfig;
}

export async function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<GateConfig> {
  try {
    const raw = await readFile(join(cwd, ".pi", "system-one-gate.json"), "utf8");
    if (raw.length > 16_384) throw new Error("config-size");
    return parseConfig(JSON.parse(raw), env);
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return parseConfig({});
    // Never include user-supplied JSON (which may contain credentials) in diagnostics.
    throw new Error("invalid-project-config");
  }
}
