# Security

## Secrets are environment-only

No credential, project ref, account slug or private endpoint is committed. The
repository is safe to publish; the same code runs against any Supabase, GCP or
hosting account once the environment is set.

- Copy `.env.example` to `.env` and fill it locally. `.env`, `.env.*` (except
  the template) are gitignored.
- `.env.example` contains placeholders only — `your-project-ref`,
  `your-gcp-project`, `beta_xxxx…` — never real values.
- `supabase/.temp/` (the CLI's linked-project state) is gitignored.

## What is deliberately not in the repository

| Excluded | Why |
|---|---|
| `.env` | real keys: Oriane, Supabase service role, GCP, LLM |
| `supabase/.temp/` | contains the linked project ref |
| `data/oriane/*` except `top10-all.json` | raw scrape; the combined snapshot is enough to run the API |
| `data/analyses/prompts.json`, `runs/`, `*-trace.json` | large debug artefacts |
| `supabase/functions/graphql/{_bundle.js,dataset.json,schema.ts}` | generated; `npm run edge:build` recreates them |
| `docs/*.pdf` | large binaries |

## Handling guidelines

- The Supabase **service role** key bypasses row-level security. It stays on the
  server; the browser only ever talks to the GraphQL function or to read-only
  tables through the anon key.
- The GraphQL function can require an `x-api-key` header by setting
  `GRAPHQL_TOKEN`; leave it unset only if the endpoint is meant to be public and
  read-only.
- Rotate any key that appears in a screenshot, log or shared terminal before
  publishing. This repository has been scanned for the identifiers used during
  development; run the same check before every release:

```bash
grep -rIl --exclude-dir={node_modules,.next,.git,.vercel} \
  -E "guimrmcbkf|ultimate3d|sbp_[A-Za-z0-9]{20,}|postgres(ql)?://" . || echo "clean"
```

## Reporting

Open an issue or contact the maintainers privately for anything sensitive — do
not include live keys in the report.
