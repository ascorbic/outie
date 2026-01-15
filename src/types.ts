// Memory block structure (Letta-style)
export interface MemoryBlock {
  label: string;
  description: string;
  value: string;
  limit: number;
  lastUpdated: number;
}

// Journal entry
export interface JournalEntry {
  id: string;
  timestamp: number;
  topic: string;
  content: string;
}

// Scheduled reminder
export interface Reminder {
  id: string;
  description: string;
  payload: string;
  // For cron reminders
  cronExpression?: string;
  // For one-shot reminders
  scheduledTime?: number;
  // Model tier override (default: fast)
  modelTier?: ModelTier;
}

// Conversation summary
export interface ConversationSummary {
  id: string;
  timestamp: number;
  content: string;
  // Range of messages summarized
  fromTimestamp: number;
  toTimestamp: number;
  messageCount: number;
}

// Agent state persisted in DO
export interface OutieState {
  memoryBlocks: Record<string, MemoryBlock>;
  reminders: Record<string, Reminder>;
  conversationHistory: Message[];
  // Rolling summary of older conversation
  conversationSummary?: ConversationSummary;
}

// Message in conversation (simplified - tool calls handled by AI SDK)
export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// Model tiers for cost optimization
export type ModelTier = "fast" | "thinking";

// Coding task state - tracks OpenCode sessions for continuation
export interface CodingTaskState {
  repoUrl: string;
  branch: string;           // Worker-chosen branch name, e.g., "innie/add-error-handling"
  sessionId: string;        // OpenCode session ID for continuation
  lastTask: string;         // Description of last task
  lastTimestamp: number;    // When it ran
}

// Decision from worker model about how to handle a coding task
export interface CodingTaskDecision {
  action: "continue" | "new";
  branch?: string;          // Required if action is "new"
}


