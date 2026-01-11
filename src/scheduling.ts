import type { Reminder } from "./types";

// Parse cron expression to next run time
// Simplified: only supports basic patterns like "0 9 * * *" (9am daily)
export function getNextCronTime(cron: string): number {
  const parts = cron.split(" ");
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cron}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const now = new Date();
  const next = new Date(now);

  // Set the time
  if (minute !== "*") next.setMinutes(parseInt(minute, 10));
  if (hour !== "*") next.setHours(parseInt(hour, 10));
  next.setSeconds(0);
  next.setMilliseconds(0);

  // If the time has passed today, move to tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  // Handle day of week (0 = Sunday)
  if (dayOfWeek !== "*") {
    const targetDay = parseInt(dayOfWeek, 10);
    while (next.getDay() !== targetDay) {
      next.setDate(next.getDate() + 1);
    }
  }

  return next.getTime();
}

// Scheduling tools for the agent
export const SCHEDULING_TOOLS = [
  {
    name: "schedule_reminder",
    description:
      'Schedule a recurring reminder using cron syntax (e.g., "0 9 * * *" for 9am daily)',
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique reminder ID" },
        cron: { type: "string", description: "Cron expression" },
        description: {
          type: "string",
          description: "What this reminder is for",
        },
        payload: {
          type: "string",
          description: "Message to process when reminder fires",
        },
      },
      required: ["id", "cron", "description", "payload"],
    },
  },
  {
    name: "schedule_once",
    description: "Schedule a one-time reminder at a specific datetime",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique reminder ID" },
        datetime: {
          type: "string",
          description: 'ISO 8601 datetime (e.g., "2026-01-15T10:00:00")',
        },
        description: {
          type: "string",
          description: "What this reminder is for",
        },
        payload: {
          type: "string",
          description: "Message to process when reminder fires",
        },
      },
      required: ["id", "datetime", "description", "payload"],
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a scheduled reminder",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Reminder ID to cancel" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_reminders",
    description: "List all scheduled reminders",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];
