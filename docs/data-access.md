# Data access — Factpicker GraphQL

Everything the Figma/PDF pages show comes from one read-only GraphQL endpoint.
This is the contract to build against; `docs/api-v0.1.md` is the design rationale
and `supabase/README.md` is the deploy runbook.

- **Endpoint:** `https://your-project-ref.supabase.co/functions/v1/graphql`
- **Version:** `0.1.0` (`{ apiVersion }`)
- **Auth:** none for reads. Optional `x-api-key` if `GRAPHQL_TOKEN` is set.
- **CORS:** `*`, methods `GET, POST, OPTIONS`
- **Dataset:** 217 videos · 273 stance rows · 20 events · 6 facts · 31 candidates

---

## 1. Connect

```bash
curl -s https://your-project-ref.supabase.co/functions/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ apiVersion dataset { videos stanceRows events } }"}'
```

```json
{"data":{"apiVersion":"0.1.0","dataset":{"videos":217,"stanceRows":273,"events":20}}}
```

```ts
const API_URL = "https://your-project-ref.supabase.co/functions/v1/graphql";

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

`GET` on the same URL returns a health summary (`apiVersion`, `videos`,
`stanceRows`, `events`) — use it as an uptime check.

A GraphQL mistake still returns HTTP 200 with an `errors` array:

```json
{"errors":[{"message":"Cannot query field \"nope\" on type \"Query\".","locations":[{"line":1,"column":3}]}]}
```

---

## 2. Read this before rendering numbers

| Rule | Why |
|---|---|
| `Fact.verified` is **false** for all six facts | they are anchors from the brief, pending a journalist's check. Render `reviewStatus`, never "verified". |
| `changePct` is **null** when `before` is 0 | the percentage is undefined; print `—`, not `0%`. |
| `FactStory.videos` and `FactTarget.videos` count videos, not people | it is a sample of 217, not a poll. Say so. |
| `Creator.stanceByCandidate` needs ≥2 videos | one video never labels a handle. |
| `heldOut: true` means irony suspected | keep it out of totals until reviewed. |
| `Anatomy.segments` arrive in **step order** | opening → fact → meaning → verdict, which may differ from spoken order. |
| A timeline chip with 0 videos is **omitted** | the copy says "highlighted wherever it appeared". |
| A timeline **moment requires ≥1 citation** | otherwise every fact would show the same news calendar. |
| `behindTheNumbers` never returns `UNCLEAR` | the strip is "verified verdicts only". |

---

## 3. Page by page

### 3.1 Story page — hero counters

`docs/Social video barometer.pdf` p.1, the intro line ("we traced … in N videos
between X and Y").

```graphql
{
  dataset {
    videos
    stanceRows
    events
    window { first last }
  }
}
```

```json
{"data":{"dataset":{"videos":217,"stanceRows":273,"events":20,
  "window":{"first":"2026-08-08","last":"2026-11-02"}}}}
```

Use `window.first/last` for "Data through …" — never hardcode the dates.

---

### 3.2 Anatomy of an opinion

p.1, the annotated quote card.

```graphql
{
  entryPage(limit: 6) {
    videoId
    coverage
    quality
    fact { id statement sourceName verified }
    verdict { candidate { id name } leaning verified confidence }
    attribution {
      handle platform platformId embedUrl
      views postedAt thumbnailUrl url format
    }
    segments {
      role
      text
      truncated
      style { underline tone fill className legend }
    }
  }
}
```

Real response (trimmed):

```json
{"data":{"entryPage":[{
  "videoId":"cnt_a20d52a46df25d3486e92b075178",
  "coverage":"full","quality":0.79,
  "fact":{"id":"protest_17_october_2026","statement":"A nationwide mobilisation took place on 17 October 2026","verified":false},
  "verdict":{"candidate":{"name":"Nicolas Dupont-Aignan"},"leaning":"NEUTRAL","verified":true,"confidence":"high"},
  "segments":[
    {"role":"FACT","text":"Une vidéo tournée samedi 17 octobre à Amiens provoque une vive polémique sur les réseaux sociaux.","truncated":false,
     "style":{"underline":"solid","tone":"ink","fill":false,"className":"anatomy-segment--fact","legend":"1 · THE FACT"}},
    {"role":"MEANING","text":"Selon les médias locaux, six fourgons de police auraient été mobilisés devant la chocolaterie Jean Trogneux, une enseigne familiale dirigée par le petit-neveu","truncated":true,
     "style":{"underline":"dotted","tone":"ochre","fill":false,"className":"anatomy-segment--meaning","legend":"2 · WHAT THEY SAY IT MEANS"}}
  ]
}]}}
```

| Field | Meaning |
|---|---|
| `coverage` | `full` · `no_fact` · `no_meaning` · `no_verdict` · `no_text` |
| `quality` | 0–1; below ~0.6 the card is thin — do not promote it |
| `style` | render it, don't re-derive: solid ink underline, dotted ochre, ochre fill |
| `embedUrl` | platform player for click-to-play; never re-host media |
| `verdict.verified` | false → treat the label as held out |

Single video: `anatomy(videoId: "...")`, same shape, nullable.

**Ordering:** `entryPage` is already ranked (full cards first, one per creator,
a 17 October card forced in). Do not re-sort by views.

---

### 3.3 One fact, many readings (Sankey)

p.1, the fact → readings → verdict flow.

```graphql
{
  facts {
    id
    category
    statement
    videos
    sankey {
      nodes { id label column videos views }
      links { source target videos views }
      summary { videos forPct againstPct nonePct topReading }
    }
  }
}
```

```json
{"id":"cost_of_living","videos":34,
 "sankey":{
   "summary":{"videos":34,"forPct":17.6,"againstPct":35.3,"nonePct":47.1,"topReading":"Sparked protests"},
   "nodes":[{"id":"fact","column":0,"videos":34},
            {"id":"reading:protests","label":"Sparked protests","column":1,"videos":10},
            {"id":"verdict:AGAINST","label":"Against a candidate","column":2,"videos":12}],
   "links":[{"source":"fact","target":"reading:protests","videos":10}]}}
```

- `column` 0 = the fact, 1 = readings, 2 = verdicts. At most 5 readings; the tail
  is folded into "Other readings".
- `links` always reconcile: the sum out of `fact` equals `summary.videos`.
- The three percentages add to 100 (the third is derived, not re-rounded).
- Facts are not pre-sorted — sort by `videos` descending so the default view is
  the richest.

---

### 3.4 When each fact came up (timeline)

p.1, the vertical news timeline.

```graphql
{
  factTimeline(factId: "education_budget_2027") {
    factId
    windowDays
    months
    videosInBursts
    fact { id category statement videos }
    moments {
      id date month kind label title
      windowStart windowEnd videos
      hasSelectedFact
      facts { id label videos highlighted }
      verdicts { forCandidate againstCandidate noSide }
    }
  }
}
```

Real response (one moment):

```json
{"date":"2026-10-17","month":"October","label":"Protest",
 "title":"The 17 October national mobilisation and its aftermath",
 "windowStart":"2026-10-16","windowEnd":"2026-10-18",
 "videos":3,"totalVideos":10,"hasSelectedFact":true,
 "facts":[{"id":"education_budget_2027","label":"Education","videos":3,"highlighted":true},
          {"id":"lepen_conviction","label":"Justice","videos":2,"highlighted":false}],
 "verdicts":{"forCandidate":1,"againstCandidate":2,"noSide":0}}
```

| Field | Meaning |
|---|---|
| `date` | the moment's own day (event date when the corpus names it, else first coverage) |
| `videos` | videos **citing the selected fact** in the window — this is what makes each fact's timeline different |
| `totalVideos` | every indexed video posted in the window, cited or not |
| `facts[]` | facts cited in that window, max 4; `highlighted` is the selected fact |
| `verdicts` | split of the selected fact's videos in the window; sums to the highlighted chip |
| `hasSelectedFact` | always true: moments without a citation are dropped |

`factTimelines` returns all six in one call — use it when the page lets the reader
switch facts without a round trip. The six timelines differ in length and range
(cost of living: 8 moments, Aug–Sep; education: 2 moments, October only), which
is the point of the section.

---

### 3.5 The videos behind the numbers

p.1, the strip under the Sankey, and the 9:16 share card.

```graphql
{
  behindTheNumbers(limit: 6) {
    leaning
    candidate { id name }
    fact { id category statement }
    video { id url thumbnailUrl views platform creator { handle } }
  }
}
```

Real response (one item):

```json
{"leaning":"CRITICAL",
 "candidate":{"id":"lepen","name":"Marine Le Pen"},
 "fact":{"id":"education_budget_2027","category":"Education"},
 "video":{"creator":{"handle":"sally"},"views":6821030,
          "url":"https://www.instagram.com/reel/Dekapxit9Z7/",
          "thumbnailUrl":"https://social-catalog-static.oriane.xyz/oriane-contents/instagram/Dekapxit9Z7/thumbnail.webp",
          "platform":"INSTAGRAM"}}
```

| Rule | Why |
|---|---|
| one item per creator **and** per fact | the row reads as variety, not one account's output |
| balanced across leanings (quota per verdict, then fill) | sorting by views alone produced 4 critical / 2 neutral |
| only verified, non-`UNCLEAR` verdicts | no unbacked label reaches the strip |
| `factId` narrows the strip to one fact | use it when a band in the chart is clicked |
| sorted by `views` descending within the selection | highest reach first |
| `candidate` is the target of the verdict | the card labels the handle with the candidate it supports or attacks, coloured by leaning — not a "verdict · topic" pair |

The share card is drawn client-side from this array (canvas 1080×1920), so it
needs no image service and no extra request.

### 3.6 Events list

p.2, the event selector.

```graphql
{
  events(filter: { isScandal: true, limit: 6 }) {
    id title kind isScandal commencement
    videos creators confidence
    candidates { candidate { id name } videos }
  }
}
```

```json
{"id":"lepen_conviction_ineligibility","kind":"SCANDAL","isScandal":true,
 "commencement":"2026-08-19","videos":11,"creators":9,"confidence":"high",
 "candidates":[{"candidate":{"id":"bardella","name":"Jordan Bardella"},"videos":6}]}
```

`kind` ∈ `SCANDAL · POLICY · CAMPAIGN · SOCIETY · INTERNATIONAL`. `commencement`
is the **first video in the sample**, not the historical start — say "first
covered" in the UI. `evidence(limit:)` on `Event` returns verbatim quotes.

---

### 3.7 Event impact (before/after)

p.2 and the share card (p.5).

```graphql
{
  eventImpact(id: "protest_17_october", windowDays: 7) {
    candidate { id name }
    before after changePct
    favorableAfter criticalAfter neutralAfter unclearAfter
  }
}
```

```json
[{"candidate":{"name":"Marine Le Pen"},"before":1,"after":4,"changePct":300,
  "favorableAfter":0,"criticalAfter":2,"neutralAfter":1,"unclearAfter":1},
 {"candidate":{"name":"Francis Lalanne"},"before":0,"after":2,"changePct":null}]
```

Videos posted **on the event day are excluded** from both windows. `after` is
sorted by volume. Convert `changePct` to a verb client-side: ≥200 `tripled`,
≥100 `doubled`, >0 `rose N%`, <0 `fell N%`, null `no baseline`.

---

### 3.8 Facts page

p.3, "One fact, different stories".

```graphql
{
  fact(id: "pension_2023_64") {
    id category statement videos creators
    sourceName sourceUrl verified reviewStatus
    stories { label videos favorable critical neutral unclear }
    aimedAt { candidate { id name } leaning videos }
    videosList(limit: 6) { id url thumbnailUrl views creator { handle } }
  }
}
```

```json
{"videos":17,"creators":15,
 "stories":[{"label":"Reported without a verdict","videos":8,"neutral":6,"unclear":2},
            {"label":"Seen as a failure","videos":8,"critical":8}],
 "aimedAt":[{"candidate":{"name":"Édouard Philippe"},"leaning":"CRITICAL","videos":4}]}
```

`stories` sums to `videos`. `videosList` and `FactStory.videosList` accept a
limit and return full `Video` objects.

---

### 3.9 Video detail (newsroom)

p.4.

```graphql
{
  video(id: "cnt_00f2fa0ab4625d65c962a15b10f4") {
    id url platform postedAt views format durationSeconds
    creator { handle displayName followers verified }
    verdicts {
      candidate { name }
      leaning confidence quote source verified heldOut
    }
    facts { fact { id category statement } story }
    caption transcript onScreenText
  }
}
```

```json
{"views":4352094,"format":"talking","durationSeconds":179.647,
 "creator":{"handle":"lesprit.critique","followers":1082650,"verified":true},
 "verdicts":[{"candidate":{"name":"Édouard Philippe"},"leaning":"CRITICAL",
   "confidence":"high","quote":"Celui qui résume encore mieux le pouvoir, c'est Édouard Philippe…",
   "source":"transcript","verified":true,"heldOut":false}]}
```

`source` is the field the quote was found in (`transcript`, `caption`,
`on_screen_text`) — use it to label the excerpt. `heldOut` must be visible: it
means the label is excluded from totals.

---

### 3.10 Creator

```graphql
{
  creator(handle: "lemondefr") {
    handle displayName followers verified platforms
    videos(limit: 5) { id postedAt views url }
    stanceByCandidate(minVideos: 2) {
      candidate { name }
      videos favorable critical neutral unclear
      stanceIndex viewWeightedIndex label
    }
  }
}
```

`stanceIndex` = (favourable − critical) / videos, in [−1, 1]. It describes the
**posts**, not the person — phrase it that way.

---

### 3.11 Search

```graphql
{ search(query: "retraites", limit: 10) { score method video { id url creator { handle } } } }
```

```json
[{"score":21.525,"method":"lexical","video":{"id":"cnt_d038…","creator":{"handle":"simsim__lg"}}}]
```

`method` is always reported (`lexical` today). `useEmbeddings: true` requires a
Vertex key on the deployment and falls back to lexical — never claim semantic
search when `method` says lexical.

---

## 4. Field reference

### Enums

| Enum | Values |
|---|---|
| `Leaning` | `FAVORABLE` · `CRITICAL` · `NEUTRAL` · `UNCLEAR` |
| `Platform` | `TIKTOK` · `INSTAGRAM` · `YOUTUBE` |
| `EventKind` | `SCANDAL` · `POLICY` · `CAMPAIGN` · `SOCIETY` · `INTERNATIONAL` |

### `Anatomy`

`videoId · composed · coverage · quality · fact · verdict · attribution · segments[]`

### `Event`

`id · title · category · kind · majorIssue · subIssue · isScandal · commencement ·
commencementBasis · peakDate · peakVideos · lastCoveredAt · durationDays ·
activeDays · videos · creators · confidence · timeline[] · topicBreakdown[] ·
candidates[] · evidence(limit) · notes`

### `Fact`

`id · statement · category · sourceName · sourceUrl · verified · reviewStatus ·
videos · creators · stories[] · aimedAt[] · timeline[] · videosList(limit) ·
events[] · sankey`

### `Video`

`id · url · platform · postedAt · creator · views · likes · interactions · format ·
platformFormat · durationSeconds · thumbnailUrl · caption · transcript ·
onScreenText[] · isFrench · verdicts[] · facts[] · candidates[]`

---

## 5. Recipes

**All facts, richest first**

```graphql
{ facts { id category videos } }
```

**Readings for one fact, flattened for a legend**

```graphql
{ fact(id: "cost_of_living") { sankey { nodes { id label column videos } links { source target videos } } } }
```

**Scandals since September**

```graphql
{ events(filter: { isScandal: true, since: "2026-09-01" }) { id title commencement videos } }
```

**The 17 October story, for a share card**

```graphql
{
  event(id: "protest_17_october") { title commencement videos }
  eventImpact(id: "protest_17_october") { candidate { name } before after changePct criticalAfter favorableAfter neutralAfter }
}
```

**Timeline for every fact (one request)**

```graphql
{ factTimelines { factId months moments { date label videos hasSelectedFact } } }
```

---

## 6. Limits and errors

| Case | Response |
|---|---|
| Unknown field / bad argument | HTTP 200 + `errors[]` |
| Invalid JSON body | HTTP 400 `{"errors":[{"message":"invalid JSON body"}]}` |
| Wrong path | HTTP 404 `unknown path …` |
| Missing `query` | HTTP 400 `missing query` |
| `GRAPHQL_TOKEN` set, no key | HTTP 401 `unauthorized` |

No cursor pagination: list fields take `limit` (defaults 4–50 depending on the
field). `entryPage` is capped at sensible demo sizes; keep it ≤ 6.

Cold start is ~1 s (2.3 MB bundle); warm calls are ~20–60 ms.

**Not exposed yet** — don't design against it: candidate → all videos, topic →
all videos, free-text filters other than `search`. Those exist only as
`fact.videosList`, `event.evidence` and `search`.

---

## 7. Data lifecycle

The function has no database connection: `dataset.json` is baked in at build
time. Publishing new coverage is:

```bash
npm run pull:top10          # spends Oriane credits
npm run stance:candidates
npm run events
npm run edge:build
npm run edge:deploy
```

Until that runs, the endpoint keeps serving the snapshot from the last deploy —
`dataset.videos` is the honest way for a page to show which snapshot it is on.

---

## 8. Supabase mirror (Lovable-native access)

The same data is mirrored into Postgres, so a Lovable app can use `supabase-js`
directly instead of calling GraphQL. Refreshed with `npm run db:mirror`
(Management API, no database password needed).

| Table | Rows | Contents |
|---|---:|---|
| `fp_candidates` | 31 | id, name, party, party_short, tier, status, communities |
| `fp_videos` | 217 | id, platform, url, thumbnail, posted_at, views, creator fields, format, caption, transcript, on_screen_text, is_french |
| `fp_stance` | 273 | video_id, candidate_id, label, score, quote, basis, evidence_mode |
| `fp_anatomy` | 6 | `position`, `quality`, `payload` — one entry-page card each |
| `fp_facts` | 6 | `id`, `category`, `statement`, `videos`, `payload` (sankey + stories + aimedAt) |
| `fp_timelines` | 6 | `fact_id`, `payload` (months + moments) |
| `fp_behind` | 6 | `position`, `payload` (the strip) |

Plus a flattened view for the strip:

```sql
select leaning, candidate, topic, handle, url, thumbnail_url, views
from public.factpicker_behind
order by position;
```

```ts
const { data } = await supabase
  .from("factpicker_behind")
  .select("leaning, candidate, topic, handle, url, thumbnail_url, views")
  .order("position");
```

Every table has RLS enabled with a `public read` policy for `anon` and
`authenticated`; writes are denied (verified: `POST` returns 401). The
`payload` columns are the exact JSON shapes the GraphQL API returns, so a page
can be ported between the two without changing its rendering code.

**Which to use:** the edge function for a single source of truth and instant
cold start; the tables when Lovable's Supabase integration needs `.from(...)`
queries, joins or realtime.
