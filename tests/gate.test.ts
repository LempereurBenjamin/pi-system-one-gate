import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { ContextGate } from "../src/gate/context-gate.ts";
import { parseConfig } from "../src/config.ts";
import { CloudflareClefProvider } from "../src/providers/cloudflare-clef-provider.ts";
import type { DecisionProvider } from "../src/providers/decision-provider.ts";
import type { GateMetric } from "../src/observability/metrics.ts";
import { createRedactor } from "../src/gate/privacy.ts";

const noise = ("ordinary progress with no useful information\n").repeat(20);
const text = "FIRST useful facts\n" + noise + "error TS2322: preserve diagnostic\n" + noise + "LAST acceptance facts\n";
function event(output = text): ToolResultEvent {
  return { type: "tool_result", toolName: "bash", toolCallId: "../../untrusted", input: { command: "npm test" },
    content: [{ type: "text", text: output }], details: { exitCode: 0 }, isError: false };
}
const config = (mode: "shadow" | "active" = "shadow", archive = false) => parseConfig({ enabled: true, mode, minOutputChars: 100, chunkTargetChars: 256, archive: { enabled: archive } });
const provider: DecisionProvider = {
  async decide(state, questions) {
    const chunks = (state as { chunks: Record<string, string> }).chunks;
    return { model: "test-model", probabilities: Object.fromEntries(Object.keys(questions).map(id => [id, chunks[id]?.includes("FIRST") || chunks[id]?.includes("LAST") ? 0.9 : 0])) };
  },
};

test("shadow classifies and records would-remove metrics but returns no Pi replacement", async () => {
  const original = event(); const before = structuredClone(original); const metrics: GateMetric[] = [];
  let calls = 0;
  const gate = new ContextGate(config(), { async decide(s, q, signal) { calls++; return provider.decide(s, q, signal); } }, createRedactor({}), m => metrics.push(m));
  assert.equal(await gate.handle(original, "Fix compilation"), undefined);
  assert.deepEqual(original, before);
  assert.ok(calls > 0);
  assert.equal(metrics[0]?.outcome, "shadow");
  assert.ok((metrics[0]?.wouldRemoveChars ?? 0) > 0);
  assert.equal(metrics[0]?.deliveredChars, text.length);
  assert.equal(metrics[0]?.providerFailureCount, 0);
  assert.ok(!JSON.stringify(metrics).includes("ordinary progress"));
});

test("active keeps ordered original evidence, forces error retention and archives full original", async () => {
  let archived = ""; const metrics: GateMetric[] = [];
  const gate = new ContextGate(config("active", true), provider, createRedactor({}), m => metrics.push(m), { async save(t) { archived = t; return "/local/cache/recovery.txt"; } });
  const original = event(); const before = structuredClone(original);
  const result = await gate.handle(original, "Fix compilation");
  const filtered = result?.content?.[0]; assert.ok(filtered?.type === "text");
  assert.ok(filtered.text.startsWith("[pi-system-one-gate] Context filtering active."));
  assert.ok(filtered.text.includes("Full local output: /local/cache/recovery.txt"));
  assert.ok(filtered.text.includes("error TS2322"));
  assert.ok(filtered.text.indexOf("FIRST useful") < filtered.text.indexOf("LAST acceptance"));
  assert.ok(filtered.text.includes("[omitted"));
  assert.ok(filtered.text.length < text.length);
  assert.equal(archived, text);
  assert.deepEqual(original, before);
  assert.deepEqual(Object.keys(result!), ["content"]);
  assert.equal(metrics[0]?.outcome, "filtered");
  assert.equal(metrics[0]?.deliveredChars, filtered.text.length);
});

test("small, unsupported, protected, error, structured and sensitive results never call the provider", async () => {
  let calls = 0;
  const gate = new ContextGate(config("active"), { async decide() { calls++; throw new Error("should not call"); } }, createRedactor({ TOKEN: "configured-secret" }), () => {});
  const cases: ToolResultEvent[] = [event("small"), ...["read", "edit", "write", "ls"].map(toolName => ({ ...event(), toolName })),
    { ...event(), isError: true }, { ...event(), parentToolCallId: "codemode-parent" }, { ...event(), structuredContent: { full: text } },
    { ...event(), content: [{ type: "image", mimeType: "image/png", data: "base64" }, { type: "text", text }] },
    { ...event(), input: { command: "cat .env" } }, { ...event(), input: { command: "env" } }, event(text + "configured-secret"), event(text + "Bearer never-send-token"),
    event(("界".repeat(100) + "\n").repeat(130))];
  for (const original of cases) {
    const before = structuredClone(original);
    assert.equal(await gate.handle(original, "Fix compilation"), undefined); assert.deepEqual(original, before);
  }
  assert.equal(await gate.handle(event(), ""), undefined);
  assert.equal(calls, 0);
});

test("disabled gate cannot transmit and active configuration cannot authorize read filtering", async () => {
  const never: DecisionProvider = { async decide() { assert.fail("network boundary violated"); } };
  assert.equal(await new ContextGate(parseConfig({}), never, createRedactor({}), () => {}).handle(event(), "task"), undefined);
  const c = parseConfig({ enabled: true, mode: "active", eligibleTools: ["read"], minOutputChars: 1 });
  assert.equal(await new ContextGate(c, never, createRedactor({}), () => {}).handle({ ...event(), toolName: "read" }, "task"), undefined);
});

test("task and invocation are bounded and redacted before provider transmission", async () => {
  const gate = new ContextGate(config(), { async decide(state, q) {
    const s = state as { objective: string; invocation: string };
    assert.ok(!JSON.stringify(s).includes("top-secret"));
    assert.ok(s.objective.length <= 4000); assert.ok(s.invocation.length <= 2000);
    return { model: "synthetic", probabilities: Object.fromEntries(Object.keys(q).map(id => [id, 1])) };
  } }, createRedactor({ TOKEN: "top-secret" }), () => {});
  await gate.handle({ ...event(), input: { command: "echo top-secret " + "x".repeat(5000) } }, "top-secret " + "task ".repeat(10_000));
});

test("real provider seam failures fail open without mutating any original content", async () => {
  const fetchers: (typeof fetch)[] = [
    async () => new Response("secret", { status: 401 }), async () => new Response("secret", { status: 500 }),
    async () => new Response("not JSON"), async () => Response.json({ success: true, result: { model: "clef", answers: {} } }),
    async () => { throw new Error("client exception secret"); }, async () => new Promise(() => {}),
  ];
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const fetcher of fetchers) {
      const metrics: GateMetric[] = [];
      const p = new CloudflareClefProvider({ accountId: "a".repeat(32), token: "test-only", model: "clef-flash", timeoutMs: 20 }, fetcher);
      const original = event(); const before = structuredClone(original);
      assert.equal(await new ContextGate(config("active"), p, createRedactor({}), m => metrics.push(m)).handle(original, "task"), undefined);
      assert.deepEqual(original, before);
      assert.equal(metrics[0]?.outcome, "fail-open"); assert.equal(metrics[0]?.providerFailureCount, 1);
      assert.equal(metrics[0]?.wouldRemoveChars, 0);
      assert.ok(!JSON.stringify(metrics).includes("secret"));
    }
  } finally { clearInterval(keepAlive); }
});

test("injected exception, missing probability, chunking and archive failure preserve original", async () => {
  const broken: DecisionProvider[] = [{ async decide() { throw new Error("arbitrary private exception"); } }, { async decide() { return { model: "x", probabilities: {} }; } }];
  for (const p of broken) assert.equal(await new ContextGate(config("active"), p, createRedactor({}), () => {}).handle(event(), "task"), undefined);
  const gate = new ContextGate(config("active", true), provider, createRedactor({}), () => {}, { async save() { throw new Error("disk full"); } });
  assert.equal(await gate.handle(event(), "task"), undefined);
  assert.equal(await gate.handle(event("x".repeat(12001)), "task"), undefined);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await gate.handle(event(), "task", aborted.signal), undefined);
});

test("large output batches safely; later batch failure rolls back the entire transformation", async () => {
  const large = ("large harmless diagnostic line\n").repeat(2000);
  let calls = 0; const metrics: GateMetric[] = [];
  const gate = new ContextGate(config("active"), { async decide(s, q) {
    calls++;
    assert.ok(Object.keys(q).length <= 64);
    const chunks = (s as { chunks: Record<string, string> }).chunks;
    assert.ok(Object.values(chunks).join("").length <= 16000);
    if (calls === 2) throw new Error("later batch failure");
    return { model: "synthetic", probabilities: Object.fromEntries(Object.keys(q).map(id => [id, 0])) };
  } }, createRedactor({}), m => metrics.push(m));
  const original = event(large);
  assert.equal(await gate.handle(original, "task"), undefined);
  assert.equal(calls, 2); assert.equal(original.content[0]?.type === "text" && original.content[0].text, large);
  assert.equal(metrics[0]?.wouldRemoveChars, 0);
});

test("all retained and insignificant savings return original; metrics failure cannot destroy evidence", async () => {
  const all: DecisionProvider = { async decide(_s, q) { return { model: "test", probabilities: Object.fromEntries(Object.keys(q).map(id => [id, 1])) }; } };
  assert.equal(await new ContextGate(config("active"), all, createRedactor({}), () => {}).handle(event(), "task"), undefined);
  const little: DecisionProvider = { async decide(_s, q) {
    return { model: "test", probabilities: Object.fromEntries(Object.keys(q).map((id, i) => [id, i === 1 ? 0 : 1])) };
  } };
  assert.equal(await new ContextGate(config("active"), little, createRedactor({}), () => {}).handle(event(), "task"), undefined);
  assert.equal(await new ContextGate(config("active"), provider, createRedactor({}), () => { throw new Error("session write failure"); }).handle(event(), "task") === undefined, false);
});

test("threshold equality retains; low probability removes; local failures are not provider failures", async () => {
  const metrics: GateMetric[] = [];
  const line = (marker: string) => marker.padEnd(255, " ") + "\n";
  const sample = line("FIRST framing") + line("EQUALITY information") + line("BELOW information") + line("ordinary noise").repeat(10) + line("LAST status");
  const p: DecisionProvider = { async decide(s, q) {
    const chunks = (s as { chunks: Record<string, string> }).chunks;
    return { model: "test", probabilities: Object.fromEntries(Object.keys(q).map(id => [id, chunks[id]?.includes("EQUALITY") ? 0.10 : 0.09])) };
  } };
  const gate = new ContextGate(config("active"), p, createRedactor({}), m => metrics.push(m));
  const result = await gate.handle(event(sample), "task");
  assert.ok(result?.content?.[0]?.type === "text" && result.content[0].text.includes("EQUALITY information"));
  assert.ok(!result.content[0].text.includes("BELOW information"));
  assert.ok((metrics[0]?.wouldRemoveChars ?? 0) > 0);
  const failingArchive = new ContextGate(config("active", true), p, createRedactor({}), m => metrics.push(m), { async save() { throw new Error("disk full"); } });
  assert.equal(await failingArchive.handle(event(sample), "task"), undefined);
  assert.equal(metrics[1]?.providerFailureCount, 0);
});

test("the model cannot delete all evidence: first and last framing chunks always survive", async () => {
  const p: DecisionProvider = { async decide(_s, q) {
    return { model: "test", probabilities: Object.fromEntries(Object.keys(q).map(id => [id, 0])) };
  } };
  const text = "BEGIN useful framing\n" + noise.repeat(4) + "END final status\n";
  const result = await new ContextGate(config("active"), p, createRedactor({}), () => {}).handle(event(text), "task");
  assert.ok(result?.content?.[0]?.type === "text");
  assert.ok(result.content[0].text.includes("BEGIN useful framing"));
  assert.ok(result.content[0].text.includes("END final status"));
  assert.ok(result.content[0].text.length < text.length);
});
