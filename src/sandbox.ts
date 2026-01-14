// OpenCode sandbox integration using @cloudflare/sandbox/opencode
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode,
  type OpencodeServer,
} from "@cloudflare/sandbox/opencode";
import type { Env } from "./types";

// OpenCode Config type (simplified)
interface OpencodeConfig {
  provider?: Record<string, unknown>;
  model?: string;
  permission?: { auto?: boolean };
}

// Re-export Sandbox for wrangler config
export { Sandbox } from "@cloudflare/sandbox";

// Build OpenCode config for CF AI Gateway with BYOK
function getOpencodeConfig(_env: Env): OpencodeConfig {
  return {
    provider: {
      "cloudflare-ai-gateway": {
        models: {
          "anthropic/claude-sonnet-4": {
            name: "Claude Sonnet 4",
          },
          "anthropic/claude-haiku-4": {
            name: "Claude Haiku 4",
          },
        },
      },
    },
    // Default model
    model: "cloudflare-ai-gateway/anthropic/claude-sonnet-4",
    // Auto-approve tool permissions for headless operation
    permission: {
      auto: true,
    },
  };
}

// Environment variables needed for CF AI Gateway in sandbox
function getOpencodeEnv(env: Env): Record<string, string> {
  return {
    CLOUDFLARE_ACCOUNT_ID: env.CF_ACCOUNT_ID,
    CLOUDFLARE_GATEWAY_ID: env.CF_AIG_GATEWAY_ID,
    CLOUDFLARE_API_TOKEN: env.CF_API_TOKEN,
  };
}

export interface CodingTaskResult {
  response: string;
  diff: string;
  sessionId: string;
}

// Run a coding task using OpenCode in a sandbox
export async function runCodingTask(
  sandboxBinding: DurableObjectNamespace<Sandbox>,
  env: Env,
  options: {
    repoUrl: string;
    task: string;
    sandboxId?: string;
    model?: { providerID: string; modelID: string };
  },
): Promise<CodingTaskResult> {
  const sandboxId = options.sandboxId ?? crypto.randomUUID().slice(0, 8);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox = getSandbox(sandboxBinding, sandboxId) as any;

  // Clone the repository
  const repoName =
    options.repoUrl.split("/").pop()?.replace(".git", "") ?? "repo";
  const targetDir = `/home/user/${repoName}`;

  await sandbox.gitCheckout(options.repoUrl, { targetDir });
  console.log(`[SANDBOX] Cloned ${options.repoUrl} to ${targetDir}`);

  // Set environment variables for AI Gateway
  await sandbox.setEnvVars(getOpencodeEnv(env));

  // Get OpenCode client - use any for client type since SDK types may vary
  const { client } = await createOpencode(sandbox, {
    directory: targetDir,
    config: getOpencodeConfig(env) as any,
  });

  // Cast client to expected interface
  const oc = client as {
    session: {
      create: (opts: { body: { title: string }; query: { directory: string } }) => Promise<{ data?: { id: string } }>;
      prompt: (opts: {
        path: { id: string };
        query: { directory: string };
        body: {
          model: { providerID: string; modelID: string };
          parts: Array<{ type: string; text: string }>;
        };
      }) => Promise<{ data?: { parts: Array<{ type: string; text?: string }> } }>;
      diff: (opts: {
        path: { id: string };
        query: { directory: string };
      }) => Promise<{ data?: Array<{ file: string; before: string; after: string }> }>;
    };
  };

  // Create a session
  const session = await oc.session.create({
    body: { title: `Task: ${options.task.slice(0, 50)}` },
    query: { directory: targetDir },
  });

  if (!session.data) {
    throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
  }

  console.log(`[SANDBOX] Created session ${session.data.id}`);

  // Build the prompt
  const prompt = `You are working in the ${repoName} repository.

Task: ${options.task}

Please implement the necessary changes. Do not commit - just make the edits.`;

  // Send prompt and wait for response
  const result = await oc.session.prompt({
    path: { id: session.data.id },
    query: { directory: targetDir },
    body: {
      model: options.model ?? {
        providerID: "cloudflare-ai-gateway",
        modelID: "anthropic/claude-sonnet-4",
      },
      parts: [{ type: "text", text: prompt }],
    },
  });

  // Extract response text
  const parts = result.data?.parts ?? [];
  const textParts = parts.filter((p) => p.type === "text" && p.text);
  const response = textParts.map((p) => p.text ?? "").join("\n");

  // Get the diff
  const diffResult = await oc.session.diff({
    path: { id: session.data.id },
    query: { directory: targetDir },
  });

  // Format as simple diff output
  const diff =
    diffResult.data
      ?.map((f) => `--- a/${f.file}\n+++ b/${f.file}\n${f.after}`)
      .join("\n\n") ?? "";

  return {
    response,
    diff,
    sessionId: session.data.id,
  };
}

// Proxy requests to OpenCode web UI (for interactive use)
export async function handleOpencodeProxy(
  request: Request,
  sandboxBinding: DurableObjectNamespace<Sandbox>,
  env: Env,
  options: {
    sandboxId?: string;
    directory?: string;
  } = {},
): Promise<Response> {
  const sandboxId = options.sandboxId ?? "opencode-ui";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox = getSandbox(sandboxBinding, sandboxId) as any;
  const directory = options.directory ?? "/home/user/workspace";

  // Set environment variables
  await sandbox.setEnvVars(getOpencodeEnv(env));

  // Start OpenCode server
  const server: OpencodeServer = await createOpencodeServer(sandbox, {
    directory,
    config: getOpencodeConfig(env) as any,
  });

  // Proxy the request
  return proxyToOpencode(request, sandbox, server);
}
