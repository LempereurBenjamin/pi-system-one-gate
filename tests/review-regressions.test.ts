import { test } from "node:test";
import assert from "node:assert/strict";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/config.ts";
import { ContextGate } from "../src/gate/context-gate.ts";
import { createRedactor } from "../src/gate/privacy.ts";
import type { GateMetric } from "../src/observability/metrics.ts";
import type { DecisionProvider } from "../src/providers/decision-provider.ts";

const output = "BEGIN task evidence\n" + "ordinary harmless progress\n".repeat(900) + "END final status\n";
const originalEvent = (input: Record<string, unknown>): ToolResultEvent => ({
  type: "tool_result", toolName: "bash", toolCallId: "synthetic-call", input,
  content: [{ type: "text", text: output }], details: undefined, isError: false,
});

test("Pi's actual successful bash result is classified and filtered while structured output survives", async () => {
  const input = { command: "synthetic command" };
  const bash = createBashTool(process.cwd(), {
    exposeSessionEnvironment: false,
    operations: { async exec(_command, _cwd, { onData }) {
      onData(Buffer.from(output));
      return { exitCode: 0 };
    } },
  });
  const result = await bash.execute("synthetic-call", input);
  const event: ToolResultEvent = { ...originalEvent(input), ...result };
  const before = structuredClone(event);
  assert.ok(event.structuredContent);
  assert.equal((event.structuredContent as { output: string }).output, output);
  let calls = 0;
  const provider: DecisionProvider = { async decide(_state, questions) {
    calls++;
    return { model: "synthetic", probabilities: Object.fromEntries(Object.keys(questions).map(id => [id, 0])) };
  } };
  const metrics: GateMetric[] = [];
  const shadow = new ContextGate(parseConfig({ enabled: true }), provider, createRedactor({}), metric => metrics.push(metric));
  assert.equal(await shadow.handle(event, "Inspect task evidence"), undefined);
  assert.ok(calls > 0, "the default bash workflow must call the decision provider");
  assert.equal(metrics[0]?.outcome, "shadow");
  assert.ok((metrics[0]?.wouldRemoveChars ?? 0) > 0);
  assert.deepEqual(event, before);

  let archived = "";
  const active = new ContextGate(parseConfig({ enabled: true, mode: "active" }), provider, createRedactor({}), metric => metrics.push(metric), {
    async save(text) { archived = text; return "/local/cache/full-output.txt"; },
  });
  const replacement = await active.handle(event, "Inspect task evidence");
  assert.ok(replacement?.content?.[0]?.type === "text");
  assert.ok(replacement.content[0].text.length < output.length);
  assert.equal(replacement.structuredContent, event.structuredContent);
  assert.equal(archived, output);
  assert.deepEqual(event, before);

  const callsBeforeBypass = calls;
  assert.equal(await active.handle({ ...event, parentToolCallId: "codemode" }, "task"), undefined);
  assert.equal(await active.handle({ ...event, isError: true }, "task"), undefined);
  assert.equal(calls, callsBeforeBypass);
  const broken = new ContextGate(parseConfig({ enabled: true, mode: "active" }), {
    async decide() { throw new Error("synthetic provider failure"); },
  }, createRedactor({}), () => {});
  assert.equal(await broken.handle(event, "task"), undefined);
  assert.deepEqual(event, before);
});

test("escaped environment credentials are redacted from nested input before serialization", async () => {
  for (const credential of ['quoted"credential', "backslash\\credential", "multiline\ncredential", 'combined"\\\ncredential']) {
    const event = originalEvent({ command: `echo ${credential}`, metadata: { values: [credential, { argument: credential }], API_KEY: 'unknown"\\key' } });
    const before = structuredClone(event);
    const invocations: string[] = [];
    const gate = new ContextGate(parseConfig({ enabled: true }), { async decide(state, questions) {
      invocations.push((state as { invocation: string }).invocation);
      return { model: "synthetic", probabilities: Object.fromEntries(Object.keys(questions).map(id => [id, 1])) };
    } }, createRedactor({ CONFIGURED_CREDENTIAL: credential }), () => {});
    assert.equal(await gate.handle(event, "Inspect task evidence"), undefined);
    assert.ok(invocations.length > 0, "harmless output should still be classified");
    for (const invocation of invocations) {
      const decoded = JSON.parse(invocation) as typeof event.input;
      assert.ok(!String(decoded.command).includes(credential), "decoding the transmitted invocation must not recover the credential");
      assert.ok(invocation.includes("REDACTED"));
      assert.deepEqual(decoded.metadata, { values: ["[REDACTED ENV]", { argument: "[REDACTED ENV]" }], API_KEY: "[REDACTED]" });
    }
    assert.deepEqual(event, before);
  }
});

test("Pi's non-zero bash exits are classified and filtered without losing failure evidence or process metadata", async () => {
  for (const exitCode of [1, 2, 127, 137, 255]) {
    const input = { command: "synthetic command" };
    const stdout = "BEGIN task evidence\n" + "ordinary harmless progress\n".repeat(400)
      + "FAIL acceptance check\nerror: expected updated state\n" + "ordinary harmless progress\n".repeat(500);
    const bash = createBashTool(process.cwd(), {
      exposeSessionEnvironment: false,
      operations: { async exec(_command, _cwd, { onData }) {
        onData(Buffer.from(stdout));
        return { exitCode };
      } },
    });
    const event: ToolResultEvent = { ...originalEvent(input), ...await bash.execute("synthetic-call", input) };
    const before = structuredClone(event);
    assert.equal(event.isError, true);
    const structured = event.structuredContent as { output: string; exit_code: number; truncated: boolean; wall_time_seconds: number };
    assert.equal(structured.exit_code, exitCode);
    assert.equal(structured.output, stdout);
    assert.equal(structured.truncated, false);
    assert.ok(structured.wall_time_seconds >= 0);
    let calls = 0;
    const provider: DecisionProvider = { async decide(_state, questions) {
      calls++;
      return { model: "synthetic", probabilities: Object.fromEntries(Object.keys(questions).map(id => [id, 0])) };
    } };
    const metrics: GateMetric[] = [];
    const shadow = new ContextGate(parseConfig({ enabled: true }), provider, createRedactor({}), metric => metrics.push(metric));
    assert.equal(await shadow.handle(event, "Diagnose the acceptance failure"), undefined);
    assert.ok(calls > 0, `exit ${exitCode} must be classified`);
    assert.equal(metrics[0]?.outcome, "shadow");
    assert.ok((metrics[0]?.wouldRemoveChars ?? 0) > 0);
    assert.deepEqual(event, before);

    let archived = "";
    const active = new ContextGate(parseConfig({ enabled: true, mode: "active" }), provider, createRedactor({}), metric => metrics.push(metric), {
      async save(text) { archived = text; return "/local/cache/full-output.txt"; },
    });
    const replacement = await active.handle(event, "Diagnose the acceptance failure");
    assert.ok(replacement);
    const filtered = replacement?.content?.[0];
    assert.ok(filtered?.type === "text");
    assert.ok(filtered.text.length < archived.length);
    assert.ok(filtered.text.includes("BEGIN task evidence"));
    assert.ok(filtered.text.includes("FAIL acceptance check\nerror: expected updated state"));
    assert.ok(filtered.text.endsWith(`Command exited with code ${exitCode}`));
    assert.equal(replacement.structuredContent, event.structuredContent);
    // Pi retains fields omitted by the hook; returning structuredContent explicitly preserves it.
    const delivered = { ...event, ...replacement };
    assert.equal(delivered.isError, true);
    assert.equal(delivered.details, event.details);
    assert.equal(delivered.structuredContent, event.structuredContent);
    assert.deepEqual(delivered.structuredContent, before.structuredContent);
    assert.equal(archived, event.content[0]?.type === "text" ? event.content[0].text : "");
    assert.deepEqual(event, before);

    const broken = new ContextGate(parseConfig({ enabled: true, mode: "active" }), {
      async decide() { throw new Error("synthetic provider failure"); },
    }, createRedactor({}), () => {});
    assert.equal(await broken.handle(event, "Diagnose the acceptance failure"), undefined);
    assert.deepEqual(event, before);
  }
});

test("unsupported bash errors and invalid process exit codes still bypass the provider", async () => {
  let calls = 0;
  const gate = new ContextGate(parseConfig({ enabled: true }), {
    async decide() { calls++; throw new Error("must not call"); },
  }, createRedactor({}), () => {});
  const canonical = { output, truncated: false, exit_code: 1, wall_time_seconds: 0 };
  const cases: ToolResultEvent[] = [
    { ...originalEvent({ command: "synthetic command" }), isError: true },
    { ...originalEvent({ command: "synthetic command" }), isError: true, structuredContent: { message: output } },
    ...[null, -1, 0.5, NaN, Infinity].map(exit_code => ({
      ...originalEvent({ command: "synthetic command" }), isError: true, structuredContent: { ...canonical, exit_code },
    })),
  ];
  for (const event of cases) {
    const before = structuredClone(event);
    assert.equal(await gate.handle(event, "task"), undefined);
    assert.deepEqual(event, before);
  }
  assert.equal(calls, 0);
});

test("ordinary environment values do not redact harmless logs or cause a privacy bypass", async () => {
  const env = { SHLVL: "1", CI: "0", USER: "developer", HOME: "/home/developer", PATH: "/usr/bin" };
  const text = output + "1 check; 0 changes; developer /home/developer /usr/bin\n";
  const redact = createRedactor(env);
  assert.equal(redact(text), text);
  let calls = 0;
  const metrics: GateMetric[] = [];
  const event = { ...originalEvent({ command: "synthetic command" }), content: [{ type: "text" as const, text }] };
  const before = structuredClone(event);
  const gate = new ContextGate(parseConfig({ enabled: true }), { async decide(_state, questions) {
    calls++;
    return { model: "synthetic", probabilities: Object.fromEntries(Object.keys(questions).map(id => [id, 0])) };
  } }, redact, metric => metrics.push(metric));
  assert.equal(await gate.handle(event, "Inspect 1 check by developer"), undefined);
  assert.ok(calls > 0);
  assert.equal(metrics[0]?.outcome, "shadow");
  assert.equal(metrics[0]?.diagnostic, undefined);
  assert.deepEqual(event, before);
});

test("configured provider credentials are redacted from state and trigger raw-output bypass", async () => {
  const env = { CLOUDFLARE_AUTH_TOKEN: 'cloudflare"\\credential', TYPESAFE_API_KEY: "typesafe-secret-value" };
  const redact = createRedactor(env);
  for (const credential of Object.values(env)) {
    assert.equal(redact(credential), "[REDACTED ENV]");
    let calls = 0;
    const gate = new ContextGate(parseConfig({ enabled: true }), { async decide(state, questions) {
      calls++;
      const transmitted = state as { objective: string; invocation: string };
      assert.ok(!transmitted.objective.includes(credential));
      assert.ok(!String(JSON.parse(transmitted.invocation).command).includes(credential));
      return { model: "synthetic", probabilities: Object.fromEntries(Object.keys(questions).map(id => [id, 1])) };
    } }, redact, () => {});
    await gate.handle(originalEvent({ command: `echo ${credential}` }), `Inspect evidence ${credential}`);
    assert.ok(calls > 0);
    const before = calls;
    const event = { ...originalEvent({ command: "synthetic command" }), content: [{ type: "text" as const, text: output + credential }] };
    assert.equal(await gate.handle(event, "task"), undefined);
    assert.equal(calls, before);
  }
});

test("unsupported input objects fail open before transmission", async () => {
  let calls = 0;
  const gate = new ContextGate(parseConfig({ enabled: true }), { async decide() { calls++; throw new Error("must not call"); } }, createRedactor({}), () => {});
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const input of [{ command: "synthetic", circular }, { command: "synthetic", metadata: { toJSON() { return "unexpected serialized content"; } } }]) {
    assert.equal(await gate.handle(originalEvent(input), "task"), undefined);
  }
  assert.equal(calls, 0);
});

test("credential-file glob invocations bypass transmission and archival of unknown credentials", async () => {
  for (const command of ["cat .env*", "cat .env.*", 'cat "./.env*"', "cat /project/.env.production*", "cat .env?", "cat .env[.]*", "cat .npmrc*"]) {
    const event = originalEvent({ command });
    event.content = [{ type: "text", text: output + "DATABASE_URL=postgres://owner:unrecognized-password@database/private\n" }];
    const before = structuredClone(event);
    let calls = 0;
    let archives = 0;
    const gate = new ContextGate(parseConfig({ enabled: true, mode: "active" }), { async decide(_state, questions) {
      calls++;
      return { model: "synthetic", probabilities: Object.fromEntries(Object.keys(questions).map(id => [id, 0])) };
    } }, createRedactor({}), () => {}, { async save() { archives++; return "/local/cache/output.txt"; } });
    assert.equal(await gate.handle(event, "Inspect task evidence"), undefined, command);
    assert.equal(calls, 0, command);
    assert.equal(archives, 0, command);
    assert.deepEqual(event, before);
  }
});
