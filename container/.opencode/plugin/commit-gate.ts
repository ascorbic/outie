/**
 * Commit Gate Plugin
 * 
 * Prevents OpenCode sessions from ending with uncommitted or unpushed changes.
 * When the session goes idle with a dirty git state, it sends a follow-up prompt
 * forcing the agent to commit and push before finishing.
 */

import type { Plugin } from "@opencode-ai/plugin"

export const CommitGatePlugin: Plugin = async ({ client, $ }) => {
  // Track prompts we've sent to avoid infinite loops
  // Key: sessionId:gitStateHash
  const prompted = new Set<string>()

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      // Handle both sessionID and sessionId property names
      const props = event.properties as Record<string, unknown> | undefined
      const sessionId = (props?.sessionID ?? props?.sessionId) as string | undefined
      if (!sessionId) return

      // Check git state
      let status = ""
      let branch = ""
      let unpushed = ""

      try {
        status = await $`git status --porcelain`.text()
      } catch {
        // Not in a git repo, nothing to do
        return
      }

      try {
        branch = (await $`git branch --show-current`.text()).trim()
      } catch {
        branch = "(detached)"
      }

      try {
        // Check for unpushed commits
        unpushed = await $`git log @{u}.. --oneline`.text()
      } catch {
        // No upstream set - this counts as "needs push"
        unpushed = "no-upstream"
      }

      const hasUncommitted = status.trim().length > 0
      const hasUnpushed = unpushed === "no-upstream" || unpushed.trim().length > 0

      if (!hasUncommitted && !hasUnpushed) {
        // Clean state - session can end normally
        // Clear any tracked prompts for this session
        for (const key of prompted) {
          if (key.startsWith(`${sessionId}:`)) {
            prompted.delete(key)
          }
        }
        return
      }

      // Create a hash of current state to detect if we've already prompted for this exact situation
      const stateHash = `${status.trim()}|${unpushed.trim()}`
      const promptKey = `${sessionId}:${stateHash}`

      if (prompted.has(promptKey)) {
        // Already prompted for this exact state - don't loop forever
        // This can happen if the agent fails to commit/push for some reason
        console.warn("[commit-gate] Session still dirty after prompt, allowing exit to prevent infinite loop")
        return
      }

      prompted.add(promptKey)
      console.log(`[commit-gate] Session ${sessionId} has uncommitted/unpushed changes, sending follow-up prompt`)

      // Build the prompt based on what's needed
      const issues: string[] = []
      if (hasUncommitted) {
        issues.push(`**Uncommitted changes:**\n\`\`\`\n${status.trim()}\n\`\`\``)
      }
      if (unpushed === "no-upstream") {
        issues.push(`**Branch has no upstream** - needs first push with \`git push -u origin ${branch}\``)
      } else if (hasUnpushed) {
        issues.push(`**Unpushed commits:**\n\`\`\`\n${unpushed.trim()}\n\`\`\``)
      }

      // Check if on main/master - this is not allowed
      const isProtectedBranch = branch === "main" || branch === "master"

      // Send follow-up prompt to force commit+push
      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: `## You cannot finish yet

You have uncommitted or unpushed changes that must be committed and pushed before this session can end.

**Current branch:** \`${branch}\`${isProtectedBranch ? ` ⚠️ **WARNING: You are on a protected branch!**` : ""}

${issues.join("\n\n")}

### Required actions:
${isProtectedBranch ? `
**IMPORTANT:** You must NOT commit directly to \`${branch}\`. First create a feature branch:
\`\`\`bash
git checkout -b innie/your-descriptive-branch-name
\`\`\`

Then:` : ""}
1. **Stage your changes**: \`git add -A\` (or stage specific files)
2. **Commit with a descriptive message**: Write a clear commit message explaining what was done and why
3. **Push to remote**: \`git push -u origin ${isProtectedBranch ? "YOUR_NEW_BRANCH" : branch}\`
4. **Verify success**: Confirm the push completed without errors

Run these git commands now. Do not just describe what to do - actually execute them.`
            }]
          }
        })
      } catch (err) {
        console.error("[commit-gate] Failed to send follow-up prompt:", err)
      }
    }
  }
}
