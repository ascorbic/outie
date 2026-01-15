/**
 * Structured logging utility
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

function formatMessage(prefix: string, message: string, data?: unknown): string {
  const base = `[${prefix}] ${message}`;
  if (data === undefined) return base;
  if (typeof data === "object") {
    return `${base} ${JSON.stringify(data)}`;
  }
  return `${base} ${data}`;
}

export function createLogger(prefix: string): Logger {
  return {
    debug(message: string, data?: unknown) {
      console.log(formatMessage(prefix, message, data));
    },
    info(message: string, data?: unknown) {
      console.log(formatMessage(prefix, message, data));
    },
    warn(message: string, data?: unknown) {
      console.warn(formatMessage(prefix, message, data));
    },
    error(message: string, data?: unknown) {
      console.error(formatMessage(prefix, message, data));
    },
  };
}
