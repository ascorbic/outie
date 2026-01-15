/**
 * Coding task orchestration
 */

import { generateText } from "ai";
import type { CodingTaskState, CodingTaskDecision } from "../types";
import { createModelProvider } from "../models";
import { runCodingTask, type OutieSandboxType } from "../sandbox";
import { getInstallationToken, getGitHubAppCredentials } from "../github";
import { getCodingTaskState, saveCodingTaskState } from "./state";
import { createLogger } from "./logger";
import { CODING_TASK_STALE_HOURS } from "./config";

// Re-export for convenience
export { getCodingTaskState } from "./state";

const log = createLogger("CODING");

/**
 * Format time ago for display
 */
function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / (1000 * 60));
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/**
 * Generate a short hash suffix for branch uniqueness
 */
function shortHash(): string {
  return crypto.randomUUID().slice(0, 6);
}

/**
 * Generate a branch name from task description
 */
async function generateBranchName(env: Env, task: string): Promise<string> {
  const suffix = shortHash();
  
  try {
    const { text } = await generateText({
      model: createModelProvider(env, "fast"),
      prompt: `Generate a git branch name for this task. Use the format "outie/descriptive-slug".
Rules:
- Lowercase only
- Use hyphens between words
- Max 40 characters (a hash suffix will be added)
- Be descriptive but concise

Task: ${task}

Reply with ONLY the branch name, nothing else.`,
    });

    const branch = text.trim().toLowerCase().replace(/[^a-z0-9\-\/]/g, "-");
    if (branch.startsWith("outie/") && branch.length <= 40) {
      return `${branch}-${suffix}`;
    }
  } catch (error) {
    log.error("Failed to generate branch name", error);
  }

  // Fallback: generate from task
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 25)
    .replace(/-+$/, "");
  return `outie/${slug}-${suffix}`;
}

/**
 * Decide whether to continue or start new coding task
 */
export async function decideCodingTaskAction(
  env: Env,
  repoUrl: string,
  task: string,
  previousState: CodingTaskState | null,
): Promise<CodingTaskDecision> {
  // If no previous state, always create new
  if (!previousState) {
    const branch = await generateBranchName(env, task);
    return { action: "new", branch };
  }

  // Check how old the previous task is
  const ageMs = Date.now() - previousState.lastTimestamp;
  const ageHours = ageMs / (1000 * 60 * 60);

  // If more than threshold hours old, start fresh
  if (ageHours > CODING_TASK_STALE_HOURS) {
    const branch = await generateBranchName(env, task);
    return { action: "new", branch };
  }

  // Ask the model to decide
  const prompt = `You're managing coding tasks in a repository.

Previous task (${formatTimeAgo(ageMs)} ago):
Branch: ${previousState.branch}
Task: ${previousState.lastTask}

New task: ${task}

Is the new task a CONTINUATION of the previous work (same feature/bug/topic), or is it NEW unrelated work?

Reply with ONLY valid JSON, no other text:
- If continuing: {"action": "continue"}
- If new work: {"action": "new", "branch": "outie/descriptive-slug"}

Branch names should be lowercase, use hyphens, and describe the work (e.g., "outie/add-error-handling", "outie/fix-auth-bug").
Note: A hash suffix will be added automatically for uniqueness.`;

  try {
    const { text } = await generateText({
      model: createModelProvider(env, "fast"),
      prompt,
    });

    // Parse the JSON response
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const decision = JSON.parse(jsonMatch[0]) as CodingTaskDecision;
      if (decision.action === "continue") {
        return decision;
      }
      if (decision.action === "new" && decision.branch) {
        // Add hash suffix for uniqueness
        return { action: "new", branch: `${decision.branch}-${shortHash()}` };
      }
    }
  } catch (error) {
    log.error("Failed to parse decision", error);
  }

  // Fallback: generate new branch
  const branch = await generateBranchName(env, task);
  return { action: "new", branch };
}

export interface ManagedCodingTaskContext {
  env: Env;
  sql: DurableObjectStorage["sql"];
  sandboxBinding: DurableObjectNamespace<OutieSandboxType>;
}

export interface ManagedCodingTaskResult {
  response: string;
  branch: string;
}

/**
 * Run a coding task with full state management
 * This is the main entry point for both the tool and /code endpoint
 */
export async function runManagedCodingTask(
  ctx: ManagedCodingTaskContext,
  repoUrl: string,
  task: string,
): Promise<ManagedCodingTaskResult> {
  log.info(`Starting managed task for ${repoUrl}`);

  // 1. Get existing state for this repo
  const previousState = getCodingTaskState(ctx.sql, repoUrl);
  if (previousState) {
    log.info(`Found previous state: branch=${previousState.branch}, session=${previousState.sessionId}`);
  }

  // 2. Decide whether to continue or start fresh
  const decision = await decideCodingTaskAction(ctx.env, repoUrl, task, previousState);
  log.info(`Decision: ${decision.action}${decision.branch ? `, branch=${decision.branch}` : ""}`);

  // 3. Get GitHub token for pushing
  let githubToken: string | undefined;
  const credentials = getGitHubAppCredentials();
  log.info(`GitHub App credentials: ${credentials ? "found" : "not found"}`);
  if (credentials) {
    try {
      log.info(`Generating installation token for installation ${credentials.installationId}...`);
      githubToken = await getInstallationToken(credentials);
      log.info("Got GitHub App installation token");
    } catch (err) {
      log.error("Failed to get GitHub token", err);
      throw new Error(`Failed to get GitHub token: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log.warn("No GitHub App credentials configured - clone may fail for private repos");
  }

  // 4. Run the task in sandbox
  const result = await runCodingTask(ctx.sandboxBinding, {
    repoUrl,
    task,
    previousState: previousState ?? undefined,
    decision,
    githubToken,
  });

  // 5. Save updated state
  saveCodingTaskState(ctx.sql, result.state);
  log.info(`Saved state: branch=${result.state.branch}, session=${result.state.sessionId}`);

  return {
    response: result.response,
    branch: result.state.branch,
  };
}
