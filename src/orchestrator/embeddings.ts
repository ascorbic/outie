/**
 * Embeddings and Semantic Search
 * 
 * Uses Workers AI for embeddings and cosine similarity for search.
 */

import type { JournalEntry, Topic } from './types';

// =============================================================================
// Embedding Generation
// =============================================================================

export async function getEmbedding(ai: Ai, text: string): Promise<Float32Array> {
  const response = await ai.run('@cf/baai/bge-base-en-v1.5', {
    text: [text],
  });
  
  // @ts-expect-error - Workers AI response type is not fully typed
  const embedding = response.data?.[0];
  if (!embedding) {
    throw new Error('Failed to generate embedding');
  }
  
  return new Float32Array(embedding);
}

// =============================================================================
// Cosine Similarity
// =============================================================================

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// =============================================================================
// Journal Search
// =============================================================================

export interface JournalSearchResult {
  entry: JournalEntry;
  score: number;
}

export async function searchJournal(
  ai: Ai,
  sql: SqlStorage,
  query: string,
  limit: number = 5
): Promise<JournalSearchResult[]> {
  // Get query embedding
  const queryEmbedding = await getEmbedding(ai, query);
  
  // Fetch all journal entries with embeddings
  const rows = sql.exec(
    `SELECT id, timestamp, topic, content, embedding
     FROM journal
     WHERE embedding IS NOT NULL
     ORDER BY timestamp DESC
     LIMIT 500`  // Limit to recent entries for performance
  ).toArray();
  
  // Calculate similarities
  const results: JournalSearchResult[] = [];
  
  for (const row of rows) {
    const embeddingBytes = row.embedding as Uint8Array | null;
    if (!embeddingBytes) continue;
    
    const embedding = new Float32Array(embeddingBytes.buffer);
    const score = cosineSimilarity(queryEmbedding, embedding);
    
    results.push({
      entry: {
        id: row.id as string,
        timestamp: row.timestamp as number,
        topic: row.topic as string,
        content: row.content as string,
      },
      score,
    });
  }
  
  // Sort by score descending and take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// =============================================================================
// Topic Search
// =============================================================================

export interface TopicSearchResult {
  topic: Topic;
  score: number;
}

export async function searchTopics(
  ai: Ai,
  sql: SqlStorage,
  query: string,
  limit: number = 5
): Promise<TopicSearchResult[]> {
  // Get query embedding
  const queryEmbedding = await getEmbedding(ai, query);
  
  // Fetch all topics with embeddings
  const rows = sql.exec(
    `SELECT id, name, content, created_at, updated_at, embedding
     FROM topics
     WHERE embedding IS NOT NULL`
  ).toArray();
  
  // Calculate similarities
  const results: TopicSearchResult[] = [];
  
  for (const row of rows) {
    const embeddingBytes = row.embedding as Uint8Array | null;
    if (!embeddingBytes) continue;
    
    const embedding = new Float32Array(embeddingBytes.buffer);
    const score = cosineSimilarity(queryEmbedding, embedding);
    
    results.push({
      topic: {
        id: row.id as string,
        name: row.name as string,
        content: row.content as string,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      },
      score,
    });
  }
  
  // Sort by score descending and take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
