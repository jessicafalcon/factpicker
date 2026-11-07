# Factpicker API — v0.1 contract

Status: **stable for the demo build**. GraphQL over HTTP, read-only, one endpoint.
Schema: [`api/schema.graphql`](../api/schema.graphql). Server: `api/src/server.ts`.
Tests: `cd api && npm test` (11 tests, including a live HTTP round-trip).

---

## 1. What this layer is

A composable read layer over three systems:

| System | Role in v0.1 |
|---|---|
| **Artifacts** (`data/oriane`, `data/analyses`) | Default source for local dev and tests — the full snapshot |
| **Supabase** (PostgREST) | `videos` + `video_stance` when `SUPABASE_URL` and a key are set; falls back to artifacts on failure |
| **Vertex AI** | `gemini-embedding-001` for semantic search when `VERTEX_EMBEDDINGS=1`; deterministic offline hash vectors otherwise |

Resolvers only ever touch a `Dataset` object (`api/src/sources.ts`), so swapping a
source never changes a resolver. Events and the fact catalog stay file-backed in
v0.1 because they are generated artifacts, not user-edited tables — stated
plainly rather than hidden.

## 2. Page → query map

| PDF page | Query |
|---|---|
| **Story** — "One fact, many verdicts", fact timeline | `story(factId)` + `timeline(factId)` |
| **Entry card** — "Anatomy of an opinion" | `entryPage(limit)` (ranked) or `anatomy(videoId)` — see `docs/anatomy-api.md` |
| **Events** — before/after a big moment | `events(filter)` → `event(id)` → `eventImpact(id, windowDays: 7)` |
| **Facts** — one fact, different stories | `facts`, `fact(id)` (stories, aimedAt, timeline, videosList) |
| **"One fact, many readings"** — Sankey | `facts { id videos sankey { nodes links summary } }` |
| **"When each fact came up"** — timeline | `factTimeline(factId)` or `factTimelines` |
| **Video detail** (newsroom) — evidence, irony check | `video(id)` → `verdicts`, `facts`, `creator` |
| **Share card** — "15 → 48, 60% critical" | `eventImpact(id, windowDays: 7)` for one candidate |
| Course of the campaign | `issueGroups` (major → sub-issue → topics/events) |

## 3. Semantics that clients must not guess

**`Fact.reviewStatus` / `Fact.verified`** — the anchor statement is *not* marked
verified in v0.1. `verified: false` until a journalist checks it against the
official source. The UI must show the source name and the unverified state; the
brief is explicit that the app "does not judge whether the link is true".

**`Event.commencement`** — the date of the **first covered video**, not the
historical start of the affair. `commencementBasis` says so in-band. Coverage
starts 2026-08-08, so an older event can only appear through later coverage.

**`Video.verdicts[].verified` / `heldOut`** — a label is `verified` only when the
quote was found in the source text (`exact` or `fuzzy`). A model verdict whose
quote failed is **held out**: `leaning: UNCLEAR`, `heldOut: true`, and it is
excluded from the totals. A `FAVORABLE`/`CRITICAL` verdict always has a quote; a
`NEUTRAL` may be rule-assigned (candidate inside a list) and have none.

**`CandidateImpact.changePct`** — `null` when the before-window has no videos.
That is *undefined*, not `0%` and not `+∞`. Clients render "no baseline".
Videos posted on the event day are excluded from both windows.

**`SearchHit.method`** — `lexical` by default, `embedding` when
`useEmbeddings: true` and Vertex is available. The method is always reported;
the two scores are never compared or mixed.

**`Creator.stanceByCandidate`** — observed stance of *posts*, not a claim about a
person. `minVideos` defaults to 2; a single video never produces a creator label.

**`Fact.sankey`** — three columns: the fact (column 0), the readings creators
attached to it (column 1, at most five, with the long tail folded into "Other
readings"), and the verdicts (column 2: FOR / AGAINST / NONE). Every weight is a
video count, so `links` reconcile exactly with `summary.videos`. The shares are
rounded once and the third is derived, so the three printed percentages always
add to 100. Readings are a deterministic term-family classifier (10 families),
not a model: it says which words are present, and every node is auditable.

**`Anatomy.attribution.embedUrl`** — the platform's own embed URL (TikTok
`/embed/v2/{id}`, Instagram `/p/{shortcode}/embed`, YouTube `/embed/{id}`). The
client loads it only when the visitor asks to play; the app never re-hosts media.

## 4. Schema shape

```
Query: apiVersion · candidates · candidate(id) · creator(handle) · video(id)
       events(filter) · event(id) · eventImpact(id, windowDays)
       issueGroups · facts · fact(id) · story(factId) · search(query) · timeline(factId)
       anatomy(videoId) · entryPage(limit)
       dataset · facts.sankey · factTimeline(s)
```

## Deployment

Shipped as a single Supabase Edge Function (`graphql`) with the dataset bundled
in, so it needs no database at runtime. Build + verify + deploy:

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...   # personal access token, not the DB password
npm run edge:deploy
```

Full runbook, endpoint URL, CORS and Lovable wiring: `supabase/README.md`.

Enums: `Leaning {FAVORABLE CRITICAL NEUTRAL UNCLEAR}`, `EventKind`, `Platform`.
Every list that can grow (`Creator.videos`, `Event.evidence`, `Fact.videosList`,
`FactStory.videosList`) takes a `limit` argument with a server-side default.

## 5. Errors and limits

GraphQL errors follow the spec plus an `extensions.code`:

| Code | When |
|---|---|
| `GRAPHQL_VALIDATION_FAILED` | unknown field/argument (returned inside `errors`, HTTP 200) |
| `UNAUTHORIZED` | `API_TOKEN` set and `x-api-key` missing/wrong (HTTP 401) |
| `BAD_REQUEST` | body not JSON or missing `query` (HTTP 400) |
| `PAYLOAD_TOO_LARGE` | body > 256 KB (HTTP 413) |
| `INTERNAL` | resolver threw (HTTP 500) |

Every response carries `extensions.durationMs`, `extensions.version` and
`extensions.requestId`, so a client can log latency without a second header.

## 6. Deployment (v0.1)

```bash
cd api && npm ci
PORT=8080 API_TOKEN=… \
  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  GCP_PROJECT=… VERTEX_EMBEDDINGS=1 \
  node src/server.ts
```

- Container: `node:24-slim`, `npm ci --omit=dev`, `CMD node src/server.ts`.
- Health check: `GET /healthz` (returns dataset origin and whether embeddings are
  live). Wire it to the platform's readiness probe.
- The Supabase key is a **secret**, not an env literal in the image; mount it from
  Secret Manager / Cloud Run secret.
- Read-only: the service performs no writes. Ingestion and analysis stay in
  `pipeline/` and the Supabase edge functions.
- Cold start is dominated by parsing the 217-video snapshot (~150 ms locally);
  `createDataset()` is awaited once at boot, not per request.

## 7. Versioning policy

- `apiVersion` and `extensions.version` are `0.1.0` for this contract.
- **Additive** changes (new field, new optional argument, new enum value) do not
  bump the major; clients must tolerate unknown fields.
- **Breaking** changes (removing a field, changing nullability, renaming an enum)
  ship as `0.2.0` and get a parallel deployment before the old one is retired.
- Clients pin the version and send it in a bug report with `requestId`.

## 8. Known gaps in v0.1

1. `Fact.stories` are a **rules ladder** (favourable / critical / reported), not
   the designed short labels ("Sparked mass protests…"). The LLM claim extractor
   that produces those labels is v0.2; the field name and shape will not change.
2. `Event.evidence` returns up to 4 items; there is no cursor pagination yet.
3. No persisted query allow-list — acceptable while the token gate is on, needed
   before public exposure.
4. `timeline()` without `factId` aggregates across events and can double-count a
   video that covers two events.
5. `Anatomy` segmentation is rule-based (anchor sentence → next sentence →
   verified quote). It never paraphrases, but it is not the LLM claim extractor
   of U2; `coverage` and `quality` tell the client when the three steps do not
   exist in the text.
6. Anatomy yield is bound by the six-fact catalog: 18 of 217 videos reach
   `coverage: full`. Adding facts raises yield without a code change.
