import { Hono } from "hono";
import { cors } from "hono/cors";
import { html } from "hono/html";
import type { Env } from "./types";
import { runCodingTask } from "./sandbox";
import {
  verifyWebhook,
  sendMessage,
  sendTypingIndicator,
  type TelegramUpdate,
} from "./telegram";

// Re-export Durable Objects (Workflow removed - not compatible with Containers yet)
export { Outie } from "./outie";
export { Sandbox, OutieSandbox } from "./sandbox";

const app = new Hono<{ Bindings: Env }>();

// CORS for local development
app.use("*", cors());

// Web UI
app.get("/", (c) => {
  return c.html(html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Outie</title>
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }
          body {
            font-family:
              system-ui,
              -apple-system,
              sans-serif;
            background: #0a0a0a;
            color: #e5e5e5;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
          }
          .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            flex: 1;
            display: flex;
            flex-direction: column;
          }
          h1 {
            font-size: 1.5rem;
            margin-bottom: 20px;
            color: #fff;
          }
          .messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px 0;
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .message {
            padding: 12px 16px;
            border-radius: 12px;
            max-width: 80%;
            line-height: 1.5;
          }
          .message.user {
            background: #2563eb;
            align-self: flex-end;
          }
          .message.assistant {
            background: #262626;
            align-self: flex-start;
          }
          .message pre {
            background: #171717;
            padding: 8px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 8px 0;
          }
          .input-area {
            display: flex;
            gap: 12px;
            padding: 20px 0;
            border-top: 1px solid #262626;
          }
          input[type="text"] {
            flex: 1;
            padding: 12px 16px;
            border: 1px solid #404040;
            border-radius: 8px;
            background: #171717;
            color: #fff;
            font-size: 1rem;
          }
          input[type="text"]:focus {
            outline: none;
            border-color: #2563eb;
          }
          button {
            padding: 12px 24px;
            background: #2563eb;
            color: #fff;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            cursor: pointer;
          }
          button:hover {
            background: #1d4ed8;
          }
          button:disabled {
            background: #404040;
            cursor: not-allowed;
          }
          .memory {
            font-size: 0.875rem;
            color: #a3a3a3;
            padding: 12px;
            background: #171717;
            border-radius: 8px;
            margin-bottom: 20px;
          }
          .memory h3 {
            color: #fff;
            margin-bottom: 8px;
          }
          .memory-block {
            margin: 8px 0;
          }
          .memory-block-label {
            color: #60a5fa;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Outie</h1>
          <div id="memory" class="memory"></div>
          <div id="messages" class="messages"></div>
          <div class="input-area">
            <input
              type="text"
              id="input"
              placeholder="Type a message..."
              autofocus
            />
            <button id="send">Send</button>
          </div>
        </div>
        <script>
          const messagesEl = document.getElementById("messages");
          const inputEl = document.getElementById("input");
          const sendBtn = document.getElementById("send");
          const memoryEl = document.getElementById("memory");

          async function loadMemory() {
            try {
              const res = await fetch("/memory");
              const data = await res.json();
              let html = "<h3>Memory</h3>";
              for (const [key, block] of Object.entries(data)) {
                if (block.value) {
                  html +=
                    '<div class="memory-block"><span class="memory-block-label">' +
                    key +
                    ":</span> " +
                    block.value.substring(0, 100) +
                    (block.value.length > 100 ? "..." : "") +
                    "</div>";
                }
              }
              memoryEl.innerHTML = html;
            } catch (e) {
              console.error("Failed to load memory:", e);
            }
          }

          function addMessage(role, content) {
            const div = document.createElement("div");
            div.className = "message " + role;
            div.textContent = content;
            messagesEl.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }

          async function sendMessage() {
            const message = inputEl.value.trim();
            if (!message) return;

            inputEl.value = "";
            sendBtn.disabled = true;
            addMessage("user", message);

            try {
              const res = await fetch("/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message }),
              });
              const data = await res.json();
              addMessage("assistant", data.response || "No response");
              loadMemory();
            } catch (e) {
              addMessage("assistant", "Error: " + e.message);
            } finally {
              sendBtn.disabled = false;
              inputEl.focus();
            }
          }

          sendBtn.addEventListener("click", sendMessage);
          inputEl.addEventListener("keypress", (e) => {
            if (e.key === "Enter") sendMessage();
          });

          loadMemory();
        </script>
      </body>
    </html>
  `);
});

// Health check
app.get("/health", (c) => {
  return c.json({
    name: "outie",
    status: "ok",
    version: "0.1.0",
  });
});

// Route to Durable Object
// Default to a single instance for now (personal agent)
app.all("/agent/*", async (c) => {
  const id = c.env.OUTIE.idFromName("default");
  const stub = c.env.OUTIE.get(id);

  // Strip /agent prefix
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/agent", "");

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Simple chat endpoint that forwards to DO
app.post("/chat", async (c) => {
  const id = c.env.OUTIE.idFromName("default");
  const stub = c.env.OUTIE.get(id);

  const body = await c.req.json<{ message: string }>();

  const response = await stub.fetch(
    new Request("http://internal/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return response;
});

// Get memory blocks
app.get("/memory", async (c) => {
  const id = c.env.OUTIE.idFromName("default");
  const stub = c.env.OUTIE.get(id);

  return stub.fetch(new Request("http://internal/memory"));
});

// Get reminders
app.get("/reminders", async (c) => {
  const id = c.env.OUTIE.idFromName("default");
  const stub = c.env.OUTIE.get(id);

  return stub.fetch(new Request("http://internal/reminders"));
});

// Reset conversation history
app.post("/reset", async (c) => {
  const id = c.env.OUTIE.idFromName("default");
  const stub = c.env.OUTIE.get(id);

  return stub.fetch(new Request("http://internal/reset", { method: "POST" }));
});


// ==========================================
// Telegram Bot webhook
// ==========================================

// Allowed Telegram user IDs (add more as needed)
const ALLOWED_TELEGRAM_USERS = new Set([
  99498607, // Matt
]);

app.post("/telegram", async (c) => {
  // Verify request is from Telegram
  if (!verifyWebhook(c.req.raw, c.env)) {
    console.warn("[TELEGRAM] Webhook verification failed");
    return c.json({ ok: false }, 401);
  }

  try {
    const update: TelegramUpdate = await c.req.json();

    // Only process messages
    if (!update.message?.text) {
      return c.json({ ok: true });
    }

    const { message } = update;
    const userId = message.from.id;
    const chatId = message.chat.id;
    const text = message.text;

    console.log(`[TELEGRAM] Message from ${message.from.username ?? userId}: ${text?.slice(0, 50)}`);

    // Access control - check if user is allowed
    if (!ALLOWED_TELEGRAM_USERS.has(userId)) {
      console.warn(`[TELEGRAM] Unauthorized user: ${userId}`);
      // Silent ignore for unauthorized users
      return c.json({ ok: true });
    }

    // Show typing indicator immediately
    await sendTypingIndicator(c.env, chatId);

    // Forward to Outie
    const id = c.env.OUTIE.idFromName("default");
    const stub = c.env.OUTIE.get(id);

    const outieResponse = await stub.fetch(
      new Request("http://internal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      }),
    );

    const data = await outieResponse.json<{ response: string }>();

    // Send response back to Telegram
    await sendMessage(c.env, chatId, data.response, {
      replyToMessageId: message.message_id,
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error(`[TELEGRAM] Error processing update: ${error}`);
    return c.json({ ok: true }); // Always return 200 to Telegram
  }
});

// Run a coding task synchronously.
// Client should use a long timeout (5-10 minutes).
// Routes through Outie DO for state management.
app.post("/code", async (c) => {
  const id = c.env.OUTIE.idFromName("default");
  const stub = c.env.OUTIE.get(id);

  // Forward to DO
  const response = await stub.fetch(
    new Request("http://internal/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await c.req.json()),
    }),
  );

  return response;
});


// // Proxy to OpenCode web UI
// // Browse to /opencode/ for interactive coding
// app.all("/opencode/*", async (c) => {
//   // Strip /opencode prefix for the proxy
//   const url = new URL(c.req.url);
//   const path = url.pathname.replace(/^\/opencode/, "") || "/";
//   const newUrl = new URL(path + url.search, url.origin);
//   const request = new Request(newUrl.toString(), c.req.raw);

//   return handleOpencodeProxy(request, c.env.SANDBOX, c.env, {
//     directory: "/home/user/workspace",
//   });
// });

export default app;
