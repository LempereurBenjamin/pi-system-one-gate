import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { LocalArchive } from "../src/gate/archive.ts";
import extension from "../src/extension.ts";

test("archive is local, exact, private, generated independently of call IDs and bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gate-archive-"));
  try {
    const archive = new LocalArchive(join(dir, "cache"));
    const path = await archive.save("original exact output\n");
    assert.equal(await readFile(path, "utf8"), "original exact output\n");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    assert.match(path, /run-[^/]+\/[a-f0-9-]+\.txt$/);
    for (let i = 1; i < 100; i++) await archive.save("x");
    await assert.rejects(archive.save("budget exceeded"), /archive-limit/);
    await assert.rejects(new LocalArchive(join(dir, "in-project"), dir).save("x"), /archive-in-project/);
    await mkdir(join(dir, "target")); await symlink(join(dir, "target"), join(dir, "link"));
    await assert.rejects(new LocalArchive(join(dir, "link")).save("x"), /unsafe-archive-root/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("public Pi hooks load, stay disabled without config, and contain invalid config errors", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: unknown[] = [];
  extension({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), appendEntry: (_name: string, data: unknown) => entries.push(data) } as unknown as ExtensionAPI);
  assert.deepEqual([...handlers.keys()], ["session_start", "before_agent_start", "tool_result"]);
  const dir = await mkdtemp(join(tmpdir(), "gate-extension-"));
  const ctx = { cwd: dir, signal: undefined } as ExtensionContext;
  const original: ToolResultEvent = { type: "tool_result", toolName: "bash", toolCallId: "x", input: { command: "npm test" }, content: [{ type: "text", text: "log\n".repeat(4000) }], details: undefined, isError: false };
  try {
    handlers.get("before_agent_start")!({ prompt: "self-contained worker task" }, ctx);
    assert.equal(await handlers.get("tool_result")!(original, ctx), undefined);
    assert.equal(entries.length, 0);
    await mkdir(join(dir, ".pi")); await writeFile(join(dir, ".pi/system-one-gate.json"), '{"enabled":"invalid"}');
    assert.equal(await handlers.get("tool_result")!(original, ctx), undefined);
    assert.deepEqual(entries, [{ outcome: "fail-open", diagnostic: "configuration-or-extension" }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Pi lifecycle uses latest bounded task, honors config changes, and returns content only in active", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const metrics: { outcome: string }[] = [];
  extension({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), appendEntry: (_name: string, data: { outcome: string }) => metrics.push(data) } as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "gate-lifecycle-"));
  const savedFetch = globalThis.fetch;
  const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const savedToken = process.env.CLOUDFLARE_AUTH_TOKEN;
  let calls = 0;
  const states: { objective: string }[] = [];
  try {
    process.env.CLOUDFLARE_ACCOUNT_ID = "a".repeat(32); process.env.CLOUDFLARE_AUTH_TOKEN = "test-only-provider-credential";
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { state: { objective: string }; questions: Record<string, unknown> };
      states.push(body.state);
      return Response.json({ success: true, result: { model: "clef-flash", answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0 }])) } });
    };
    const ctx = { cwd: dir, signal: undefined } as ExtensionContext;
    const original: ToolResultEvent = { type: "tool_result", toolName: "bash", toolCallId: "x", input: { command: "npm test" },
      content: [{ type: "text", text: "ordinary harmless progress\n".repeat(500) }], details: undefined, isError: false };
    handlers.get("before_agent_start")!({ prompt: "initial objective" }, ctx);
    handlers.get("before_agent_start")!({ prompt: "Latest objective " + "details ".repeat(1000) }, ctx);
    await mkdir(join(dir, ".pi"));
    const path = join(dir, ".pi/system-one-gate.json");
    await writeFile(path, '{"enabled":true}');
    assert.equal(await handlers.get("tool_result")!(original, ctx), undefined);
    assert.equal(metrics[0]?.outcome, "shadow", JSON.stringify(metrics));
    assert.equal(states[0]?.objective.length, 4000);
    assert.ok(states[0]?.objective.includes("objective details"));
    assert.ok(states.every(s => s.objective.length <= 4000 && !JSON.stringify(s).includes("initial objective") && !JSON.stringify(s).includes("test-only-provider-credential")));
    await writeFile(path, '{"enabled":true,"mode":"active","archive":{"enabled":false}}');
    const result = await handlers.get("tool_result")!(original, ctx);
    assert.ok(result.content[0].text.startsWith("[pi-system-one-gate]"));
    assert.equal(metrics[1]?.outcome, "filtered");
    const classifiedCalls = calls;
    await writeFile(path, '{"enabled":false}');
    assert.equal(await handlers.get("tool_result")!(original, ctx), undefined);
    assert.equal(calls, classifiedCalls);
    await writeFile(path, '{"enabled":true}');
    handlers.get("session_start")!();
    assert.equal(await handlers.get("tool_result")!(original, ctx), undefined);
    assert.equal(calls, classifiedCalls);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
    if (savedToken === undefined) delete process.env.CLOUDFLARE_AUTH_TOKEN; else process.env.CLOUDFLARE_AUTH_TOKEN = savedToken;
    await rm(dir, { recursive: true, force: true });
  }
});
