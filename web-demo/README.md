# Factpicker — web demo (Next.js)

The Story page from `docs/Social video barometer.pdf`: hero + **Anatomy of an
opinion**, rendered live from the GraphQL API. Nothing is mocked — if the API is
down, the page says so and shows the command to start it.

## Run it

Two terminals, from the repository root:

```bash
# 1. the API (port 8787)
npm run api:dev

# 2. the app (port 3000)
cd web-demo
npm install --include=dev   # see the note below
npm run dev
```

Open <http://localhost:3000>.

> **`npm install --include=dev`** — this machine exports `NODE_ENV=production`,
> which makes npm skip devDependencies. Tailwind is a devDependency, so a plain
> `npm install` leaves the styles unbuilt.

The app reads `API_URL` (default `http://localhost:8787/graphql`) server-side, so
there is no CORS setup and no key in the browser.

## What is built

| Piece | Status |
|---|---|
| Header, hero, byline | done |
| Anatomy card: opening → fact → meaning → verdict | done |
| Real thumbnail + click-to-play platform embed | done |
| Auto-rotation between handles (pause/hover/reduced-motion) | done |
| "One fact, many readings" Sankey | done |
| Sample chips (switch cards live) | done |
| Legend 1 / 2 / 3 with the brief's colour rules | done |
| Methodology footnote | done |
| API-down error state, loading skeleton | done |
| Events page | **not built** (nav item disabled) |
| Facts page | **not built** (nav item disabled) |
| Video detail (newsroom) | **not built** |

## Stack

- Next.js 16 (App Router, server components, `connection()` for per-request data)
- Tailwind CSS v4 via `@tailwindcss/postcss`
- shadcn/ui conventions: `components/ui/*`, `cn()` in `lib/utils.ts`, `components.json`
- Self-hosted Playfair Display / Source Serif 4 / Inter via `@fontsource`
  (Google Fonts is unreachable from the build environment)

## Files

```
src/app/page.tsx                 server component: fetch + hero + anatomy
src/app/loading.tsx              skeleton
src/components/site-header.tsx
src/components/anatomy-card.tsx  client: card switch, segments, legend
src/components/ui/button.tsx     shadcn-style button (cva)
src/lib/graphql.ts               the only data access
src/lib/utils.ts                 cn, number/date formatting
scripts/shot.mjs                 screenshots with real device metrics (CDP)
```

## Screenshots

```bash
npm run shot -- http://localhost:3000/ /tmp/desktop.png 1440 1650
npm run shot -- http://localhost:3000/ /tmp/mobile.png 390 1650 mobile
npm run shot -- http://localhost:3000/ /tmp/card.png 1440 1650 "" "@ulyces.co"
```

`--window-size` alone does not set the layout viewport in headless Chrome, which
makes mobile screenshots lie; `scripts/shot.mjs` sets device metrics over CDP.

## Honest notes

- The sample is 217 videos, not the 2,200 in the brief's mock; the copy prints the
  real count and window from the API (`dataset` query).
- Six cards pass the anatomy quality gate. The binding constraint is the six-fact
  catalog, not the videos.
- A card without an opening sentence (the 17 October one) simply omits that step.
- Readings in the Sankey are a term-family classifier (10 families), not a
  language model; the node labels describe which words are present.
- On mobile the Sankey becomes a reading → verdict list: a 1100-unit diagram does
  not survive a 390 px viewport, and shrinking it would make the labels unreadable.
- `By [Your name]` is a placeholder for the newsroom byline.

## Languages

English and French, switched from the header. The choice is stored in a
`locale` cookie and read on the server (`next/headers`), so the HTML arrives
already translated — no flash of the wrong language, no client dictionary fetch.

- `src/lib/i18n.ts` — the only place copy lives. Values are plain strings with
  `{placeholders}` so the whole dictionary can cross the server/client boundary
  (functions cannot). Use `fmt(template, vars)`.
- Data stays the data: candidate names are never translated; fact labels,
  event titles and reading labels are mapped by id (`factLabel`,
  `eventTitle`, `readingLabel`).
- Dates and months use `Intl` with `fr-FR` / `en-GB`, never a hand-written map.
- The French hero ("Les faits, et ce qu’on en fait") follows the v2 brief; the
  English one keeps "Same facts, opposite opinions".

## Deploying

```bash
vercel link --yes --scope your-vercel-scope --project factpicker
vercel deploy --prod --yes --scope your-vercel-scope
```

Production is https://factpicker.vercel.app (aliased) on the
`your-vercel-scope` team.

Two things the deployment depends on:

1. **API base.** `src/lib/graphql.ts` resolves `process.env.API_URL` first, then
   the Supabase function when `VERCEL` is set, then `localhost:8787`. To point a
   deployment elsewhere, set `API_URL` in the Vercel project.
2. **A Suspense boundary in `page.tsx`.** Without it Next prerenders the whole
   page at build time, so one slow API cold start at build is baked into every
   visit. The boundary keeps the shell static and streams the data per request.
