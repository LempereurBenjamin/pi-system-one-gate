import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { ContextGate } from "./gate/context-gate.ts";
import { LocalArchive } from "./gate/archive.ts";
import { createRedactor } from "./gate/privacy.ts";
import { CloudflareClefProvider } from "./providers/cloudflare-clef-provider.ts";
import { TypeSafeJevProvider } from "./providers/typesafe-jev-provider.ts";
import type { GateMetric } from "./observability/metrics.ts";

export default function systemOneGate(pi: ExtensionAPI): void {
  let objective = "";
  const record = (metric: GateMetric) => pi.appendEntry("system-one-gate", metric);
  let archive: LocalArchive | undefined;
  let archiveProject = "";

  pi.on("session_start", () => { objective = ""; archive = undefined; archiveProject = ""; });
  pi.on("before_agent_start", event => {
    // Latest task only; never accumulate the transcript. Redact before bounding it.
    try { objective = createRedactor(process.env)(event.prompt).slice(0, 4_000); }
    catch { objective = ""; }
  });
  pi.on("tool_result", async (event, ctx) => {
    try {
      // Read per result so disabling or invalidating config takes effect immediately.
      const config = await loadConfig(ctx.cwd);
      if (!config.enabled) return;
      const provider = config.provider === "clef"
        ? new CloudflareClefProvider({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", token: process.env.CLOUDFLARE_AUTH_TOKEN ?? "",
          model: config.model as "clef-flash" | "clef", timeoutMs: config.timeoutMs })
        : new TypeSafeJevProvider({ apiKey: process.env.TYPESAFE_API_KEY ?? "", model: config.model, timeoutMs: config.timeoutMs });
      if (!archive || archiveProject !== ctx.cwd) { archive = new LocalArchive(undefined, ctx.cwd); archiveProject = ctx.cwd; }
      return await new ContextGate(config, provider, createRedactor(process.env), record, archive).handle(event, objective, ctx.signal);
    } catch {
      // Pi can convert thrown hook errors into tool errors. Nothing escapes this boundary.
      try { pi.appendEntry("system-one-gate", { outcome: "fail-open", diagnostic: "configuration-or-extension" }); }
      catch { /* A failed session log must not block the original tool result. */ }
      return;
    }
  });
}
