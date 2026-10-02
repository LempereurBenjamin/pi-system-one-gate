export type DecisionQuestions = Record<string, { type: "noul"; instructions: string }>;
export interface DecisionResult { probabilities: Record<string, number>; model: string }
export interface DecisionProvider {
  decide(state: unknown, questions: DecisionQuestions, signal?: AbortSignal): Promise<DecisionResult>;
}

export class DecisionError extends Error {
  constructor(public readonly code: "credentials" | "http" | "schema" | "timeout" | "aborted" | "network", public readonly status?: number) {
    super(code);
    this.name = "DecisionError";
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Both vendors document this System One noul answer schema. No choice/score SDK.
export function normalizeAnswers(value: unknown, questions: DecisionQuestions): DecisionResult {
  if (!record(value) || typeof value.model !== "string" || !value.model || !record(value.answers)) throw new DecisionError("schema");
  const probabilities: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const answer = value.answers[id];
    if (!record(answer) || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new DecisionError("schema");
    probabilities[id] = answer.noul;
  }
  return { probabilities, model: value.model };
}

export async function postDecision(url: string, token: string, body: unknown, timeoutMs: number, fetcher: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let onAbort: (() => void) | undefined;
  try {
    // Race also bounds injectable clients that ignore AbortSignal.
    return await Promise.race([
      (async () => {
        if (combined.aborted) throw combined.reason;
        const response = await fetcher(url, {
          method: "POST", redirect: "error", signal: combined,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new DecisionError("http", response.status);
        try { return await response.json() as unknown; }
        catch { throw new DecisionError("schema"); }
      })(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new DecisionError(signal?.aborted ? "aborted" : "timeout"));
        combined.addEventListener("abort", onAbort, { once: true });
        if (combined.aborted) onAbort();
      }),
    ]);
  } catch (error) {
    if (error instanceof DecisionError) throw error;
    throw new DecisionError(combined.aborted ? (signal?.aborted ? "aborted" : "timeout") : "network");
  } finally {
    if (onAbort) combined.removeEventListener("abort", onAbort);
  }
}
