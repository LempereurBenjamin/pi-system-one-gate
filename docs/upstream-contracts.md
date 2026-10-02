# Upstream contracts checked on 2026-10-02

The implementation uses the current official source/docs below, not third-party examples. Local typing and package loading use published `@earendil-works/pi-coding-agent@1.0.0`. The machine's existing global Pi is 0.85.1; it was not updated.

## Pi

- [Package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md): a default-exported TypeScript extension is discovered by `pi.extensions`; Git/local installs are supported. Host-provided packages belong in `peerDependencies` with `"*"`, not runtime dependencies.
- [Public extension types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) and [extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): `before_agent_start.prompt` is the expanded user prompt. `tool_result` has `toolName`, `input`, `content`, `details`, `isError`, and optional `structuredContent`. Returning `{ content: [...] }` replaces content; omitted fields remain unchanged, except `structuredContent` is dropped when content alone is replaced. `grep` and `find` are native tools (normally off); they also run as shell commands inside `bash`.
- The installed Pi 1.0.0 [bash implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts) returns structured output on every successful execution: `output`, `truncated`, `exit_code`, `wall_time_seconds`, and optional `full_output_path`. The gate recognizes this shape for successful top-level bash calls, filters only model-facing `content`, and returns the original `structuredContent` explicitly alongside it. Unknown structured shapes, mixed/non-text results and nested calls bypass filtering. A regression executes the public `createBashTool` with injected shell operations instead of assuming a handcrafted result shape.
- `pi.appendEntry()` persists custom session data outside model context. This is the metrics surface; no additional logger or telemetry service is needed. Throwing out of a hook can change tool behavior, so the extension catches failures explicitly.

## Cloudflare

- [Clef-flash model contract](https://developers.cloudflare.com/workers-ai/models/clef-flash/) and [Clef](https://developers.cloudflare.com/workers-ai/models/clef/): the REST path is `POST /client/v4/accounts/{account}/ai/run/@cf/cloudflare/{clef-flash|clef}`. The body includes `model`, `state`, and `questions`. `state` accepts text or structured data; questions are a keyed map with 1–64 entries. Supported types are `noul`, `choice`, and `score`.
- The raw response schema on the model page documents `answers[id] = { type: "noul", noul: number }`, with `noul` between 0 and 1. The official [REST guide](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) documents the envelope containing `result` and `success`. We require a successful envelope and validate every requested answer.
- Clef's context window is 65,536 tokens. We also honor Jev's smaller state budget by limiting each batch to 16k output characters, 4k objective characters and 2k invocation characters, plus a bounded question schema. Encoded state over 24k UTF-8 bytes fails open, including multi-byte batches. No tokenizer or silent provider-side truncation is relied upon.

## TypeSafe

- [HTTP API reference](https://docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`, bearer authentication, body `{ model, state, questions }`. Response `{ model, answers, usage }`, with the same typed `noul` answer object. There is no Cloudflare envelope.
- [Models](https://docs.typesafe.ai/models): `jev-latest` is documented; it currently resolves to `jev-1.13.0`. `GET /v1/models` lists a `models` array with `name`, `description`, `release_date`. We do not need discovery on the request path and do not implement a model catalog.
- Jev documents 64k total tokens, with a 32k limit for state plus its longest question. Batch character limits are intentionally conservative.

V1 only normalizes Noul probabilities and the answering model name. Choice/Score, media, usage billing and provider-specific features remain outside scope. These are source/schema checks; authenticated service behavior is unverified until the manual synthetic smoke test runs.
