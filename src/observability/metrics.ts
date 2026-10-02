export interface GateMetric {
  mode: "shadow" | "active";
  tool: string;
  originalChars: number;
  chunkCount: number;
  wouldRetainChars: number;
  wouldRemoveChars: number;
  retentionPercent: number;
  provider: string;
  model: string;
  decisionLatencyMs: number;
  providerFailureCount: number;
  deliveredChars: number;
  outcome: "shadow" | "filtered" | "unchanged" | "fail-open";
  diagnostic?: string;
}

export type RecordMetric = (metric: GateMetric) => void;

export function recordSafely(record: RecordMetric, metric: GateMetric): void {
  try { record(metric); }
  catch { /* Observability must not change the tool result or throw into Pi. */ }
}
