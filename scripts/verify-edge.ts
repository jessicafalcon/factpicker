/** Runs the built edge bundle in Node to prove it serves queries before deploy. */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "../supabase/functions/graphql/_bundle.js";
import { SDL } from "../supabase/functions/graphql/schema.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataset = JSON.parse(readFileSync(resolve(ROOT, "supabase/functions/graphql/dataset.json"), "utf8"));
const handler = createHandler({ dataset, sdl: SDL });

const call = async (method: string, body?: unknown) => {
  const response = await handler(
    new Request("https://example.supabase.co/functions/v1/graphql", {
      method,
      headers: { "content-type": "application/json", origin: "https://lovable.app" },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: response.status, cors: response.headers.get("access-control-allow-origin"), body: await response.json() };
};

const health = await call("GET");
const preflight = await handler(new Request("https://example.supabase.co/functions/v1/graphql", { method: "OPTIONS" }));
const query = await call("POST", {
  query: `{ apiVersion dataset { videos } factTimeline(factId: "education_budget_2027") { months moments { date label videos hasSelectedFact verdicts { forCandidate againstCandidate noSide } } } }`,
});

const timeline = (query.body as any).data?.factTimeline;
const ok =
  health.status === 200 &&
  preflight.status === 204 &&
  query.status === 200 &&
  timeline?.moments?.length > 0 &&
  health.cors === "*";

console.log(JSON.stringify({
  ok,
  health: { status: health.status, cors: health.cors, data: health.body.data },
  preflight: preflight.status,
  query: {
    status: query.status,
    errors: (query.body as any).errors ?? null,
    months: timeline?.months,
    moments: timeline?.moments?.length,
    first: timeline?.moments?.[0],
  },
}, null, 2));
if (!ok) process.exit(1);
