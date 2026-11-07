// Supabase Edge Function entry (Deno). Everything it needs is in this folder:
// _bundle.js (executor + resolvers + graphql-js), schema.ts and dataset.json.
import { createHandler } from "./_bundle.js";
import { SDL } from "./schema.ts";
import dataset from "./dataset.json" with { type: "json" };

const handler = createHandler({
  dataset: dataset as any,
  sdl: SDL,
  token: Deno.env.get("GRAPHQL_TOKEN") ?? null,
});

Deno.serve(handler);
