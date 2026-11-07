# Oriane query playbook — framing analysis for the 2027 presidential election

Everything here was verified against the live API on **2026-11-07**. Numbers come
from `data/oriane/_filter-matrix.json` (regenerate with `npm run probe:filters`)
and code references point at `supabase/functions/_shared/`.

The corpus is large and clean: a single candidate query returns thousands of
videos with transcripts, OCR on-screen text, engagement counts and creator
profiles. The hard part is not volume, it is knowing which query composition the
API honours.

---

## 1. Access

| | |
|---|---|
| Base URL | `https://connect.oriane.xyz` |
| Auth | `Authorization: Bearer $ORIANE_API` (verified; no other scheme documented) |
| Spec | `GET /rest/docs` — the OpenAPI document is embedded inline in that page |
| Key scope | server-side only. Supabase secret, never the browser. |

```
POST https://connect.oriane.xyz/rest/contents/search?limit=100&projection=full&sort=interactionsCount:desc
Authorization: Bearer $ORIANE_API
Content-Type: application/json
```

Three endpoints exist, and nothing else:

| Endpoint | Purpose |
|---|---|
| `POST /rest/contents/search` | the only one that matters: videos, images, carousels |
| `POST /rest/profiles/search` | creator search (followers, bio, location) |
| `POST /rest/assets` | create a reusable text or image anchor for visual search |

---

## 2. Query parameters

| Param | Values | Notes |
|---|---|---|
| `limit` | 1–100 | 100 is a hard cap: `101` returns `400` `{field:"limit", rule:"max"}` |
| `offset` | ≥ 0 | past the end returns `416` `OUT_OF_RANGE`, not an empty page |
| `projection` | `basic` \| `default` \| `full` | see the field matrix below |
| `sort` | comma list of `field[:asc\|desc]` | see sortable fields below |
| `aiSearchAnchor` | string | only for paging a visual-similarity search |

Sortable: `visualSimilarity`, `transcriptRelevance`, `viewsCount`, `likesCount`,
`sharesCount`, `commentsCount`, `interactionsCount`, `engagementRatePerViews`,
`engagementRatePerFollowers`, `viewsRatePerFollowers`, `profileFollowersCount`,
`publishedAt`. Default `publishedAt:desc`.

`200` means "that is everything"; **`206` means "page returned, more rows
exist"** — it is the normal success code for any real query, not an error.

---

## 3. Projections — what you actually get

`full` is what this project uses. It is the only projection that carries the
transcript, the OCR text and the frames.

| Field | basic | default | full |
|---|---|---|---|
| `id`, `platform`, `platformId`, `platformType`, `format` | ✓ | ✓ | ✓ |
| `profileHandle`, `profileDisplayName`, `profileFollowersCount`, `profileId` | ✓ | ✓ | ✓ |
| `publishedAt`, `viewsCount`, `likesCount`, `sharesCount`, `commentsCount`, `interactionsCount` | ✓ | ✓ | ✓ |
| `caption`, `title`, `hashtags`, `mentions`, `thumbnailMediaUrl` | ✓ | ✓ | ✓ |
| `engagementRatePerViews`, `engagementRatePerFollowers`, `viewsRatePerFollowers` | – | ✓ | ✓ |
| `profileBio`, `profileVerified`, `profilePostsCount`, `coAuthors` | – | ✓ | ✓ |
| `location*`, `profileLocation*`, `audio*` | – | ✓ | ✓ |
| `media[].transcript` | – | ✓ | ✓ |
| `media[].onScreenText[]` | – | ✓ | ✓ |
| `media[].transcriptLanguage`, `media[].transcriptChunks[]` (start/end seconds) | – | – | ✓ |
| `media[].frames[]` (timestamp, `visualSimilarityScore`, `onScreenTextRegions` with polygons) | – | – | ✓ |
| `captionLanguage`, `popularComments`, `createdAt`, `updatedAt` | – | – | ✓ |

There is **no `url` field**. Build it from `platformId` and `platformType`
(`buildVideoUrl` in `normalize.ts`): YouTube `watch?v=`, `/shorts/` for
`platformType: "short"`, TikTok `@handle/video/{id}`, Instagram `/reel/{code}/`
or `/p/{code}/`.

Measured coverage on the Le Pen slice: 95% of pulled videos have a transcript,
median transcript 1,600 characters, 96% have OCR text.

---

## 4. The query DSL — and the five traps

A request is a tree. Each level has `operator` (`and` / `or`), optional
`filters` (field filters), and optional `queries` (nested groups). Max **two**
nesting levels. Max **500 filter values** across all levels. Max **10** visual
similarity values.

Within a `filters` object, **each field accepts exactly one operand**:
`exactMatch` | `includesExactly` | `includesFuzzy` | `excludesExactly` |
`excludesFuzzy`. Adding two operands to the same field returns
`400 whitelistValidation`.

### Trap 1 — accents are significant, case is not

```
includesExactly "Édouard Philippe" →    53   transcript hits
includesExactly "Edouard Philippe" →   196
includesExactly "edouard philippe" →   196
includesExactly "Mélenchon"        →  1211
includesExactly "Melenchon"        →    15
includesExactly "Melanchon"        →     4
```

So the dictionary must carry **every orthography**, not one canonical name. That
is why `candidates.ts` lists `["Édouard Philippe", "Edouard Philippe", …]` and
why multi-value `includesExactly` with `operator: "or"` is the right tool: the
union of both spellings is 237, which is neither 53 nor 196.

### Trap 2 — a single nested OR group is mandatory

Root `and` with **sibling** sub-queries ANDs them together:

```
OR group:  root{and, queries:[OR{[t],[c],[o]]}}          → 2246   ✓ correct
siblings:  root{and, queries:[{t},{c},{o}]}              →  118   ✗ all three must match
```

If you want "candidate in transcript OR caption OR on-screen text", wrap them in
one nested `or` group and make the root `and`.

### Trap 3 — `operator: "or"` at the root neutralises your filters

With root `or`, filters are OR-ed with the sub-queries, so a format filter stops
constraining:

```
root and + format=image + OR group → 200
root or  + format=image + OR group → 3307   (the whole slice)
```

Always root on `and`; put facets in `filters`, entities in the nested OR group.

### Trap 4 — `transcriptLanguage` deletes image posts

Image posts have no transcript, so any `transcriptLanguage` filter excludes them
entirely:

```
image posts mentioning "Le Pen"                          → 89
  + transcriptLanguage = fr                              →  0
  + captionLanguage    = fr                              → 64
```

Do not use a transcript-language filter as the global "French only" gate. Filter
language **after** fetching (`detectFrench` in `normalize.ts` uses the language
field, else a French-stopword ratio over caption + transcript).

### Trap 5 — hashtags keep their `#`

`hashtags.exactMatch "#presidentielle2027"` matches; `"presidentielle2027"`
returns 0. `profileHandle` is a **text operand**, not a set: use
`includesExactly` with the bare handle (`cnews`), not `includes`, and not
`@cnews`.

---

## 5. The canonical shape

```json
{
  "operator": "and",
  "filters": {
    "publishedAt": { "after": "2026-06-01" },
    "format": { "includes": ["image", "carousel"] }
  },
  "queries": [
    {
      "operator": "or",
      "queries": [
        { "name": "lepen|transcript",    "operator": "and", "filters": { "transcript":    { "includesExactly": { "values": ["Marine Le Pen", "Marine Lepen", "Marine le Pen"], "operator": "or" } } } },
        { "name": "lepen|caption",       "operator": "and", "filters": { "caption":       { "includesExactly": { "values": ["Marine Le Pen", "Marine Lepen", "Marine le Pen"], "operator": "or" } } } },
        { "name": "lepen|on_screen_text","operator": "and", "filters": { "onScreenText":  { "includesExactly": { "values": ["Marine Le Pen", "Marine Lepen", "Marine le Pen"], "operator": "or" } } } }
      ]
    }
  ]
}
```

`name` is worth using: every result comes back with `matchedQueries`, so one
request tells you **which field matched which candidate**. With 31 candidates ×
3 fields = 93 sub-queries in a single request, the API answered in ~450 ms and
returned `matchedQueries: ["lepen|transcript", "melenchon|transcript"]` — a free
provenance column.

> Local matching still runs afterwards. A video discovered by searching Le Pen
> may mock Édouard Philippe; only scanning the full text catches that, and it is
> what fills `mentions` with term-level offsets for the highlight.

---

## 6. Filter granularity (measured)

Baseline: every format, every platform, `since 2026-06-01`, candidate = Marine
Le Pen. **3,307 videos.**

| Filter | Rows | Share | Read |
|---|---:|---:|---|
| `platform` tiktok / instagram / youtube | 1,260 / 1,972 / 75 | 38% / 60% / 2% | YouTube is negligible for this corpus — build for vertical video |
| `format` image / carousel / video | 200 / 320 / 2,787 | 6% / 10% / 84% | image posts are ~16% combined: the idea doc's bucket is real |
| `platformType` instagram `reel` | 1,530 | 46% | |
| `platformType` youtube `short` | 18 | 0.5% | |
| `profileFollowersCount` ≥1M | 400 | 12% | mega accounts |
| `profileFollowersCount` 10k–100k | 1,144 | 35% | micro creators |
| `profileFollowersCount` <10k | 160 | 5% | |
| `engagementRatePerViews` ≥10 (+10k views floor) | 348 | 11% | ratio needs a view floor or it selects 1-like posts |
| `viewsCount` ≥1M | 70 | 2% | viral layer is thin |
| `hashtags` `#presidentielle*` | 43 | 1.3% | hashtags are a weak signal here; text is stronger |
| `profileHandle` `cnews` | 7 | 0.2% | one newsroom is a tiny slice — use a handle list |
| `audioTitle` exact | 1 | 0.03% | too sparse to drive a screen |
| `locationCompleteAddress` `Paris` | 146 | 4% | usable for meetings/field reporting only |
| `hasMentions` | 789 | 24% | tagging/duet infrastructure exists |
| `hasCoAuthors` | 470 | 14% | duets and stitches |
| `transcriptLanguage` `fr` | 1,878 | 57% | **and drops all image posts** |
| `captionLanguage` `fr` | 2,336 | 71% | safer, but still misses posts with no caption |
| `durationSeconds` | — | — | **not a filter** (400) |

### Vision / AI granularity

`POST /rest/assets` creates an anchor: `{"type":"text","text":"a politician
speaking at a podium with microphones and a flag"}` → `ast_…`. Then filter:

```json
{"visualSimilarity":{"includes":{"values":[{"assetId":"ast_…","minScore":0.35}],"operator":"or"}}}
```

| `minScore` | Rows | Share of slice |
|---:|---:|---:|
| 0.20 | 357 | 10.8% |
| 0.30 | 235 | 7.1% |
| 0.45 | 156 | 4.7% |
| 0.60 | 74 | 2.2% |

This is **semantic scene/graphic matching, not face recognition.** It finds
podium shots, flag backdrops and the same campaign poster reused across
accounts — useful to ask "who is reposting the same visual?", not "is this
candidate in the frame". Scores are loose: stay ≥ 0.3 and always pair the visual
filter with a text filter, or you get a million-row result.

Per-frame data is available in `projection=full`: `frames[].timestampSeconds`,
`frames[].visualSimilarityScore`, and `frames[].onScreenTextRegions[].polygon`
(x/y points) — enough to place an OCR highlight on the actual frame. There are
**no detected-object or face labels** in the payload; `media[].tags` are tagged
*profiles*, not visual concepts.

---

## 7. Query catalog

`supabase/functions/_shared/queries.ts` exports `QUERY_CATALOG`: each entry is
one journalistic question plus the body that answers it. By facet:

| Facet | Query ids | Question |
|---|---|---|
| candidate | `candidate_text_all`, `candidate_spoken_only`, `candidate_caption_only`, `candidate_on_screen_only`, `candidate_pair` | who is mentioned, where, and who is contrasted with whom |
| topic | `topic_issue`, `topic_candidate_cross`, `topic_election_context` | which issue is used to attack or defend |
| format | `format_image_post`, `format_video_talking`, `format_short_form`, `format_live` | stills vs talking head vs native short vs live |
| on_screen_text | `onscreen_claim_terms` | slogans burned into the image |
| creator | `creator_mega`, `creator_micro`, `creator_media_handles`, `creator_party_handles` | whose framing reaches whom |
| engagement | `engagement_high_rate`, `engagement_viral`, `engagement_small_account_outlier` | what actually lands |
| audio | `audio_trend`, `audio_copyrighted` | trend sounds vs original audio |
| hashtag | `hashtag_campaign` | coordinated tags |
| mention | `mention_any`, `coauthor_duet` | tagging patterns, duets and stitches |
| community | `community_union_left`, `community_youth_wings`, `community_ngos` | which union, youth wing or NGO pushes the frame |
| location | `location_tagged`, `location_profile` | does place change the frame |
| vision | `vision_semantic_anchor`, `vision_image_anchor` | the same scene or graphic reused |
| temporal | `temporal_debate`, `temporal_conviction` | how a dated event shifted frames |

Facet combination rule: **entities go in the nested OR group, facets go in
`filters`.** Two entity groups (candidate × topic, candidate × community) would
need three nesting levels and are rejected, so those queries put the second
signal in a root `transcript` filter — still an AND, one level shallower.

`candidate_pair` cannot be expressed at all (two OR groups). Fetch candidate A,
then intersect locally with B's `mentions` rows.

---

## 8. Pull strategy used by the app

`npm run pull:top10` (`scripts/pull-top10.ts`):

1. One request per candidate — 31 candidates, `sort=interactionsCount:desc`,
   `projection=full`, `since=2026-06-01`.
2. Over-fetch 4× and keep French content first (`detectFrench`), then backfill,
   so a candidate's slice is not 60% English noise.
3. Deduplicate by content id; one video can serve several candidates.
4. Re-scan every record locally for **all** candidates → `mentions` with
   `strength`, `source_field`, `source_key` and character offsets.

Why per candidate instead of one 93-sub-query request: a single OR query sorted
by interactions returns the biggest accounts overall, and low-volume candidates
(Cazeneuve, Markovic) never surface. Per-candidate requests keep the overview
honest — and the video count per candidate is itself the ranking signal.

Result of the current pull: **217 unique videos, 865 mentions, 31 candidates**,
`data/oriane/`.

---

## 9. Errors, retries, limits

| Status | Meaning | Handling |
|---|---|---|
| `200` / `206` | OK (206 = page of a larger set) | parse `data.results`, `metadata.pagination.totalCount` |
| `400` | validation (`operation: "VALIDATION"`, `code: "FAILED"`, `context[]` has `field`/`rule`) | do not retry; fix the body |
| `402` | quota / billing (`operation`, `code` like an operation error) | stop the batch, surface it |
| `416` | `OUT_OF_RANGE` for `offset` | stop paging |
| `429` / `5xx` | transient | retry with exponential backoff |

The client (`oriane.ts`) retries `429`/`5xx` up to 4 times with backoff, never
retries `4xx`, validates `limit`/`offset` locally (a `RangeError` instead of
silently clamping), and turns `416` into `OrianeError`.

Practical ceilings: 100 rows/page, 500 filter values, 10 visual values, 2
nesting levels. Measured latency: 50–450 ms server-side per query.

---

## 10. Mapping to the database

| Oriane | `videos` | transform |
|---|---|---|
| `id` | `id` | as-is (`cnt_…`) |
| `platformId` + `platformType` | `url` | `buildVideoUrl` |
| `profileHandle` / `profileDisplayName` | `creator_handle` / `creator_display_name` | |
| `profileFollowersCount` | `creator_followers` | |
| `publishedAt` | `posted_at` | |
| `viewsCount` … `interactionsCount` | `views` … `interactions` | |
| `caption` | `caption` | |
| `media[0].transcript` | `transcript` | |
| `media[0].onScreenText[]` | `on_screen_text` | |
| `media[0].transcriptLanguage` | `transcript_language` | |
| `format` + transcript length | `platform_format` + `format` | `image`/`carousel` or <40 transcript words → `image_post` |
| — | `is_french` | `detectFrench` |
| — | `party_signals` | `scanPartySignals` (never a candidate mention) |

Candidate matching is local (`buildMentions`), not a query result: `mentions`
holds `matched_terms`, `source_field`, `source_key`, `strength` and `occurrences`
(character offsets into the original field, ready for the highlight).

---

## 11. Runbook

```bash
npm run demo            # live counts + the canonical body + accent probe
npm run probe:filters   # regenerate data/oriane/_filter-matrix.json
npm run pull:top10      # 31 candidates × 10 videos → data/oriane/
npm run seed:sql        # regenerate supabase/migrations/0002_seed.sql
npm run analyze         # offline LLM batch (dry-run without LLM_API_KEY)
npm run stance          # creator × candidate stance, from data already on disk (0 API calls)
npm test                # unit + live API contract + dataset + stance invariants
```

Oriane has no sentiment field. Stance is computed locally from the caption and
on-screen text already stored in `videos`, so adding it costs no scraping
credits: `docs/creator-stance-etl.md`.

Database: run `supabase/migrations/0001_init.sql`, `0002_seed.sql`, then
`0003_creator_stance.sql`, then deploy `ingest-oriane` and `analyze-batch`.
`./scripts/verify-schema.sh` applies all three to a throwaway Postgres and loads
the snapshot, without touching Supabase.

Before the demo, re-check candidate statuses: the roster moves. As of the
2026-10-31 Wikipedia revision there are **30 declared candidates**; Bardella is
included as a discussed non-candidate, and Polony is a declared journalist with
no party backing (kept, but flagged in `status_note`).
