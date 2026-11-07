/**
 * CLI entry for the creator-stance ETL.
 *
 *   npm run stance -- --input data/oriane/top10-all.json
 *   npm run stance -- --input data/oriane/top10-all.json --vertex --max-vertex-calls 5
 *   npm run stance -- --write-supabase --write-bigquery
 *
 * In Cloud Run, the same file is the job command (`node pipeline/main.ts`) with
 * no --input, so it reads Supabase and writes Supabase + BigQuery.
 */
import { runEtl } from "./etl.ts";
import { describeStance } from "../supabase/functions/_shared/sentiment.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};

const explicitVertex = flag("vertex");
const maxVertexCalls = Number(value("max-vertex-calls", explicitVertex ? "25" : "0"));

const result = await runEtl({
  input: value("input"),
  out: value("out", "data/analyses/creator-stance.json")!,
  maxVertexCalls,
  minVideos: Number(value("min-videos", "2")),
  neutralBand: Number(value("neutral-band", "0.15")),
  writeSupabase: flag("write-supabase"),
  writeBigQuery: flag("write-bigquery"),
  project: value("project", process.env.GCP_PROJECT),
  location: value("location", process.env.VERTEX_LOCATION ?? "us-central1")!,
  model: value("model", process.env.VERTEX_MODEL ?? "gemini-2.5-flash")!,
  verbose: true,
});

console.log("\nStats:");
console.log(JSON.stringify(result.stats, null, 2));

console.log("\nStrongest creator × candidate rows:");
for (const row of result.rows.slice(0, 12)) {
  console.log(
    `  ${row.creator_handle.padEnd(24)} ${row.candidate_id.padEnd(14)} ` +
      `index=${String(row.stance_index).padStart(6)}  ${row.label.padEnd(18)} ${describeStance(row)}`,
  );
}

if (result.escalations.length) {
  console.log("\nEscalations:");
  console.log(JSON.stringify(result.escalations, null, 2));
}
