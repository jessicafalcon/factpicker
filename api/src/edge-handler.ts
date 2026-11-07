/**
 * The HTTP handler used by the Supabase Edge Function. No Node built-ins, no
 * filesystem: the dataset and SDL are injected by the function entry point.
 */
import { buildSchema } from "graphql";
import { createContext } from "./context.ts";
import { makeExecutor } from "./execute.ts";
import type { Dataset } from "./sources.ts";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-api-key",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });

export interface HandlerOptions {
  dataset: Dataset;
  sdl: string;
  token?: string | null;
  version?: string;
}

export function createHandler({ dataset, sdl, token, version = "0.1.0" }: HandlerOptions) {
  const schema = buildSchema(sdl);
  const context = createContext(dataset, {
    available: false,
    embed: async () => {
      throw new Error("embeddings are not configured on this deployment");
    },
  } as any);
  const execute = makeExecutor(schema);

  return async function handler(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (token && request.headers.get("x-api-key") !== token) {
      return json({ errors: [{ message: "unauthorized" }] }, 401);
    }

    const url = new URL(request.url);
    if (request.method === "GET") {
      return json(
        {
          data: {
            apiVersion: version,
            dataset: { videos: dataset.videos.length, stanceRows: dataset.stance.length, events: dataset.events.events.length },
          },
        },
        200,
      );
    }
    if (request.method !== "POST") return json({ errors: [{ message: "method not allowed" }] }, 405);
    if (!url.pathname.endsWith("/graphql") && url.pathname !== "/") {
      // Supabase mounts the function at /functions/v1/graphql; anything else is a mistake.
      return json({ errors: [{ message: `unknown path ${url.pathname}` }] }, 404);
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ errors: [{ message: "invalid JSON body" }] }, 400);
    }
    if (typeof body?.query !== "string") return json({ errors: [{ message: "missing query" }] }, 400);

    try {
      const result = await execute({
        source: body.query,
        variableValues: body.variables ?? null,
        operationName: body.operationName ?? null,
        context,
      });
      return json(result, 200);
    } catch (error) {
      return json({ errors: [{ message: (error as Error).message }] }, 500);
    }
  };
}
