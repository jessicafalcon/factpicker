/**
 * Deterministic offline embedding.
 *
 * This is a lexical hashing embedder, not a semantic model. It exists so the
 * vector path is testable and the demo degrades honestly instead of failing
 * when Vertex is not configured. Cosine similarity reflects shared vocabulary;
 * use gemini-embedding-001 when meaning matters.
 */
import { createHash } from "node:crypto";

export const HASH_DIMS = 3072;

export function hashEmbedding(text: string): number[] {
  const vector = new Array(HASH_DIMS).fill(0);
  for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % HASH_DIMS;
    vector[index] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}
