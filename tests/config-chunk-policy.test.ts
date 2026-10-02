import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, loadConfig, parseConfig } from "../src/config.ts";
import { batchChunks, chunkOutput, MAX_BATCH_CHARS } from "../src/gate/chunker.ts";
import { mustKeep } from "../src/gate/policy.ts";
import { createRedactor, sensitiveInvocation } from "../src/gate/privacy.ts";

test("project opt-in is required; enabling defaults to shadow; active is explicit", async () => {
  assert.equal(parseConfig({}).enabled, false);
  assert.equal(parseConfig({ enabled: true }).mode, "shadow");
  assert.equal(parseConfig({ enabled: true, mode: "active" }).mode, "active");
  assert.equal(parseConfig({}, { PI_SYSTEM_ONE_GATE_ENABLED: "1", PI_SYSTEM_ONE_GATE_MODE: "active" }).enabled, false);
  assert.equal(parseConfig({ enabled: true }, { PI_SYSTEM_ONE_GATE_DISABLED: "1" }).enabled, false);
  const dir = await mkdtemp(join(tmpdir(), "gate-config-"));
  try {
    assert.deepEqual(await loadConfig(dir), defaults);
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi/system-one-gate.json"), "invalid token=private");
    await assert.rejects(loadConfig(dir), /^Error: invalid-project-config$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider defaults and overrides remain explicit and validated", () => {
  assert.equal(parseConfig({ provider: "jev" }).model, "jev-latest");
  assert.equal(parseConfig({ model: "clef" }).model, "clef");
  assert.equal(parseConfig({}, { PI_SYSTEM_ONE_GATE_PROVIDER: "jev" }).provider, "jev");
  for (const bad of [null, [], { enabled: "yes" }, { mode: "enabled" }, { provider: "unknown" }, { model: "../../token" },
    { model: "jev-latest" }, { keepThreshold: NaN }, { keepThreshold: 1.1 }, { chunkTargetChars: 0 },
    { minOutputChars: -1 }, { timeoutMs: 31_000 }, { eligibleTools: [1] }, { archive: {} }, { token: "secret" }]) {
    assert.throws(() => parseConfig(bad));
  }
});

test("chunking preserves all bytes and line boundaries, preferring sections", () => {
  const text = ("a".repeat(90) + "\r\n").repeat(8) + "\r\n" + "diff --git a/x b/x\n" + ("b".repeat(90) + "\n").repeat(8);
  const chunks = chunkOutput(text, 600);
  assert.equal(chunks.map(c => c.text).join(""), text);
  assert.ok(chunks.slice(0, -1).every(c => c.text.endsWith("\n")));
  assert.ok(chunks.some(c => c.text.startsWith("diff --git")));
  assert.throws(() => chunkOutput("x".repeat(12_001), 6000), /line-limit/);
  assert.throws(() => chunkOutput("x".repeat(1_000_000), 6000), /line-limit/);
});

test("large output uses bounded batches with at most 64 questions and 16k chunk chars", () => {
  const text = ("record: noise\n").repeat(40_000);
  const chunks = chunkOutput(text, 256);
  assert.ok(chunks.length > 64);
  const batches = batchChunks(chunks);
  assert.ok(batches.length > 1);
  assert.ok(batches.every(b => b.length <= 64 && b.reduce((n, c) => n + c.text.length, 0) <= MAX_BATCH_CHARS));
  assert.equal(batches.flat().map(c => c.text).join(""), text);
});

test("must-keep forces retention for failures, stacks, conflicts and security warnings", () => {
  for (const text of ["error TS2322: type mismatch", "FAIL test signup", "3 tests failed", "AssertionError: expected true", "Traceback (most recent call last)",
    "Unhandled TypeError: undefined", "    at main (/src/x.ts:12:4)", "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch",
    "CONFLICT (content): Merge conflict in x.ts", "WARN CVE-2026-12345", "SECURITY WARNING: unsafe dependency", "warning: critical vulnerability", "Migration aborted", "compiler error"]) assert.equal(mustKeep(text), true, text);
  assert.equal(mustKeep("download progress 72%\nordinary diagnostic noise"), false);
});

test("redaction removes common secrets, private keys and environment values from state", () => {
  const redact = createRedactor({ CLOUDFLARE_AUTH_TOKEN: "configured-secret", OTHER_ENV: "environment-value", SHORT: "1" });
  const original = 'Bearer bearer-secret\nAPI_KEY="api-secret"\n{"password": "password-secret"}\nconfigured-secret environment-value\n'
    + "-----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----\nflag=1\n";
  const safe = redact(original);
  for (const secret of ["bearer-secret", "api-secret", "password-secret", "configured-secret", "environment-value", "private material"]) assert.ok(!safe.includes(secret));
  assert.ok(safe.includes("REDACTED"));
  assert.ok(!safe.includes("flag=1"));
  assert.equal(redact("untouched source"), "untouched source");
  assert.equal(createRedactor({})("x".repeat(1_000_000)).length, 1_000_000);
  for (const invocation of ["cat .env", "cat .env.production", "cat ~/.aws/credentials", "cat ~/.ssh/id_ed25519", "cat ~/.pi/agent/auth.json", "printenv", "env", "cat .npmrc"])
    assert.equal(sensitiveInvocation(invocation), true, invocation);
  assert.equal(sensitiveInvocation("npm test"), false);
});
