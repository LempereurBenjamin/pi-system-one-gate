# pi-system-one-gate

An opt-in Pi package that classifies large tool outputs before the coding model receives them. It starts **disabled**. Once a project enables it, **shadow mode** records what would be omitted while Pi receives the original result. Active filtering requires `"mode": "active"` in that project's config.

Clef/Jev answer typed yes/no questions with probabilities. They do not summarize, rewrite, code, or select another model. The gate uses these decisions to retain original evidence, with deterministic rules that force-keep failures and security diagnostics.

```text
Pi tool_result → eligibility/privacy → line chunks → Clef or Jev
                                                       ↓
                                         must-keep + probability
                                                       ↓
                             shadow: original / active: archive + filter
                                                       ↓
                                                      Pi
              any failure ─────────────────────────→ original
```

## Install and opt one project in

Requires Node.js 22+ and Pi. It uses the [supported Pi package format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md): source entrypoint in `pi.extensions`, Pi as a peer, no runtime dependencies or build step.

From the target project's directory:

```sh
# Local checkout (project install; no global settings changes)
pi install /absolute/path/to/pi-system-one-gate --local
# After this repository is pushed:
pi install git:github.com/LempereurBenjamin/pi-system-one-gate --local

export CLOUDFLARE_ACCOUNT_ID='<32-character account ID>'
export CLOUDFLARE_AUTH_TOKEN='<Workers AI token>'
mkdir -p .pi
```

Create `.pi/system-one-gate.json`:

```json
{ "enabled": true }
```

Run `pi` normally and grant project trust as Pi requires. A session with no config sends **nothing** to the decision service, even when credentials exist. For a settings-free trial, use `pi -e /absolute/path/to/pi-system-one-gate` in the opted-in project.

## Configuration

All defaults are below. Only `enabled: true` in the project file opts in; credentials stay in the environment. Unknown keys and invalid values fail open. Config is re-read per tool result; disabling or invalidating it takes effect immediately.

```json
{
  "enabled": false,
  "mode": "shadow",
  "provider": "clef",
  "model": "clef-flash",
  "minOutputChars": 12000,
  "chunkTargetChars": 6000,
  "keepThreshold": 0.10,
  "timeoutMs": 8000,
  "eligibleTools": ["bash", "grep", "find"],
  "archive": { "enabled": true }
}
```

To filter, explicitly set `enabled: true, mode: "active"`. First/last chunks always stay, preserving framing and final status even if the model rejects everything. Other chunks stay if a must-keep rule matches or their positive probability is **≥ `keepThreshold`**. `0.10` is an initial conservative value, not a calibrated guarantee. Validate retention on your own tasks in shadow before activating.

Native `grep`/`find` exist in Pi but are normally off. Their shell equivalents are covered by `bash`. Pi 1.0.0's successful top-level bash results are supported: only model-facing text is filtered, and the separate structured output, exit code, timing and truncation metadata are explicitly preserved. `read`, `edit`, `write`, errors, mixed/non-text content, unknown structured results and nested tool calls always bypass the gate, regardless of the allowlist. Nested results can be consumed by running code instead of the main LLM and must preserve that contract. Small results bypass it. Lines stay intact; blank lines and obvious sections guide boundaries. Results over 1M characters or single lines over 12k characters fail open. Requests carry at most 64 questions and 16k chunk characters; large results run sequential bounded batches with an 8-second total decision budget by default. There are no retries.

Environment overrides: `PI_SYSTEM_ONE_GATE_PROVIDER=clef|jev`, `PI_SYSTEM_ONE_GATE_MODEL=<model>`. `PI_SYSTEM_ONE_GATE_DISABLED=1` is an emergency off switch. Environment variables cannot enable a project or turn on active filtering. Numeric limits are validated (`chunkTargetChars`: 256–12000, `timeoutMs`: 100–30000, threshold: 0–1).

## Providers

- **Cloudflare:** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AUTH_TOKEN`. Default `clef-flash`; set `model: "clef"` for Clef. Calls the official Workers AI REST endpoint using native fetch.
- **TypeSafe:** `TYPESAFE_API_KEY`; project config `{ "enabled": true, "provider": "jev" }` defaults to documented `jev-latest`. Set a versioned model ID to pin it. No per-decision model discovery.

Current source contracts and normalization details: [upstream checks](docs/upstream-contracts.md). Both clients validate every requested Noul answer and support abort/timeout. Missing credentials, 4xx/5xx, invalid JSON/schema, timeout, cancellation, chunking, archival and internal failures preserve the entire original result. No partial batch filtering is committed.

## Privacy

**Enabling shadow or active sends task context, tool invocation and eligible output chunks to the selected external provider.** Installation alone does not. Check your project's authorization and provider data policies before opting in.

The bounded latest objective and invocation are redacted before transmission. Input string values are checked and redacted recursively before JSON encoding, including credentials containing quotes, backslashes or newlines; recognizable credential fields are masked as a whole. The deterministic pass removes recognizable bearer tokens, API-key/password assignments, private-key blocks, common token prefixes, and exact current environment values (short values use word boundaries). It never includes the environment object or credentials in provider state. A raw output changed by this pass is bypassed entirely, so recognizable secrets are neither transmitted nor intentionally archived. Known credential paths (`.env*`, `.env.*`, `.aws`, `.ssh`, `.npmrc`, `auth.json`, etc.), common credential-path globs and recognizable environment-dump invocations also bypass.

This is defense in depth, **not a DLP guarantee**: arbitrary confidential source, unknown secrets, obfuscation, variable-computed paths and values no longer in the environment cannot all be detected. Matching common environment values may conservatively bypass harmless output. Original Pi output/session storage is outside this package's redaction boundary.

## Archive and recovery

In active mode, when omission produces real savings, the complete original text is written under `~/.cache/pi-system-one-gate/run-<random>/`. Directories use 0700, files 0600 on supported systems; names use generated UUIDs, never tool-call IDs. The archive root is checked for ownership/symlinks and must be outside the project. No archive is uploaded. Limits are 100 files and 50 MB per extension run; failure or exhaustion returns the original result.

The filtered result includes `Full local output: <absolute path>`. Ask Pi to `read` that file deliberately; `read` is never filtered. Omitted runs are marked and retained chunks remain ordered. If header/marker overhead consumes the savings, Pi receives the original. Shadow creates no archive. With `archive.enabled: false`, omission has no package-provided recovery; keep archival enabled for a reversible pilot.

There is no automatic deletion: archives survive Pi exit/reload, and each reload/session creates a new run. Delete old run directories deliberately when no longer needed. Permissions reduce exposure but do not encrypt files or replace your machine's access controls.

## Metrics

Concise metrics use public `pi.appendEntry("system-one-gate", ...)`, persisted in the **local Pi session log, outside model context**. No raw objective, invocation or output is logged by this package. No terminal spam or telemetry SaaS. Fields include tool, original characters, chunk count, would-retain/remove characters, retention percentage, provider, answering model, decision latency, failure count, actual delivered characters and outcome. Local failures are distinct from provider failures. Small/disabled/unsupported outputs produce no metric. Privacy bypasses record `unchanged`.

For a normally persisted session, inspect matching custom entries:

```sh
rg '"customType":"system-one-gate"' ~/.pi/agent/sessions --glob '*.jsonl'
```

If you override Pi's session directory, inspect that directory instead. `--no-session` keeps no durable metrics. Review `outcome`, `wouldRemoveChars`, `decisionLatencyMs` and `providerFailureCount` during a pilot.

## Development and validation

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run smoke:pi
npm pack --dry-run
# Explicit live request with synthetic data only; never part of tests/CI:
npm run smoke:clef
```

Tests inject HTTP responses, covering shadow/active, privacy, recoverability, bounded batches and fail-open. A regression uses Pi's actual `createBashTool` with injected shell operations to verify its structured result contract. `smoke:pi` uses Pi's public SDK to discover/load the actual package in temporary settings, without an LLM request or global settings edits. Live API quality/availability remains unverified until you run the manual smoke. No separate lint or compiled build is configured; strict typecheck and the native Pi loader validate this source package. In a sandbox that blocks the tsx CLI's IPC socket, equivalent commands are `node --import tsx --test tests/*.test.ts` and `node --import tsx scripts/smoke-pi.ts`.

Development dependency note (2026-10-02): `npm audit` reports a high-severity brace-expansion advisory in Pi 1.0.0's development-only transitive tree. Pi's published shrinkwrap pins 5.0.9; `npm audit fix` did not replace it. No runtime dependencies are shipped by this package. Upgrade the development Pi dependency when upstream publishes a corrected lock; this does not establish the safety of your separately installed Pi host.

## V1 limits and possible later work

Only the latest expanded task prompt is kept (first 4k redacted characters), not the whole conversation or initial prompt plus every follow-up. Long/ambiguous tasks may classify poorly. Character budgets are conservative, not token counts; a 24k UTF-8 byte cap on encoded state also fails open for oversized multi-byte batches. Filtering sees Pi's already-truncated tool result, not hidden stdout. This version does not filter normal file tools, unknown structured results or multimedia content. Bash's structured payload remains unchanged for programmatic consumers and is never sent to the decision service. Probabilistic relevance can omit useful evidence; shadow validation and local recovery remain essential. Session metrics report character savings, not measured token billing or end-to-end speed improvements.

Possible later work: Orca routing hints, tool-call guardrails, smarter pre-compaction filtering. None is implemented here.
