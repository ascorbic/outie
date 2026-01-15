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

// Import Sandbox type for binding
import type { Sandbox } from "@cloudflare/sandbox";

// Environment bindings
export interface Env {
  OUTIE: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  REPOS: R2Bucket;
  AI: Ai;
  // AI Gateway config
  CF_ACCOUNT_ID: string;
  CF_AIG_GATEWAY_ID: string;
  // API tokens (provider keys stored in AI Gateway BYOK)
  CF_API_TOKEN: string; // For AI Gateway auth + Browser Rendering API
  BRAVE_SEARCH_API_KEY: string;
  // Telegram bot integration
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string; // Your personal chat ID
  TELEGRAM_WEBHOOK_SECRET?: string; // Secret for webhook verification

  // Z.AI (GLM Coding Plan) - optional fallback for sandbox
  ZAI_API_KEY?: string;

  ENVIRONMENT: string;
}
