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

// Tool definitions moved to tools.ts (using Vercel AI SDK format)
