/**
 * Standalone HTTP API server for testing the system in Postman, curl, or browser.
 */
import http from "node:http";
import { URL } from "node:url";
import { startMockProvider, type ProviderMode, validFixture } from "../src/provider.js";
import { TicketStore, deterministicSuggestion, type Ticket } from "../src/tickets.js";
import { suggest } from "../src/suggestionService.js";
import { CircuitBreaker, Metrics } from "../src/metrics.js";

const PORT = Number(process.env.PORT) || 3000;

const ticketStore = new TicketStore();
ticketStore.seed();

let metrics = new Metrics();
let breaker = new CircuitBreaker();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data, null, 2));
}

export function createApiServer(): http.Server {
  return http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. GET /api/tickets - List all sample tickets
      if (req.method === "GET" && pathname === "/api/tickets") {
        const refund = ticketStore.get("t-refund");
        const general = ticketStore.get("t-general");
        return sendJson(res, 200, {
          tickets: [refund, general],
          note: "You can pass either ticketId (e.g. 't-refund') or a custom ticket object in POST /api/suggest",
        });
      }

      // 2. GET /api/metrics - Inspect rolling window and circuit breaker state
      if (req.method === "GET" && pathname === "/api/metrics") {
        const snap = metrics.snapshot();
        return sendJson(res, 200, {
          breakerState: breaker.state(),
          allowsCall: breaker.allowCall(),
          snapshot: snap,
        });
      }

      // 3. POST /api/breaker/reset - Reset breaker and metrics for fresh testing
      if (req.method === "POST" && pathname === "/api/breaker/reset") {
        metrics = new Metrics();
        breaker = new CircuitBreaker();
        return sendJson(res, 200, {
          message: "Circuit breaker and metrics reset successfully",
          breakerState: breaker.state(),
        });
      }

      // 4. POST /api/suggest - Run reply suggestion flow
      if (req.method === "POST" && pathname === "/api/suggest") {
        const rawBody = await readBody(req);
        let parsedBody: Record<string, unknown> = {};
        if (rawBody.trim().length > 0) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            return sendJson(res, 400, { error: "Invalid JSON in request body" });
          }
        }

        const mode: ProviderMode = (parsedBody.mode as ProviderMode) || "valid";
        const flagEnabled = parsedBody.flagEnabled !== false;

        // Resolve ticket: either custom ticket object or seeded ticket by id
        let ticket: Ticket;
        if (parsedBody.ticket && typeof parsedBody.ticket === "object") {
          ticket = parsedBody.ticket as Ticket;
        } else {
          const ticketId = (parsedBody.ticketId as string) || "t-refund";
          try {
            ticket = ticketStore.get(ticketId);
          } catch {
            return sendJson(res, 404, { error: `Ticket not found: ${ticketId}` });
          }
        }

        // 1. Immediate deterministic suggestion (never awaits LLM)
        const detStart = performance.now();
        const fallback = deterministicSuggestion(ticket);
        const detElapsedMs = Math.max(0, Math.round(performance.now() - detStart));

        // 2. Start mock provider in the requested mode
        const provider = await startMockProvider(mode);

        try {
          const result = await suggest(ticket, provider.url, {
            flagEnabled,
            breaker,
            metrics,
          });

          const finalSuggestion =
            result.status === "suggestion" ? result.suggestion : fallback;

          return sendJson(res, 200, {
            mode,
            flagEnabled,
            ticket,
            outboundMaskedBody: provider.lastRequestBody
              ? JSON.parse(provider.lastRequestBody)
              : null,
            deterministicFallback: {
              readyInMs: detElapsedMs,
              suggestion: fallback,
            },
            llmResult: result,
            finalDisplayedSuggestion: finalSuggestion,
            breakerState: breaker.state(),
            metricsSnapshot: metrics.snapshot(),
          });
        } finally {
          await provider.close();
        }
      }

      // 5. GET /api/fixture/valid - Raw fixture inspection
      if (req.method === "GET" && pathname === "/api/fixture/valid") {
        return sendJson(res, 200, validFixture());
      }

      // 404 Not Found
      return sendJson(res, 404, {
        error: "Route not found",
        availableRoutes: [
          "GET  /api/tickets",
          "GET  /api/metrics",
          "POST /api/breaker/reset",
          "POST /api/suggest",
          "GET  /api/fixture/valid",
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, { error: "Internal server error", message });
    }
  });
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"))
) {
  const server = createApiServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`\n======================================================`);
    console.log(`🚀 LLM Contract Testing API Server Running!`);
    console.log(`📍 Endpoint: http://127.0.0.1:${PORT}`);
    console.log(`------------------------------------------------------`);
    console.log(`Try these endpoints in Postman:`);
    console.log(`  POST http://127.0.0.1:${PORT}/api/suggest`);
    console.log(`  GET  http://127.0.0.1:${PORT}/api/tickets`);
    console.log(`  GET  http://127.0.0.1:${PORT}/api/metrics`);
    console.log(`  POST http://127.0.0.1:${PORT}/api/breaker/reset`);
    console.log(`======================================================\n`);
  });
}

