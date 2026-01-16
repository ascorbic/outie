/**
 * MCP Bridge Server
 * 
 * Runs inside the container and bridges OpenCode's MCP requests to the DO.
 * 
 * Architecture:
 * 1. Serves HTTP MCP endpoint on localhost:8787 for OpenCode
 * 2. Accepts WS connection from DO on port 8788
 * 3. When OpenCode sends MCP request, forwards via WS to DO
 * 4. DO processes request (has SQLite access), returns response via WS
 * 5. Bridge returns response to OpenCode
 * 
 * The DO initiates the WS connection, so no Access auth needed.
 */

import { serve, type ServerWebSocket } from 'bun';

const MCP_HTTP_PORT = 8787;
const WS_PORT = 8788;

// Pending requests waiting for DO response
const pendingRequests = new Map<string, {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
}>();

// WebSocket connection to DO (DO connects to us)
let doConnection: ServerWebSocket<unknown> | null = null;

// =============================================================================
// WebSocket Server (for DO to connect to)
// =============================================================================

const wsServer = serve({
  port: WS_PORT,
  fetch(req, server) {
    // Upgrade to WebSocket
    const upgraded = server.upgrade(req);
    if (!upgraded) {
      return new Response('Expected WebSocket', { status: 426 });
    }
    return undefined as unknown as Response;
  },
  websocket: {
    open(ws) {
      console.log('[MCP Bridge] DO connected via WebSocket');
      doConnection = ws;
    },
    message(ws, message) {
      // Response from DO
      try {
        const data = JSON.parse(message.toString());
        const { requestId, response, error } = data;
        
        const pending = pendingRequests.get(requestId);
        if (pending) {
          pendingRequests.delete(requestId);
          if (error) {
            pending.reject(new Error(error));
          } else {
            pending.resolve(response);
          }
        }
      } catch (e) {
        console.error('[MCP Bridge] Failed to parse WS message:', e);
      }
    },
    close(ws) {
      console.log('[MCP Bridge] DO disconnected');
      if (doConnection === ws) {
        doConnection = null;
      }
      // Reject all pending requests
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error('DO connection closed'));
        pendingRequests.delete(id);
      }
    },
    error(ws, error) {
      console.error('[MCP Bridge] WebSocket error:', error);
    },
  },
});

console.log(`[MCP Bridge] WebSocket server listening on port ${WS_PORT}`);

// =============================================================================
// HTTP MCP Server (for OpenCode to connect to)
// =============================================================================

async function forwardToDO(jsonRpcRequest: unknown): Promise<unknown> {
  if (!doConnection) {
    throw new Error('DO not connected');
  }

  const requestId = crypto.randomUUID();
  
  return new Promise((resolve, reject) => {
    // Set timeout
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timeout'));
    }, 30000);

    pendingRequests.set(requestId, {
      resolve: (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });

    // Send to DO
    doConnection!.send(JSON.stringify({
      requestId,
      request: jsonRpcRequest,
    }));
  });
}

const httpServer = serve({
  port: MCP_HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        doConnected: doConnection !== null,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // MCP endpoint
    if (url.pathname === '/mcp' || url.pathname === '/') {
      if (req.method === 'POST') {
        try {
          const body = await req.json();
          
          if (!doConnection) {
            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id: (body as { id?: unknown }).id ?? null,
              error: { code: -32000, message: 'DO not connected' },
            }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const response = await forwardToDO(body);
          
          // Pass through session header if present in response
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          
          return new Response(JSON.stringify(response), { headers });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: error },
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      if (req.method === 'GET') {
        // SSE endpoint for server-initiated messages (not used but part of spec)
        return new Response(null, { status: 405 });
      }

      if (req.method === 'DELETE') {
        // Session termination - forward to DO
        try {
          await forwardToDO({ method: 'session/terminate' });
          return new Response(null, { status: 204 });
        } catch {
          return new Response(null, { status: 500 });
        }
      }
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`[MCP Bridge] HTTP MCP server listening on port ${MCP_HTTP_PORT}`);
console.log('[MCP Bridge] Waiting for DO connection...');
