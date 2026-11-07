# Backend trace — one command, real evidence

The demo entry point for the backend half of the pitch.

```bash
npm run demo:backend
```

It runs the whole chain in order and prints it as a terminal narrative:

```
cloud telemetry
  → extract (Oriane snapshot)
  → transform (tags → embeddings/vector DB → LLM batch → stance)
  → derive (anatomy → facts/readings → fact timeline)
  → load (local artifact → Supabase mirror → BigQuery)
  → read (live GraphQL edge + local parity)
  → handoff (the contract the frontend consumes)
```

No frontend is required. The trace ends at the exact JSON contract the Story /
Facts / Timeline pages consume.

---

## 1. What is real

Measured on 2026-11-07 against the current project:

| Surface | Evidence | How the trace shows it |
|---|---|---|
| BigQuery `cadrage2027.creator_stance` | 331 rows, 13 fields | `tables.get` live probe |
| BigQuery LOAD job | 331 rows out, 94,919 B in, 38,652 B out, 1.11 s | `jobs.get LOAD` |
| BigQuery job history | 7-day `INFORMATION_SCHEMA.JOBS_BY_PROJECT` | live query |
| Supabase GraphQL edge | `v0.1.0`, 217 videos, 273 stance rows, 20 events | live POST + stage 11 |
| Supabase mirror | `fp_videos` 217 · `fp_stance` 273 · `fp_facts` 6 · `fp_timelines` 6 · `fp_anatomy` 6 · `fp_behind` 6 | PostgREST `count=exact` |
| Vertex AI | one bounded `gemini-2.5-flash` call, ~1.9 s, 1,081 tokens, verified quote | `--live` |
| Vertex batch artifact | 273 verdicts, 209 videos, 230 exact quotes | `.vertex-cache.json` audit |
| Vector DB | 209 vectors × 3,072 dims, SQLite, persisted | stage 04 |
| Local ETL | 331 creator×candidate rows, 137 creators, 0 model calls | stage 10 |

### What is deliberately reported as missing

`cadrage2027-stance` is **not** deployed as a Cloud Run job in
`your-gcp-project` (checked in `europe-west1` and `us-central1`).
The trace prints `MISSING` rather than inventing an execution. The load is real
in BigQuery; the runner was local.

Supabase's new ClickHouse `logs` endpoint returns a backend error for this
project, so request-level evidence comes from the live GraphQL/REST calls
(status, latency, row counts), not from the log explorer.

---

## 2. Modes

| Command | Behaviour |
|---|---|
| `npm run demo:backend` | live read-only probes when credentials exist; otherwise replay the telemetry cache |
| `npm run demo:backend -- --refresh` | force fresh BigQuery / Cloud Run / Logging / Supabase probes |
| `npm run demo:backend -- --live` | + one real Vertex classification (bounded) |
| `npm run demo:backend -- --live-embeddings --embed-limit 24` | use `gemini-embedding-001` for a bounded sample; the cache makes reruns free |
| `npm run demo:backend -- --offline` | no network; local artifacts + telemetry cache only |
| `npm run demo:backend -- --skip-etl` | keep the existing ETL artifact (fast rehearsal) |

Useful flags: `--fact <id>`, `--video <id>`, `--query "..."`, `--limit N`,
`--width N`, `--no-color`.

---

## 3. Pre-demo checklist

```bash
# 1. credentials for the live probes and the optional model call
gcloud auth application-default login
gcloud config set project your-gcp-project

# 2. warm the telemetry cache while the network is good
npm run demo:backend -- --refresh --skip-etl

# 3. rehearse the full run once (writes the 331-row ETL artifact)
npm run demo:backend

# 4. optional: prove a real model call on camera
npm run demo:backend -- --live --max-calls 1
```

The first `--live-embeddings` run spends the embedding calls; later runs read
`api/.cache/embeddings.json`. Do not run it cold on stage.

---

## 4. Video storyboard (≈7 minutes)

| Time | Stage | Say this |
|---|---|---|
| 0:00 | boot | "One command. The data behind GraphQL, from the cloud log to the frontend contract." |
| 0:30 | 01 cloud telemetry | Point at the real BigQuery LOAD: 331 rows, 1.11 s. Point at Vertex: 1.9 s, 1,081 tokens, quote verified. Then point at Cloud Run: missing — we report it. |
| 1:30 | 02 extract | 31 candidate files → 281 rows → 217 unique → 209 French. Oriane is never called here. |
| 2:00 | 03 tag | Accent folding, alias matching, sentence anchoring, negation. 162 weighted markers; only 2/40 sampled rows keep the deterministic label. |
| 2:45 | 04 embed | 209 vectors, 3,072 dims, one SQLite file. The closest pair is a repost at 1.000. |
| 3:30 | 05 LLM | One call per video, not per pair; 64 pair verdicts saved. 230 quotes pass the substring check; 26 are rejected or recovered. |
| 4:15 | 06 stance | 273 video×candidate rows, 232 decisive. "Posts, not people." |
| 4:45 | 07 anatomy | One video cut into fact → meaning → verdict. Every slice is a verbatim substring with offsets. |
| 5:20 | 08 facts | One fact → five readings → for/against/none. 17.6 / 35.3 / 47.1. |
| 5:50 | 09 timeline | When the fact came up, with citations per moment. |
| 6:10 | 10 load | 331 rows written locally; Supabase counts; BigQuery LOAD verified. "This trace does not rewrite shared state." |
| 6:35 | 11 GraphQL | Live edge 2.1 s, local 20 ms, identical fields. |
| 6:50 | 12 handoff | The exact payload the frontend renders. "The backend ends here." |

---

## 5. Artifacts

| Path | Contents |
|---|---|
| `data/analyses/backend-trace.json` | the full machine-readable run report |
| `data/analyses/telemetry-cache.json` | real probe results + capture timestamp |
| `data/analyses/vertex-telemetry.json` | last live Vertex call: latency, usage, request id |
| `data/analyses/runs/backend-trace/creator-stance.json` | the 331-row ETL output |
| `data/analyses/vector-index.db` | 209 × 3,072 SQLite vector store |
| `api/.cache/embeddings.json` | Vertex embedding cache (when `--live-embeddings` is used) |

## 6. Tests

```bash
npm run test:unit    # includes vector-store persistence/search
npm run api:test     # GraphQL contract
npm run test:all
```
