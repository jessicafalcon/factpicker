# Factpicker — 2027 presidential video barometer

A newsroom tool that follows what creators *say* about candidates: the fact they
cite, the interpretation they attach to it, and the verdict they aim at a
candidate.



## Team members 

- [Jessica] — Full-Stack / Prompt Engineer
- [Dhruv] — Backend / solutions architect + AI engineer


## Repository map

| Path | What it is |
|---|---|
| `data/oriane/` | Combined Oriane snapshot (`top10-all.json`): 217 videos, 209 French. Per-candidate dumps are gitignored |
| `data/analyses/` | Derived artifacts: stance, timelines, events, gold set, runs/ history |
| `scripts/` | Ingestion + derivation commands, and the one-command backend trace (`npm run demo:backend`) |
| `supabase/` | Migrations (read models, RLS) and edge functions |
| `pipeline/` | Cloud Run ETL (stance) + BigQuery deploy |
| `api/` | **GraphQL API v0.1** — the composable read layer |
| `web-demo/` | **Next.js Story page** — hero + Anatomy card, live from the API |
| `docs/` | Query playbook, stance analysis, events, API contract |
| `aidlc-docs/` | Inception → Construction → Operations record |

## Commands

```bash
npm run demo:backend     # cloud telemetry → ETL → vector DB → LLM → GraphQL → handoff
npm run demo:backend -- --live          # + one real Vertex classification
npm run demo:backend -- --offline       # no network; cached/local evidence only
npm run events           # regenerate events.json + events.csv (no API calls)
npm run timeline         # timeline statistics
npm run stance:candidates# stance artifact (uses cached Gemini verdicts)
npm run anatomy          # -> data/analyses/anatomy.json (entry-page cards)
npm run test:all         # 76 artifact tests + 40 API tests
npm run api:dev          # GraphQL server on :8787
cd web-demo && npm run dev   # Story page on :3000 (see web-demo/README.md)
```

## Backend trace

`npm run demo:backend` is the backend half of the pitch, in one call. It prints,
in order: the real cloud footprint (BigQuery `creator_stance` + its 331-row LOAD
job, Vertex, Supabase GraphQL/REST, Cloud Run), then extract → transform
(tags, embeddings/vector DB, batched LLM with quote verification, stance) →
derive (anatomy, facts/readings, timeline) → load (local artifact, Supabase
mirror, BigQuery) → the live GraphQL edge and the local executor with parity →
the exact payload the frontend consumes.

The trace is honest about what it cannot prove: `cadrage2027-stance` is not
deployed as a Cloud Run job in this project, so it prints `MISSING`; Supabase's
new logs endpoint returns a backend error, so request telemetry is captured from
the live calls instead. Probe results are cached in
`data/analyses/telemetry-cache.json`; `--refresh` forces new ones. The runbook
and the video storyboard are in `docs/backend-demo.md`.

## What is verified

- 116 tests passing (76 offline + 40 API, incl. a live HTTP round-trip and the
  anatomy offset/legend invariants).
- Events: 20 events, 6 scandals, 7 major-issue groups, 123/209 videos covered.
- Stance: 273 video×candidate verdicts, 214 with verified quotes.
- API: contract frozen at 0.1.0; see `docs/api-v0.1.md` and `docs/anatomy-api.md`.
- Anatomy: 211 items, 18 with all three steps, 6 entry cards (quality ≥ 0.6).

## Configuration

Nothing is hard-coded: every deployment target, project ref and key comes from
the environment. Copy the template and fill it in locally — `.env` is gitignored
and must never be committed.

```bash
cp .env.example .env
```

| Variable | Used by | Notes |
|---|---|---|
| `ORIANE_API` | ingestion | server-side only |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | data mirror, edge bundle | service role bypasses RLS — server only |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` | deploy, mirror | personal access token; never shipped |
| `API_URL` | web app | the GraphQL endpoint for the deployment |
| `GCP_PROJECT`, `VERTEX_LOCATION`, `VERTEX_MODEL` | ETL, ablation | Vertex AI project |
| `GRAPHQL_TOKEN` | edge function | optional `x-api-key` gate |

## Deployment

The deployment is reproducible from source; no account identifiers live in the
repository.

- **GraphQL function** — `npm run edge:build && npm run edge:deploy` (needs
  `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`). Runbook: `supabase/README.md`.
- **Data mirror** — `npm run db:mirror` writes the read models into your project.
- **Web app** — deploy `web-demo/` wherever you host Next.js and set `API_URL`.
  Notes: `web-demo/README.md`.

See `SECURITY.md` for the policy on secrets and what is deliberately excluded.

## Honest limits

- The sample is 217 videos, not a poll; every surface must say "sample".
- The RN congress in Orléans is **not** in the snapshot (0 hits) and is not invented.
- `Fact.verified` is false until a journalist checks the anchor against its source.
