/**
 * Factpicker API v0.1 — GraphQL over HTTP.
 *
 *   POST /graphql   { query, variables, operationName }
 *   GET  /healthz   liveness + dataset origin
 *   GET  /          tiny landing with a sample query
 *
 * Auth: if API_TOKEN is set, requests must send `x-api-key`. The service is a
 * read-only projection of recorded data; writes stay in the ETL pipelines.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execute, createContext } from "./app.ts";
import { createDataset, createEmbeddingClient, repoPath } from "./sources.ts";

const PORT = Number(process.env.PORT ?? 8787);
const API_TOKEN = process.env.API_TOKEN ?? "";
const MAX_BODY_BYTES = 256 * 1024;

const dataset = await createDataset();
const context = createContext(dataset, createEmbeddingClient());

const SAMPLE = readFileSync(repoPath("api/data/sample-query.graphql"), "utf8");

const cors = {
  "access-control-allow-origin": process.env.CORS_ORIGIN ?? "*",
  "access-control-allow-headers": "content-type, x-api-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...cors },
  body: JSON.stringify(body),
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const respond = ({ status, headers, body }: { status: number; headers: Record<string, string>; body: string }) => {
    res.writeHead(status, headers);
    res.end(body);
  };

  if (req.method === "OPTIONS") return respond({ status: 204, headers: cors, body: "" });

  if (req.method === "GET" && url.pathname === "/healthz") {
    return respond(json(200, {
      ok: true,
      version: "0.1.0",
      videos: dataset.videos.length,
      stanceRows: dataset.stance.length,
      events: dataset.events.events.length,
      origin: dataset.origin,
      embeddings: context.embeddings.available ? "vertex" : "offline",
    }));
  }

  if (req.method === "GET" && url.pathname === "/") {
    return respond({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", ...cors },
      body: `Factpicker API v0.1\nPOST /graphql\nGET /healthz\n\n${SAMPLE}`,
    });
  }

  if (req.method !== "POST" || url.pathname !== "/graphql") {
    return respond(json(404, { errors: [{ message: "not found" }] }));
  }

  if (API_TOKEN && req.headers["x-api-key"] !== API_TOKEN) {
    return respond(json(401, { errors: [{ message: "invalid or missing x-api-key", extensions: { code: "UNAUTHORIZED" } }] }));
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) {
      return respond(json(413, { errors: [{ message: "request body too large", extensions: { code: "PAYLOAD_TOO_LARGE" } }] }));
    }
  }

  let payload: { query?: string; variables?: Record<string, unknown>; operationName?: string };
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return respond(json(400, { errors: [{ message: "body must be JSON", extensions: { code: "BAD_REQUEST" } }] }));
  }
  if (!payload.query) {
    return respond(json(400, { errors: [{ message: "missing 'query'", extensions: { code: "BAD_REQUEST" } }] }));
  }

  const started = Date.now();
  try {
    const result = await execute({
      source: payload.query,
      variableValues: payload.variables,
      operationName: payload.operationName,
      context,
    });
    const status = result.errors?.length ? 200 : 200;
    return respond(json(status, {
      ...result,
      extensions: { ...(result.extensions ?? {}), durationMs: Date.now() - started, version: "0.1.0", requestId: crypto.randomUUID() },
    }));
  } catch (error) {
    console.error("[api] execution failed", error);
    return respond(json(500, { errors: [{ message: "internal error", extensions: { code: "INTERNAL" } }] }));
  }
});

server.listen(PORT, () => {
  console.log(`[api] v0.1.0 listening on http://localhost:${PORT}/graphql`);
  console.log(`[api] dataset: ${dataset.videos.length} videos, ${dataset.stance.length} stance rows, ${dataset.events.events.length} events`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
