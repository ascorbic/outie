/**
 * Embedding and semantic search utilities
 * 
 * Uses Cloudflare Workers AI for embeddings (bge-small-en-v1.5, 384 dims).
 * Vectors are normalized at storage time so search is just dot product.
 * 
 * Per BGE docs: queries should be prefixed with an instruction for retrieval tasks.
 * Documents/passages do NOT need the instruction.
 */

import type { JournalEntry, Topic, RetrievedContext } from "../types";
import { searchJournalEntries as getJournalEntries, getTopicsWithEmbeddings } from "./state";

// BGE retrieval instruction prefix for queries
const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

/**
 * Generate embedding for a document/passage (no instruction prefix)
 * Returns a normalized vector (unit length)
 */
export async function getEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run("@cf/baai/bge-small-en-v1.5", {
    text: [text],
  });
  if ("data" in result && result.data && result.data.length > 0) {
    // Normalize the vector (bge models do not return unit vectors by default)
    return normalize(result.data[0]);
  }
  throw new Error("Failed to generate embedding");
}

/**
 * Generate embedding for a search query (with instruction prefix)
 * Per BGE docs, queries should be prefixed for better retrieval performance.
 */
export async function getQueryEmbedding(ai: Ai, query: string): Promise<number[]> {
  return getEmbedding(ai, QUERY_INSTRUCTION + query);
}

/**
 * Normalize a vector to unit length
 */
function normalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  
  const result = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    result[i] = v[i] / norm;
  }
  return result;
}

/**
 * Dot product of two vectors
 * For normalized vectors, this equals cosine similarity
 */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Semantic search over journal entries
 * 
 * Since vectors are normalized at storage time, we use dot product
 * which is equivalent to cosine similarity but faster (no sqrt).
 */
export async function searchJournal(
  ai: Ai,
  sql: DurableObjectStorage["sql"],
  query: string,
  limit: number = 5,
): Promise<Array<{ entry: JournalEntry; score: number }>> {
  // Use query embedding (with instruction prefix) for better retrieval
  const queryEmbedding = await getQueryEmbedding(ai, query);
  const entries = getJournalEntries(sql);

  // Score all entries
  const scored: Array<{ entry: JournalEntry; score: number }> = [];
  
  for (const e of entries) {
    if (!e.embedding) continue;
    
    // Parse embedding (stored as JSON string)
    // TODO: Consider storing as binary blob for faster parsing
    const embedding: number[] = JSON.parse(e.embedding);
    
    // Dot product = cosine similarity for normalized vectors
    const score = dotProduct(queryEmbedding, embedding);
    
    // Skip low-relevance results early
    if (score <= 0.3) continue;
    
    scored.push({
      entry: {
        id: e.id,
        timestamp: e.timestamp,
        topic: e.topic,
        content: e.content,
      },
      score,
    });
  }

  // Sort by score descending and take top results
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Semantic search over topics
 */
export async function searchTopics(
  ai: Ai,
  sql: DurableObjectStorage["sql"],
  query: string,
  limit: number = 3,
): Promise<Array<{ topic: Topic; score: number }>> {
  const queryEmbedding = await getQueryEmbedding(ai, query);
  const topics = getTopicsWithEmbeddings(sql);

  const scored: Array<{ topic: Topic; score: number }> = [];
  
  for (const { topic, embedding } of topics) {
    const embeddingVec: number[] = JSON.parse(embedding);
    const score = dotProduct(queryEmbedding, embeddingVec);
    
    // Skip low-relevance
    if (score <= 0.35) continue;
    
    scored.push({ topic, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Pre-flight retrieval: search both topics and journal for relevant context
 * Called before the main chat loop to inject relevant memory automatically
 */
export async function retrieveContext(
  ai: Ai,
  sql: DurableObjectStorage["sql"],
  userMessage: string,
): Promise<RetrievedContext> {
  // Run searches in parallel
  const [topics, journal] = await Promise.all([
    searchTopics(ai, sql, userMessage, 3),
    searchJournal(ai, sql, userMessage, 3),
  ]);

  return { topics, journal };
}
