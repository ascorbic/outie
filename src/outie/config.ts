/**
 * Configuration constants
 * 
 * Values that might need tuning or could become env vars in the future.
 */

// Conversation summarization
export const SUMMARIZE_THRESHOLD = 50;  // Start summarizing after this many messages
export const SUMMARIZE_RATIO = 0.7;     // Summarize this portion of messages
export const MAX_CONTEXT_MESSAGES = 20; // Max messages to send to AI

// Content limits
export const MAX_PAGE_CONTENT_LENGTH = 8000;  // Truncate fetched pages
export const MAX_SEARCH_RESULTS = 10;

// Coding tasks
export const CODING_TASK_STALE_HOURS = 24;  // Start fresh branch after this long

// Tool execution
export const MAX_TOOL_STEPS = 10;  // Max tool call rounds per chat
