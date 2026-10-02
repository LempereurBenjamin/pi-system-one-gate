export interface Chunk { id: string; text: string }
export const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_CHUNK_CHARS = 12_000;
export const MAX_BATCH_CHARS = 16_000;

export function chunkOutput(text: string, target: number): Chunk[] {
  if (!Number.isInteger(target) || target < 256 || target > MAX_CHUNK_CHARS) throw new Error("chunk-target");
  if (text.length > MAX_OUTPUT_CHARS) throw new Error("output-limit");
  const chunks: Chunk[] = [];
  let pending = "";
  const flush = () => {
    if (pending) chunks.push({ id: `chunk_${chunks.length}`, text: pending });
    pending = "";
  };
  // Keep newline bytes and never split a line; oversized single lines fail open.
  for (const line of text.split(/(?<=\n)/)) {
    if (line.length > MAX_CHUNK_CHARS) throw new Error("line-limit");
    const section = /^diff --git |^--- |^\+\+\+ |^#{1,3} |^FAIL\b|^PASS\b/.test(line);
    if (pending && (pending.length + line.length > target || section)) flush();
    pending += line;
    if (pending.length >= target || (/^\s*\n$/.test(line) && pending.length >= target / 2)) flush();
  }
  flush();
  return chunks;
}

export function batchChunks(chunks: Chunk[]): Chunk[][] {
  const batches: Chunk[][] = [];
  let batch: Chunk[] = [];
  let chars = 0;
  for (const chunk of chunks) {
    if (chunk.text.length > MAX_CHUNK_CHARS) throw new Error("chunk-limit");
    if (batch.length && (batch.length === 64 || chars + chunk.text.length > MAX_BATCH_CHARS)) {
      batches.push(batch); batch = []; chars = 0;
    }
    batch.push(chunk); chars += chunk.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
