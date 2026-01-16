/**
 * State Management for Orchestrator
 * 
 * SQLite-backed persistence for:
 * - Conversation buffer (rolling window)
 * - Journal entries
 * - State files (identity, today, etc.)
 * - Reminders
 * - Conversation summaries
 * - Topics
 */

import type {
  ConversationMessage,
  ConversationStats,
  JournalEntry,
  Reminder,
  ConversationSummary,
  StateFile,
  Topic,
} from './types';

// Token estimation: ~4 chars per token
const CHARS_PER_TOKEN = 4;
const TOKEN_THRESHOLD = 50000;

// =============================================================================
// Schema Initialization
// =============================================================================

export function initSchema(sql: SqlStorage): void {
  sql.exec(`
    -- Conversation buffer (rolling window)
    CREATE TABLE IF NOT EXISTS conversation (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_timestamp ON conversation(timestamp);

    -- Journal entries (append-only log)
    CREATE TABLE IF NOT EXISTS journal (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_journal_timestamp ON journal(timestamp);

    -- State files (key-value for identity, today, etc.)
    CREATE TABLE IF NOT EXISTS state_files (
      name TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Reminders (cron or one-shot)
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      payload TEXT NOT NULL,
      cron_expression TEXT,
      scheduled_time INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Conversation summaries (for context recovery)
    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      summary TEXT NOT NULL,
      notes TEXT,
      key_decisions TEXT,
      open_threads TEXT,
      learned_patterns TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_timestamp ON summaries(timestamp);

    -- Topics (distilled knowledge)
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      embedding BLOB
    );
  `);
}

// =============================================================================
// Conversation Buffer
// =============================================================================

export function appendConversation(sql: SqlStorage, msg: ConversationMessage): void {
  sql.exec(
    `INSERT INTO conversation (id, role, content, timestamp, trigger, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
    msg.id,
    msg.role,
    msg.content,
    msg.timestamp,
    msg.trigger,
    msg.source ?? null
  );
}

export function getRecentConversation(sql: SqlStorage, limit: number = 30): ConversationMessage[] {
  const rows = sql.exec(
    `SELECT id, role, content, timestamp, trigger, source
     FROM conversation
     ORDER BY timestamp DESC
     LIMIT ?`,
    limit
  ).toArray();

  return rows.reverse().map(row => ({
    id: row.id as string,
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    timestamp: row.timestamp as number,
    trigger: row.trigger as ConversationMessage['trigger'],
    source: row.source as string | undefined,
  }));
}

export function clearConversation(sql: SqlStorage): void {
  sql.exec(`DELETE FROM conversation`);
}

export function getConversationStats(sql: SqlStorage): ConversationStats {
  const countRow = sql.exec(`SELECT COUNT(*) as count FROM conversation`).one();
  const messageCount = (countRow?.count as number) ?? 0;

  // Estimate tokens from content length
  const sizeRow = sql.exec(`SELECT COALESCE(SUM(LENGTH(content)), 0) as size FROM conversation`).one();
  const totalChars = (sizeRow?.size as number) ?? 0;
  const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);

  return {
    messageCount,
    estimatedTokens,
    needsCompaction: estimatedTokens > TOKEN_THRESHOLD,
  };
}

// =============================================================================
// Journal
// =============================================================================

export function saveJournalEntry(sql: SqlStorage, entry: JournalEntry, embedding?: Float32Array): void {
  sql.exec(
    `INSERT INTO journal (id, timestamp, topic, content, embedding)
     VALUES (?, ?, ?, ?, ?)`,
    entry.id,
    entry.timestamp,
    entry.topic,
    entry.content,
    embedding ? new Uint8Array(embedding.buffer) : null
  );
}

export function getRecentJournal(sql: SqlStorage, limit: number = 40): JournalEntry[] {
  const rows = sql.exec(
    `SELECT id, timestamp, topic, content
     FROM journal
     ORDER BY timestamp DESC
     LIMIT ?`,
    limit
  ).toArray();

  return rows.reverse().map(row => ({
    id: row.id as string,
    timestamp: row.timestamp as number,
    topic: row.topic as string,
    content: row.content as string,
  }));
}

// =============================================================================
// State Files
// =============================================================================

export function saveStateFile(sql: SqlStorage, file: StateFile): void {
  sql.exec(
    `INSERT OR REPLACE INTO state_files (name, content, updated_at)
     VALUES (?, ?, ?)`,
    file.name,
    file.content,
    file.updatedAt
  );
}

export function getStateFile(sql: SqlStorage, name: string): StateFile | null {
  const row = sql.exec(
    `SELECT name, content, updated_at FROM state_files WHERE name = ?`,
    name
  ).one();

  if (!row) return null;

  return {
    name: row.name as string,
    content: row.content as string,
    updatedAt: row.updated_at as number,
  };
}

export function getAllStateFiles(sql: SqlStorage): Record<string, string> {
  const rows = sql.exec(`SELECT name, content FROM state_files`).toArray();
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.name as string] = row.content as string;
  }
  return result;
}

// =============================================================================
// Reminders
// =============================================================================

export function saveReminder(sql: SqlStorage, reminder: Reminder): void {
  sql.exec(
    `INSERT OR REPLACE INTO reminders (id, description, payload, cron_expression, scheduled_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    reminder.id,
    reminder.description,
    reminder.payload,
    reminder.cronExpression ?? null,
    reminder.scheduledTime ?? null,
    reminder.createdAt
  );
}

export function deleteReminder(sql: SqlStorage, id: string): void {
  sql.exec(`DELETE FROM reminders WHERE id = ?`, id);
}

export function getAllReminders(sql: SqlStorage): Reminder[] {
  const rows = sql.exec(
    `SELECT id, description, payload, cron_expression, scheduled_time, created_at
     FROM reminders`
  ).toArray();

  return rows.map(row => ({
    id: row.id as string,
    description: row.description as string,
    payload: row.payload as string,
    cronExpression: row.cron_expression as string | undefined,
    scheduledTime: row.scheduled_time as number | undefined,
    createdAt: row.created_at as number,
  }));
}

// =============================================================================
// Conversation Summaries
// =============================================================================

export function saveSummary(sql: SqlStorage, summary: ConversationSummary): void {
  sql.exec(
    `INSERT INTO summaries (id, timestamp, summary, notes, key_decisions, open_threads, learned_patterns)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    summary.id,
    summary.timestamp,
    summary.summary,
    summary.notes ?? null,
    summary.keyDecisions ? JSON.stringify(summary.keyDecisions) : null,
    summary.openThreads ? JSON.stringify(summary.openThreads) : null,
    summary.learnedPatterns ? JSON.stringify(summary.learnedPatterns) : null
  );
}

export function getRecentSummaries(sql: SqlStorage, limit: number = 1): ConversationSummary[] {
  const rows = sql.exec(
    `SELECT id, timestamp, summary, notes, key_decisions, open_threads, learned_patterns
     FROM summaries
     ORDER BY timestamp DESC
     LIMIT ?`,
    limit
  ).toArray();

  return rows.map(row => ({
    id: row.id as string,
    timestamp: row.timestamp as number,
    summary: row.summary as string,
    notes: row.notes as string | undefined,
    keyDecisions: row.key_decisions ? JSON.parse(row.key_decisions as string) : undefined,
    openThreads: row.open_threads ? JSON.parse(row.open_threads as string) : undefined,
    learnedPatterns: row.learned_patterns ? JSON.parse(row.learned_patterns as string) : undefined,
  }));
}

// =============================================================================
// Topics
// =============================================================================

export function saveTopic(sql: SqlStorage, topic: Topic, embedding?: Float32Array): void {
  sql.exec(
    `INSERT OR REPLACE INTO topics (id, name, content, created_at, updated_at, embedding)
     VALUES (?, ?, ?, ?, ?, ?)`,
    topic.id,
    topic.name,
    topic.content,
    topic.createdAt,
    topic.updatedAt,
    embedding ? new Uint8Array(embedding.buffer) : null
  );
}

export function getTopic(sql: SqlStorage, name: string): Topic | null {
  const row = sql.exec(
    `SELECT id, name, content, created_at, updated_at FROM topics WHERE name = ?`,
    name
  ).one();

  if (!row) return null;

  return {
    id: row.id as string,
    name: row.name as string,
    content: row.content as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function listTopics(sql: SqlStorage): Topic[] {
  const rows = sql.exec(
    `SELECT id, name, content, created_at, updated_at FROM topics ORDER BY updated_at DESC`
  ).toArray();

  return rows.map(row => ({
    id: row.id as string,
    name: row.name as string,
    content: row.content as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }));
}
