// OpenCode sandbox integration using @cloudflare/sandbox/opencode
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import { OpencodeClient, type Config, type TextPart } from "@opencode-ai/sdk";
import { env } from "cloudflare:workers";
import type { CodingTaskState, CodingTaskDecision } from "./types";

// Keep exporting the original `Sandbox` class name for compatibility.
// (Older deployments referenced this Durable Object class name.)
export { Sandbox } from "@cloudflare/sandbox";

// Export a distinct Sandbox class name with SQL enabled.
// IMPORTANT: this class must be created with `new_sqlite_classes` in wrangler migrations.
export { Sandbox as OutieSandbox } from "@cloudflare/sandbox";

// Type export for use in other modules
export type { Sandbox as OutieSandboxType } from "@cloudflare/sandbox";

// OpenCode model routing: Z.AI Coding Plan with GLM-4.7
// Uses zai-coding-plan provider (different from regular zai - requires GLM Coding Plan subscription)
// API key passed via ZAI_API_KEY env var in getOpencodeEnv()
function getOpencodeConfig(): Config {
  return {
    model: "zai-coding-plan/glm-4.7",
    provider: {
      zhipu: {
        options: {
          apiKey: env.ZAI_API_KEY 
        }
      }
    },
    // Don't specify local plugins here - they auto-load from ~/.config/opencode/plugin/
    // The plugin array is only for npm packages
    plugin: [],
    // Auto-allow all operations for autonomous mode
    permission: {
      edit: "allow",
      bash: "allow",
    },
  };
}

export interface CodingTaskOptions {
  repoUrl: string;
  task: string;
  model?: { providerID: string; modelID: string };
  // State from previous task (for continuation)
  previousState?: CodingTaskState;
  // Decision about how to handle this task
  decision: CodingTaskDecision;
  // GitHub token for pushing
  githubToken?: string;
}

export interface CodingTaskResult {
  response: string;
  // Return state for next invocation
  state: CodingTaskState;
}

// Wait for sandbox to be ready by polling
async function waitForSandboxReady(sandbox: ReturnType<typeof getSandbox>, maxAttempts = 30): Promise<void> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Try a simple operation to check if sandbox is ready
      await sandbox.exec("echo ready");
      console.log(`[SANDBOX] Ready after ${attempt} attempts`);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        throw new Error(`Sandbox not ready after ${maxAttempts} attempts: ${err}`);
      }
      console.log(`[SANDBOX] Waiting for sandbox to be ready (attempt ${attempt}/${maxAttempts})...`);
      await sleep(1000);
    }
  }
}

// Run a coding task using OpenCode in a sandbox
export async function runCodingTask(
  sandboxBinding: DurableObjectNamespace<Sandbox>,
  options: CodingTaskOptions,
): Promise<CodingTaskResult> {
  
  const sandbox = getSandbox(sandboxBinding, 'opencode') 
  console.log(`[SANDBOX] Created sandbox stub`);
  
  // Wait for sandbox to be ready
  await waitForSandboxReady(sandbox);

  // Set up GitHub token as env var if provided
  if (options.githubToken) {
    console.log(`[SANDBOX] Setting GITHUB_TOKEN env var`);
    await sandbox.setEnvVars({ GITHUB_TOKEN: options.githubToken });
    // Configure git to use the token for GitHub HTTPS URLs
    await sandbox.exec(
      `git config --global url."https://x-access-token:$GITHUB_TOKEN@github.com/".insteadOf "https://github.com/"`
    );
    console.log(`[SANDBOX] Git configured to use GITHUB_TOKEN`);
  }

  // Clone the repository
  const repoName = options.repoUrl.split("/").pop()?.replace(".git", "") ?? "repo";
  const targetDir = `/home/user/${repoName}`;

  console.log(`[SANDBOX] About to clone ${options.repoUrl} to ${targetDir}`);
  try {
    const exists = await sandbox.exists(targetDir)
    if(exists.exists) {
      console.log("[SANDBOX] Repo already exists, fetching latest")
      await sandbox.exec(`cd ${targetDir} && git fetch origin`);
    } else {
      // Clone - git config will handle auth via insteadOf
      const result = await sandbox.exec(`git clone --depth 1 ${options.repoUrl} ${targetDir}`);
      if (!result.success) {
        throw new Error(`Clone failed: ${result.stderr || result.stdout}`);
      }
      console.log(`[SANDBOX] Cloned ${options.repoUrl} to ${targetDir}`);
    }
  } catch (err) {
    console.error(`[SANDBOX] Clone failed:`, err);
    throw err;
  }

  // Handle branch management based on decision
  const targetBranch = options.decision.action === "new" 
    ? options.decision.branch! 
    : options.previousState!.branch;

  console.log(`[SANDBOX] Branch strategy: ${options.decision.action}, target: ${targetBranch}`);

  if (options.decision.action === "new") {
    // Create new branch from main/master
    console.log(`[SANDBOX] Creating new branch: ${targetBranch}`);
    try {
      // Try to get the default branch
      const defaultBranch = await sandbox.exec(
        `cd ${targetDir} && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main"`
      );
      const baseBranch = defaultBranch.stdout?.trim() || "main";
      
      // Checkout base branch and pull latest
      await sandbox.exec(`cd ${targetDir} && git checkout ${baseBranch} && git pull origin ${baseBranch}`);
      
      // Create and checkout new branch
      await sandbox.exec(`cd ${targetDir} && git checkout -b ${targetBranch}`);
    } catch (err) {
      console.error(`[SANDBOX] Failed to create branch:`, err);
      // Fallback: just create branch from current HEAD
      await sandbox.exec(`cd ${targetDir} && git checkout -b ${targetBranch}`);
    }
  } else {
    // Continue on existing branch
    console.log(`[SANDBOX] Continuing on branch: ${targetBranch}`);
    try {
      // Check if branch exists locally
      const branchExists = await sandbox.exec(
        `cd ${targetDir} && git show-ref --verify --quiet refs/heads/${targetBranch} && echo "yes" || echo "no"`
      );
      
      if (branchExists.stdout?.trim() === "yes") {
        await sandbox.exec(`cd ${targetDir} && git checkout ${targetBranch}`);
      } else {
        // Try to checkout from remote
        await sandbox.exec(`cd ${targetDir} && git checkout -b ${targetBranch} origin/${targetBranch}`);
      }
    } catch (err) {
      console.error(`[SANDBOX] Failed to checkout branch, creating fresh:`, err);
      await sandbox.exec(`cd ${targetDir} && git checkout -b ${targetBranch}`);
    }
  }

  // Remove project's .opencode directory to prevent loading its plugins
  // (plugins may have dependencies not installed in sandbox)
  const projectOpencode = `${targetDir}/.opencode`;
  const projectOpencodeExists = await sandbox.exists(projectOpencode);
  if (projectOpencodeExists.exists) {
    console.log(`[SANDBOX] Removing project .opencode directory to prevent plugin loading`);
    await sandbox.exec(`rm -rf ${projectOpencode}`);
  }

  // Create OpenCode client (starts server automatically if needed)
  console.log(`[SANDBOX] Creating OpenCode client in ${targetDir}`);
  const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
    directory: targetDir,
    config: getOpencodeConfig(),
  });
  console.log(`[SANDBOX] OpenCode server on port ${server.port}`);
  
  // Subscribe to events for debugging (fire and forget)
  client.event.subscribe({
    onSseEvent: (event: unknown) => console.log("[OPENCODE]", event)
  }).catch(() => { /* ignore subscription errors */ });

  // Try to continue existing session or create new one
  let sessionId: string;
  
  if (options.decision.action === "continue" && options.previousState?.sessionId) {
    console.log(`[SANDBOX] Attempting to continue session: ${options.previousState.sessionId}`);
    try {
      // Check if session exists
      const existingSession = await client.session.get({
        path: { id: options.previousState.sessionId }
      });
      
      if (existingSession.data) {
        sessionId = options.previousState.sessionId;
        console.log(`[SANDBOX] Continuing existing session: ${sessionId}`);
      } else {
        throw new Error("Session not found");
      }
    } catch (err) {
      console.log(`[SANDBOX] Previous session not found, creating new one`);
      const session = await client.session.create({
        body: { title: `Task: ${options.task.slice(0, 50)}` },
        query: { directory: targetDir },
      });
      if (!session.data) {
        throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
      }
      sessionId = session.data.id;
    }
  } else {
    // Create new session
    const session = await client.session.create({
      body: { title: `Task: ${options.task.slice(0, 50)}` },
      query: { directory: targetDir },
    });
    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }
    sessionId = session.data.id;
    console.log(`[SANDBOX] Created new session: ${sessionId}`);
  }

  // Build the prompt - note we now tell it to commit and push
  const prompt = `You are working in the ${repoName} repository on branch \`${targetBranch}\`.

<task>
${options.task}
</task>

Please implement the necessary changes. When you are done:
1. Stage and commit your changes with a clear, descriptive commit message
2. Push to the remote branch

The commit-gate plugin will prevent this session from ending until changes are committed and pushed.`;

  console.log(`[SANDBOX] Sending prompt to session ${sessionId}`);

  const result = await client.session.prompt({
    path: { id: sessionId },
    query: { directory: targetDir },
    body: {
      model: options.model ?? { providerID: "zai-coding-plan", modelID: "glm-4.7" },
      parts: [{ type: "text", text: prompt }],
    },
  });

  console.log(`[SANDBOX] Got response from session ${sessionId}`);

  // Extract text from response parts
  const parts = result.data?.parts ?? [];
  const response = parts
    .filter((p): p is TextPart => p.type === "text" && "text" in p)
    .map((p) => p.text ?? "")
    .join("\n");

  // Build state for next invocation
  const newState: CodingTaskState = {
    repoUrl: options.repoUrl,
    branch: targetBranch,
    sessionId,
    lastTask: options.task,
    lastTimestamp: Date.now(),
  };

  return {
    response,
    state: newState,
  };
}
