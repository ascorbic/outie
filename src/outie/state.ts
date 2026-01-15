/**
 * SQLite state management for the Outie DO
 */

import type {
  OutieState,
  MemoryBlock,
  JournalEntry,
  Reminder,
  Message,
  ConversationSummary,
  CodingTaskState,
} from "../types";
import { DEFAULT_MEMORY_BLOCKS } from "../memory";
import { createLogger } from "./logger";

const log = createLogger("STATE");

/**
 * Initialize SQLite tables
 */
export function initSchema(sql: DurableObjectStorage["sql"]): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS memory_blocks (
      label TEXT PRIMARY KEY,
      description TEXT,
      value TEXT,
      char_limit INTEGER,
      last_updated INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS journal (
      id TEXT PRIMARY KEY,
      timestamp INTEGER,
      topic TEXT,
      content TEXT,
      embedding TEXT
    );
    
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      description TEXT,
      payload TEXT,
      cron_expression TEXT,
      scheduled_time INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      role TEXT,
      content TEXT,
      timestamp INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS conversation_summary (
      id TEXT PRIMARY KEY,
      timestamp INTEGER,
      content TEXT,
      from_timestamp INTEGER,
      to_timestamp INTEGER,
      message_count INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS coding_task_state (
      repo_url TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_task TEXT NOT NULL,
      last_timestamp INTEGER NOT NULL
    );
  `);
}

/**
 * Load all state from SQLite into memory
 */
export function loadState(sql: DurableObjectStorage["sql"]): OutieState {
  const state: OutieState = {
    memoryBlocks: { ...DEFAULT_MEMORY_BLOCKS },
    reminders: {},
    conversationHistory: [],
  };

  // Load memory blocks
  const blocks = sql
    .exec<{
      label: string;
      description: string;
      value: string;
      char_limit: number;
      last_updated: number;
    }>("SELECT * FROM memory_blocks")
    .toArray();

  for (const block of blocks) {
    state.memoryBlocks[block.label] = {
      label: block.label,
      description: block.description,
      value: block.value,
      limit: block.char_limit,
      lastUpdated: block.last_updated,
    };
  }

  // Load reminders
  const reminders = sql
    .exec<{
      id: string;
      description: string;
      payload: string;
      cron_expression: string | null;
      scheduled_time: number | null;
    }>("SELECT * FROM reminders")
    .toArray();

  for (const r of reminders) {
    state.reminders[r.id] = {
      id: r.id,
      description: r.description,
      payload: r.payload,
      cronExpression: r.cron_expression ?? undefined,
      scheduledTime: r.scheduled_time ?? undefined,
    };
  }

  // Load recent messages (last 50)
  const messages = sql
    .exec<{
      id: string;
      role: string;
      content: string;
      timestamp: number;
    }>("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50")
    .toArray();

  state.conversationHistory = messages.reverse().map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
    timestamp: m.timestamp,
  }));

  // Load conversation summary if exists
  const summaries = sql
    .exec<{
      id: string;
      timestamp: number;
      content: string;
      from_timestamp: number;
      to_timestamp: number;
      message_count: number;
    }>("SELECT * FROM conversation_summary ORDER BY timestamp DESC LIMIT 1")
    .toArray();

  if (summaries.length > 0) {
    const s = summaries[0];
    state.conversationSummary = {
      id: s.id,
      timestamp: s.timestamp,
      content: s.content,
      fromTimestamp: s.from_timestamp,
      toTimestamp: s.to_timestamp,
      messageCount: s.message_count,
    };
  }

  return state;
}

// ==========================================
// Individual save/delete operations
// ==========================================

export function saveMemoryBlock(sql: DurableObjectStorage["sql"], block: MemoryBlock): void {
  sql.exec(
    `INSERT OR REPLACE INTO memory_blocks (label, description, value, char_limit, last_updated)
     VALUES (?, ?, ?, ?, ?)`,
    block.label,
    block.description,
    block.value,
    block.limit,
    block.lastUpdated,
  );
}

export function saveJournalEntry(
  sql: DurableObjectStorage["sql"],
  entry: JournalEntry,
  embedding: number[],
): void {
  sql.exec(
    `INSERT INTO journal (id, timestamp, topic, content, embedding) VALUES (?, ?, ?, ?, ?)`,
    entry.id,
    entry.timestamp,
    entry.topic,
    entry.content,
    JSON.stringify(embedding),
  );
}

export function searchJournalEntries(
  sql: DurableObjectStorage["sql"],
): Array<{ id: string; timestamp: number; topic: string; content: string; embedding: string | null }> {
  return sql
    .exec<{
      id: string;
      timestamp: number;
      topic: string;
      content: string;
      embedding: string | null;
    }>("SELECT * FROM journal WHERE embedding IS NOT NULL")
    .toArray();
}

export function saveReminder(sql: DurableObjectStorage["sql"], reminder: Reminder): void {
  sql.exec(
    `INSERT OR REPLACE INTO reminders (id, description, payload, cron_expression, scheduled_time)
     VALUES (?, ?, ?, ?, ?)`,
    reminder.id,
    reminder.description,
    reminder.payload,
    reminder.cronExpression ?? null,
    reminder.scheduledTime ?? null,
  );
}

export function deleteReminder(sql: DurableObjectStorage["sql"], id: string): void {
  sql.exec("DELETE FROM reminders WHERE id = ?", id);
}

export function saveMessage(sql: DurableObjectStorage["sql"], message: Message): void {
  sql.exec(
    `INSERT INTO messages (id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
    message.id,
    message.role,
    message.content,
    message.timestamp,
  );
}

export function deleteMessage(sql: DurableObjectStorage["sql"], id: string): void {
  sql.exec("DELETE FROM messages WHERE id = ?", id);
}

export function saveSummary(sql: DurableObjectStorage["sql"], summary: ConversationSummary): void {
  sql.exec(
    `INSERT OR REPLACE INTO conversation_summary 
     (id, timestamp, content, from_timestamp, to_timestamp, message_count) 
     VALUES (?, ?, ?, ?, ?, ?)`,
    summary.id,
    summary.timestamp,
    summary.content,
    summary.fromTimestamp,
    summary.toTimestamp,
    summary.messageCount,
  );
}

export function clearConversation(sql: DurableObjectStorage["sql"]): void {
  sql.exec("DELETE FROM messages");
  sql.exec("DELETE FROM conversation_summary");
}

export function getCodingTaskState(
  sql: DurableObjectStorage["sql"],
  repoUrl: string,
): CodingTaskState | null {
  const rows = sql
    .exec<{
      repo_url: string;
      branch: string;
      session_id: string;
      last_task: string;
      last_timestamp: number;
    }>("SELECT * FROM coding_task_state WHERE repo_url = ?", repoUrl)
    .toArray();

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    repoUrl: row.repo_url,
    branch: row.branch,
    sessionId: row.session_id,
    lastTask: row.last_task,
    lastTimestamp: row.last_timestamp,
  };
}

export function saveCodingTaskState(
  sql: DurableObjectStorage["sql"],
  state: CodingTaskState,
): void {
  sql.exec(
    `INSERT OR REPLACE INTO coding_task_state 
     (repo_url, branch, session_id, last_task, last_timestamp)
     VALUES (?, ?, ?, ?, ?)`,
    state.repoUrl,
    state.branch,
    state.sessionId,
    state.lastTask,
    state.lastTimestamp,
  );
}
