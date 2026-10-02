import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudflareClefProvider } from "../src/providers/cloudflare-clef-provider.ts";
import { TypeSafeJevProvider } from "../src/providers/typesafe-jev-provider.ts";
import { DecisionError } from "../src/providers/decision-provider.ts";
import type { DecisionQuestions } from "../src/providers/decision-provider.ts";

const questions: DecisionQuestions = { keep: { type: "noul", instructions: "Is this relevant?" } };
const answer = { model: "clef-flash", answers: { keep: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 30, output_tokens: 0 } };
const options = { accountId: "a".repeat(32), token: "test-only", model: "clef-flash" as const, timeoutMs: 1000 };

test("Clef maps endpoint, authorization, model/state/questions and REST envelope", async () => {
  for (const model of ["clef-flash", "clef"] as const) {
    const fetcher: typeof fetch = async (url, init) => {
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/@cf/cloudflare/${model}`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(init?.headers, { Authorization: "Bearer test-only", "Content-Type": "application/json" });
      assert.deepEqual(JSON.parse(String(init?.body)), { model, state: { task: "synthetic" }, questions });
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ success: true, errors: [], messages: [], result: { ...answer, model } });
    };
    assert.deepEqual(await new CloudflareClefProvider({ ...options, model }, fetcher).decide({ task: "synthetic" }, questions), { model, probabilities: { keep: 0.2 } });
  }
});

test("Jev maps System One directly, uses the documented noul shape and does no discovery", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "jev-latest", state: "synthetic", questions });
    return Response.json({ ...answer, model: "jev-1.13.0" });
  };
  const provider = new TypeSafeJevProvider({ apiKey: "test-only", model: "jev-latest", timeoutMs: 1000 }, fetcher);
  assert.deepEqual(await provider.decide("synthetic", questions), { model: "jev-1.13.0", probabilities: { keep: 0.2 } });
  assert.equal(calls, 1);
});

test("HTTP errors and malformed schemas are typed; raw server content never enters errors", async () => {
  const responses = [new Response("secret failure", { status: 401 }), new Response("secret failure", { status: 500 }),
    new Response("invalid JSON secret"), Response.json({ success: false }),
    Response.json({ success: true, result: { ...answer, answers: {} } }),
    Response.json({ success: true, result: { ...answer, answers: { keep: { type: "noul", noul: 2 } } } }),
    Response.json({ success: true, result: { ...answer, answers: { keep: 0.2 } } })];
  for (const response of responses) {
    await assert.rejects(new CloudflareClefProvider(options, async () => response).decide("test", questions), (error: unknown) => {
      assert.ok(error instanceof DecisionError); assert.ok(!error.message.includes("secret")); return true;
    });
  }
  await assert.rejects(new TypeSafeJevProvider({ apiKey: "x", model: "jev-latest", timeoutMs: 1000 }, async () => Response.json({ ...answer, answers: { keep: { type: "choice", noul: 0.2 } } })).decide("test", questions), /schema/);
});

test("no credentials, timeout, caller abort and thrown fetch all reject without retries", async () => {
  let calls = 0;
  const stuck: typeof fetch = async () => { calls++; return new Promise(() => {}); };
  await assert.rejects(new CloudflareClefProvider({ ...options, token: "" }, stuck).decide("test", questions), /credentials/);
  assert.equal(calls, 0);
  // Keep the event loop alive while AbortSignal.timeout's unref timer expires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(new CloudflareClefProvider({ ...options, timeoutMs: 20 }, stuck).decide("test", questions), /timeout/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new CloudflareClefProvider(options, stuck).decide("test", questions, controller.signal), /aborted/);
    await assert.rejects(new CloudflareClefProvider(options, async () => { throw new Error("token=secret"); }).decide("test", questions), /network/);
    assert.equal(calls, 1);
  } finally { clearInterval(keepAlive); }
});
