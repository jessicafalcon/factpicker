# GraphQL deployment (Supabase Edge Function)

The API in `api/` is packaged as one Supabase Edge Function named `graphql`.
It is public, read-only, and needs no database connection at runtime: the
dataset is bundled into the function at build time.

- **Endpoint:** `https://your-project-ref.supabase.co/functions/v1/graphql`
- **Auth:** none for reads (`verify_jwt = false`); optionally `x-api-key` if you
  set the `GRAPHQL_TOKEN` secret.
- **CORS:** `*`, `POST`/`GET`/`OPTIONS` — safe to call from a Lovable app.

## What is in the function folder

| File | Origin |
|---|---|
| `supabase/functions/graphql/index.ts` | source — Deno entry, ~15 lines |
| `supabase/functions/graphql/_bundle.js` | **generated** — executor, resolvers, graphql-js |
| `supabase/functions/graphql/schema.ts` | **generated** — the SDL as a module |
| `supabase/functions/graphql/dataset.json` | **generated** — compact copy of the artifacts |
| `supabase/functions/graphql/_bundle.d.ts` | source — types for the generated bundle |

≈2.3 MB total. Regenerate all three with `npm run edge:build`.

## One-time setup

1. Create a personal access token: <https://supabase.com/dashboard/account/tokens>
2. Export it (or run `npm run supabase:login`):

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
```

`SUPABASE_PROJECT_REF` defaults to `your-project-ref`; override it to deploy
to another project.

> The token is **not** the database password in `.env`. `DATABASE_API` is the
> Postgres password and `SUPABASE_URL` is the project URL — neither can
> authenticate the CLI.

## Deploy

```bash
npm run edge:deploy
```

The script does four things and stops on the first failure:

1. builds `dataset.json` + `schema.ts` + `_bundle.js` (esbuild, no Docker);
2. runs the bundle in Node and asserts it answers a real query with the right
   CORS headers;
3. `supabase functions deploy graphql --remote <ref> --no-verify-jwt --use-api`;
4. smoke-tests the deployed URL.

Expect ~10–20 s for the deploy and ~1 s cold start (the bundle is 2.3 MB).

### Manual equivalent

```bash
npm run edge:build
npm run edge:verify
npx --yes supabase@latest functions deploy graphql \
  --remote=your-project-ref --no-verify-jwt --use-api
```

## Verify

```bash
curl -s https://your-project-ref.supabase.co/functions/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ apiVersion dataset { videos stanceRows events } }"}'
```

Expected: `{"data":{"apiVersion":"0.1.0","dataset":{"videos":217,...}}}`.

A `GET` on the same URL returns the health summary — useful as an uptime check.

## Optional API key

```bash
npx --yes supabase@latest secrets set GRAPHQL_TOKEN=some-long-random-value \
  --remote=your-project-ref
```

Then every request must send `x-api-key: some-long-random-value`. The function
reads the secret at boot, so redeploy or wait for the instance to recycle after
changing it.

## Wiring it into Lovable Pro

Lovable apps are client-side React, so the browser calls the function directly.
That works because CORS is open. Point the app at the endpoint:

```ts
const API_URL = import.meta.env.VITE_API_URL
  ?? "https://your-project-ref.supabase.co/functions/v1/graphql";

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await res.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  return payload.data as T;
}
```

If you later set `GRAPHQL_TOKEN`, do **not** put it in the browser bundle — proxy
through a Supabase function or a server route instead.

Query reference for every page: **`docs/data-access.md`**. The two sections already built in `web-demo/` need only these queries:

```graphql
# entry page
{ dataset { videos window { first last } } entryPage(limit: 6) { ... } facts { ... } }

# fact timeline
{ factTimeline(factId: "education_budget_2027") {
    months videosInBursts
    moments { date month label title videos hasSelectedFact
              facts { id label videos highlighted }
              verdicts { forCandidate againstCandidate noSide } }
} }
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Access token not provided` | export `SUPABASE_ACCESS_TOKEN` (see above) |
| `401 / Invalid API key` on the endpoint | JWT verification is on — deploy with `--no-verify-jwt` |
| `404` on `.../functions/v1/graphql` | function name must be exactly `graphql` |
| `404 unknown path` in a JSON body | you called a path other than `/graphql` |
| Empty `data` with `errors` | the query is wrong; run it against `npm run api:dev` first |
| Stale numbers | rerun `npm run edge:build` before deploying — the dataset is baked in |

## Postgres mirror (for Lovable-native access)

```bash
npm run db:mirror
```

Creates `fp_candidates`, `fp_videos`, `fp_stance`, `fp_anatomy`, `fp_facts`,
`fp_timelines`, `fp_behind` and the `factpicker_behind` view, all public-read
through RLS. Uses the Management API with `SUPABASE_ACCESS_TOKEN`, so the
database password is not needed. Details: `docs/data-access.md` §8.

## Refreshing the data

The function never queries Oriane or Postgres. To publish new coverage:

```bash
npm run pull:top10      # refresh data/oriane (spends Oriane credits)
npm run stance:candidates
npm run events
npm run edge:build
npm run edge:deploy
```
