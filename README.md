# Factpicker — 2027 presidential video barometer

A newsroom tool that follows what creators *say* about candidates: the fact they
cite, the interpretation they attach to it, and the verdict they aim at a
candidate. Product brief: `docs/Social video barometer.pdf`.

## Repository map

| Path | What it is |
|---|---|
| `data/oriane/` | Oriane snapshot: 31 candidate files, 217 videos (209 French) |
| `data/analyses/` | Derived artifacts: stance, timelines, events, gold set, runs/ history |
| `scripts/` | Ingestion + derivation commands (`npm run <cmd>`) |
| `supabase/` | Migrations (read models, RLS) and edge functions |
| `pipeline/` | Cloud Run ETL (stance) + BigQuery deploy |
| `api/` | **GraphQL API v0.1** — the composable read layer |
| `docs/` | Query playbook, stance analysis, events, API contract |
| `aidlc-docs/` | Inception → Construction → Operations record |

## Commands

```bash
npm run events           # regenerate events.json + events.csv (no API calls)
npm run timeline         # timeline statistics
npm run stance:candidates# stance artifact (uses cached Gemini verdicts)
npm run test:all         # 76 artifact tests + 11 API tests
npm run api:dev          # GraphQL server on :8787
```

## What is verified

- 87 tests passing (76 offline + 11 API, incl. a live HTTP round-trip).
- Events: 20 events, 6 scandals, 7 major-issue groups, 123/209 videos covered.
- Stance: 273 video×candidate verdicts, 214 with verified quotes.
- API: contract frozen at 0.1.0; see `docs/api-v0.1.md`.

## Honest limits

- The sample is 217 videos, not a poll; every surface must say "sample".
- The RN congress in Orléans is **not** in the snapshot (0 hits) and is not invented.
- `Fact.verified` is false until a journalist checks the anchor against its source.
