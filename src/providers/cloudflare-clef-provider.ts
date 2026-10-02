import { DecisionError, normalizeAnswers, postDecision, record } from "./decision-provider.ts";
import type { DecisionProvider, DecisionQuestions, DecisionResult } from "./decision-provider.ts";

export class CloudflareClefProvider implements DecisionProvider {
  constructor(private readonly options: { accountId: string; token: string; model: "clef-flash" | "clef"; timeoutMs: number }, private readonly fetcher: typeof fetch = fetch) {}

  async decide(state: unknown, questions: DecisionQuestions, signal?: AbortSignal): Promise<DecisionResult> {
    const { accountId, token, model, timeoutMs } = this.options;
    if (!/^[a-fA-F0-9]{32}$/.test(accountId) || !token.trim()) throw new DecisionError("credentials");
    const response = await postDecision(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`, token, { model, state, questions }, timeoutMs, this.fetcher, signal);
    if (!record(response) || response.success !== true) throw new DecisionError("schema");
    return normalizeAnswers(response.result, questions);
  }
}
