import { DecisionError, normalizeAnswers, postDecision } from "./decision-provider.ts";
import type { DecisionProvider, DecisionQuestions, DecisionResult } from "./decision-provider.ts";

export class TypeSafeJevProvider implements DecisionProvider {
  constructor(private readonly options: { apiKey: string; model: string; timeoutMs: number }, private readonly fetcher: typeof fetch = fetch) {}

  async decide(state: unknown, questions: DecisionQuestions, signal?: AbortSignal): Promise<DecisionResult> {
    const { apiKey, model, timeoutMs } = this.options;
    if (!apiKey.trim()) throw new DecisionError("credentials");
    const response = await postDecision("https://api.typesafe.ai/v1/systemone", apiKey, { model, state, questions }, timeoutMs, this.fetcher, signal);
    return normalizeAnswers(response, questions);
  }
}
