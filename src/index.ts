import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";

// Re-export the Durable Object
export { Outie } from "./outie";

const app = new Hono<{ Bindings: Env }>();

// CORS for local development
app.use("*", cors());

// Health check
app.get("/", (c) => {
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

export default app;
