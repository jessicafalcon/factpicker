# Factpicker — UI handoff spec (Lovable Pro)

What this is: a build-ready description of the Story page implemented in
`web-demo/`, plus the remaining sections of `docs/Social video barometer.pdf`.
It is written so a teammate can rebuild the same site in Lovable Pro without
re-deriving decisions.

**Read this first:** the brief wins over Lovable's defaults. If Lovable proposes
a different palette, font, or card layout, reject it and paste the tokens from §1.

Sections implemented and verified: **A (hero + anatomy)**, **B (one fact, many
readings)**, **C (fact timeline)**, **D (videos behind the numbers + 9:16 card)**.
Everything from §8 onward is specified but not built.

---

## 1. Design system — paste this first

### Colour tokens

| Token | Hex | Use |
|---|---|---|
| `paper` | `#faf7ef` | page background |
| `paper-deep` | `#f2ece0` | pressed/offset surfaces, active nav pill |
| `ink` | `#191512` | primary text, fact underline, filled buttons |
| `ink-soft` | `#5b544a` | secondary text, byline, captions |
| `rule` | `#dcd4c4` | hairlines, box borders |
| `ochre` | `#b9852c` | verdict fill, meaning underline, accent rules |
| `ochre-ink` | `#7d5518` | ochre **text** (kicker) — passes 4.5:1 |
| `ochre-soft` | `#f1e3c8` | selection, against band fill |
| `tile` | `#211d1a` | video tile background |
| `for` / `for-soft` | `#5b7fc7` / `#e3e9f6` | "for a candidate" |
| `against` / `against-soft` | `#b9852c` / `#f1e3c8` | "against a candidate" |
| `none` / `none-soft` | `#b9b3a6` / `#ece8dd` | "no side" |

Never use `ochre` for small text on paper (3.4:1). Use `ochre-ink`.

### Type

| Role | Face | Weights | Notes |
|---|---|---|---|
| Display | **Playfair Display** | 500/600/700 | headlines only |
| Prose | **Source Serif 4** | 400/500/600 | intros, quote, captions, legend descriptions |
| UI | **Inter** | 400/500/600 | nav, chips, labels, metadata |

Self-host via `@fontsource` (Lovable's Google Fonts loader is fine if it is
reachable, but pin the exact families — do not accept its defaults).

### Scale (implemented)

| Element | Size | Other |
|---|---|---|
| Kicker | 11.5 px | uppercase, 600, tracking `.16em`, `ochre-ink` |
| H1 | `clamp(2.75rem, 6.4vw, 5.25rem)` | leading `.98`, tracking `-.025em`, `text-wrap: balance`, max 16ch |
| Hero intro | `clamp(1.15rem, 2vw, 1.5rem)` | serif, leading 1.55, max 46ch |
| Byline | 13 px | `ink-soft` |
| Section H2 | `clamp(2rem, 3.4vw, 2.85rem)` | display, leading 1.1, tracking `-.02em` |
| Section intro | `clamp(1.05rem, 1.5vw, 1.2rem)` | serif, leading 1.6, max 54–62ch |
| Anatomy quote | `clamp(1.35rem, 2.1vw, 1.9rem)` | serif, leading 1.52 |
| Legend label | 11 px | uppercase, 700, tracking `.14em` |
| Legend body | 15 px | serif, `ink-soft`, max 34ch |
| Sankey fact title | `clamp(1.4rem, 2vw, 1.75rem)` | display |
| Sankey statement | 15 px | serif, `ink-soft`, max 46ch |
| Sankey caption | `clamp(1rem, 1.4vw, 1.15rem)` | serif, centred, max 62ch |

### Layout and chrome

- Content column `max-width: 1180px`, `padding-inline: 24px`, centred.
- Header 56 px tall, 1 px `rule` bottom border, logo left, nav right.
- Radii: 6 px (diagram nodes), 8 px (small controls), 12–16 px (tiles/panels),
  full pills for chips.
- Rules: 1 px `rule` hairlines; 2–2.5 px for legend rules and underlines.
- Focus ring: `2px solid ochre`, offset 3 px. Selection: `ochre-soft` background.
- Scrollbars: thin, `rule` on transparent.
- **No** card shadows, no gradients except the legibility scrim on the video
  tile, no `box-shadow` offsets, no rounded-xl cards inside cards.

---

## 2b. Language (v2 brief)

The app ships EN and FR. A small EN/FR control sits at the right of the header,
outside the nav.

- Store the choice in a `locale` cookie (one year). Read it **on the server** so
  the first paint is already in the right language.
- Never translate data: candidate names, creator handles and quotes stay as
  published. Fact labels, event titles and reading labels are translated by id.
- Dates and month names come from `Intl` (`fr-FR` / `en-GB`), not from the API's
  English month strings.
- Hero copy differs by language: FR "Les faits, et ce qu’on en fait", EN
  "Same facts, opposite opinions". Use typographic apostrophes (’) in French.

**v2 also rewrote pages 2 and 3** (Events, Facts). If those pages are built from
this document, use the v2 layouts: the Events page now compares *daily rates*
(14 days before vs 72 hours after, "× a normal day") rather than raw counts, and
the Facts page groups videos into named stories ("Schools are being abandoned",
22 videos · mostly against) before showing two quote cards. See
`docs/Social video barometer-v2.pdf` pages 2–3.

## 2. Page inventory

| Page | Sections | Status |
|---|---|---|
| **Story** `/` | Hero → Anatomy → One fact, many readings → When each fact came up → Videos behind the numbers → How we did this | A, B built; rest specified |
| **Events** `/events` | Event cards → before/after per candidate → three events side by side | not built |
| **Facts** `/facts` | Fact chips → anchor fact header → "what creators say it led to" → selected story → video cards | not built |
| **Video detail** | thumbnail + creator → verdict card → fact cited → irony check → actions | not built |
| **Share card** | 1200×630 export | not built |

Nav: Story only, active (`paper-deep` pill). Events / Facts are **not rendered**
until those pages exist — never ship them as dead or disabled links.

---

## 3. Section A — Hero + Anatomy (implemented)

### Structure

```
header (logo + nav)
main
  section.hero          centred, pt 56 / 80 md
    p.kicker
    h1
    p.intro
    p.byline
  section.anatomy       max 1180
    h2 + p.intro
    div.chips             6 handle chips + rotation toggle, wraps
    div.grid              300px | 1fr, gap 40 / 48 md
      button.video        aspect 4/5 mobile, 9/15 sm+
      div.quote
        blockquote        4 spans, styled by role
        sr-only verdict
        div.legend        3 columns sm+
```

### Copy

- Kicker: `PRÉSIDENTIELLE 2027 · AUGUST TO NOVEMBER 2026` — computed from the API
  window; same year written once.
- H1: `Same facts, opposite opinions`; at `md+` force a line break before
  "opinions"; below `md` let it wrap naturally.
- Intro: `Creators rarely invent facts. They pick one, say what it means, and
  turn it into a verdict on a candidate. We traced how that happens in {videos}
  TikTok and Instagram videos between {first} and {last}.`
- Byline: `By [Your name] · Data through {last}`.
- Section intro: `Most political videos follow the same three steps. {introFor(card)}`
  - non-protest card: `Here is one about {phrase}, posted {date}.`
  - 17 October card: `Here is one from the 17 October thread, posted {n} days later.`
- Toggle: `Pause rotation` / `Auto-rotate`.

### The quote — exact styling contract

| Role | Class | Style |
|---|---|---|
| OPENING | `anatomy-segment--opening` | inherit colour, no decoration |
| FACT | `anatomy-segment--fact` | underline **solid 2 px ink**, offset 4 px |
| MEANING | `anatomy-segment--meaning` | underline **dotted 2.5 px ochre**, offset 6 px |
| VERDICT | `anatomy-segment--verdict` | **filled ochre**, text `#fffaf0`, padding `.04em .16em` |

Add `box-decoration-break: clone` so multi-line highlights stay clean. Wrap the
whole quote in curly `“ ”`. Append `…` only when `segment.truncated`. Render the
segments **in the order given** (opening → fact → meaning → verdict); they are
not necessarily in spoken order.

Legend: three columns, each with a rule above — `2px solid ink`, `2.5px dotted
ochre`, `2.5px solid ochre` — then the label (`1 · THE FACT`, `2 · WHAT THEY SAY
IT MEANS`, `3 · THE VERDICT`) and a 15 px serif description. **Take both strings
from the API** (`style.legend`, `style.description`); do not retype them.

### Video tile

- Thumbnail fills the tile, `object-cover`; a bottom-up black scrim
  (`from-black/80 via-black/20 to-black/30`) keeps the text legible.
- 56 px play circle, 2 px paper border, icon filled, `scale(1.05)` on hover.
- Bottom-left: `@handle` 15 px 500, then `{Platform} · {views} views` 13 px at
  75% paper.
- Clicking loads `attribution.embedUrl` in an iframe (**9/16**, `allow=
  "autoplay; encrypted-media; picture-in-picture"`, `allowfullscreen`, `lazy`).
  If there is no embed URL, open the post.
- Below the tile: `Open on Instagram ↗` — 12.5 px, `ink-soft`, underlined on hover.
- **Never re-host or download media.** The platform's player and attribution stay.

### Rotation

- Advance every **9000 ms**.
- Pause on mouse-enter and on focus within; resume on leave/blur.
- Never start when `prefers-reduced-motion: reduce`.
- Toggle is `aria-pressed`, sits at the end of the chip row (`ml-auto`), ghost
  button with Pause/Play icon.
- Restart the interval after a manual pick so the reader gets a full beat.

### States

| State | Behaviour |
|---|---|
| loading | skeleton: kicker bar, two-line title, intro lines, 300×? tile, 3 quote lines |
| API down | panel with `The API is not answering`, the endpoint in `<code>`, and `npm run api:dev` in a dark `<pre>` |
| no cards | section renders nothing, hero + footnote stay |
| card without opening | render fact → meaning → verdict only; never invent an opening |

### Acceptance

- [ ] quote segments are verbatim; `composed.slice(composedStart, composedEnd) === text` and `sourceText.slice(start, end) === text`
- [ ] fact is solid-underlined, meaning dotted-ochre, verdict filled ochre
- [ ] legend text comes from the API
- [ ] clicking plays the platform embed; the link still opens the post
- [ ] rotation pauses on hover/focus and under reduced motion
- [ ] mobile stacks tile above quote; no horizontal scroll

---

## 4. Section B — One fact, many readings (implemented)

### Structure

```
section.readings            max 1180
  h2 + p.intro
  div.chips                 "Pick a fact" + one pill per fact (sorted by videos desc)
  div.panel                 border-top rule, pt 32
    p.eyebrow               "The fact"
    h3                      fact.category
    p                       fact.statement · N videos
    figure (sm+)            SVG sankey, viewBox 0 0 1100 376
    div (below sm)          reading → verdict list
    figcaption              computed percentages + top reading
```

### Copy

- H2: `One fact, many readings`
- Intro: `Now repeat that for every video citing the same fact. Each band is a
  group of videos, flowing from the fact to what creators said it meant, and on
  to their verdict.`
- Chips: `Pick a fact`, then labels — `Pension reform (2023)`, `Education
  budget`, `Immigration law`, `Cost of living`, `Court ruling`, `17 October`.
  Sort by video count descending so the default view is the richest.
- Caption: `Of {n} videos citing this fact, {against}% used it against a
  candidate, {for}% in support of one, and {none}% took no side. The most common
  reading: “{topReading}”.` — numbers come from `sankey.summary`; never hardcode.

### Sankey geometry (desktop ≥640 px)

| Element | Spec |
|---|---|
| Canvas | `viewBox="0 0 1100 376"`, width 100% |
| Column headers | y 20, 10 px 700 uppercase, tracking `.12em`, `ink-soft`; x 300 and 820 |
| Fact bar | x 42, y 52, w 10, h 300, `ink`, rx 2 |
| Reading nodes | x 300, w 340, h `clamp(46, 26 + videos*4, 76)`, gap 14, centred in the 300 band; paper fill, `rule` border, 6 px radius; label 14 px serif, count 11 px right-aligned |
| Verdict nodes | x 820, w 250, h 64, gap 14; soft fill + a 4 px solid left keyline |
| Links | cubic Bézier ribbons; fact→reading `rule` at 0.30 opacity; reading→verdict in the verdict colour at 0.42 |
| Hover | all links not touching the hovered reading drop to 0.08; node border becomes `ink` |
| Empty | if `videos < 4`, replace the diagram with: `Only N videos cite this fact in the sample — not enough to read a breakdown from. Pick another fact.` |

Verdict colours: against `#b9852c`, for `#5b7fc7`, none `#b9b3a6`.

### Mobile (<640 px)

Do **not** shrink the SVG — the labels become unreadable. Render the list
instead:

- one row per reading: label (15.5 px serif) + count (12 px, tabular);
- a 10 px stacked bar of that reading's verdict split (verdict colours at 0.75);
- a legend row: `● Against a candidate · 12` etc.

### Accessibility

- SVG has `role="img"` and an `aria-label` carrying the percentages.
- A visually-hidden `<table>` lists reading → videos.
- Chips are `<button aria-pressed>`; the active one is ink-filled.

### Acceptance

- [ ] reading counts sum to the fact total; verdict counts sum to the same total
- [ ] percentages add to 100 (the third is derived, not independently rounded)
- [ ] switching facts re-renders without layout jump
- [ ] hover dims unrelated ribbons
- [ ] mobile shows the list, not a shrunken diagram

---

## 5. Data contracts

Base URL: the GraphQL service (`API_URL`, default `http://localhost:8787/graphql`).
Server-side fetch, `cache: "no-store"`. Never put a Supabase **service_role** key
in the browser.

```graphql
query StoryPage($limit: Int!) {
  apiVersion
  dataset { videos stanceRows events window { first last } origin }
  entryPage(limit: $limit) {
    videoId composed coverage quality
    fact { id statement sourceName verified }
    verdict { candidateId candidate { id name } leaning verified }
    attribution { handle platform platformId embedUrl views postedAt thumbnailUrl url format }
    segments { role text source truncated style { underline tone fill className legend description } }
  }
  facts {
    id statement category videos
    sankey {
      nodes { id label column videos views }
      links { source target videos views }
      summary { videos forPct againstPct nonePct topReading }
    }
  }
}
```

### Data strategy for Lovable (pick one)

1. **Recommended for the hackathon:** call the GraphQL API from the server (or a
   Supabase edge function proxy) with a read-only token. Zero schema duplication,
   one source of truth. `web-demo/src/lib/graphql.ts` is ~120 lines; copy it.
2. **Lovable-native alternative:** create Supabase views that mirror
   `entryPage` and `sankey` and query with `supabase-js`. More work, but no
   separate service. Tables already exist (`videos`, `mentions`,
   `video_stance`, `creator_stance`); the events/facts/sankey shapes would need
   materialising.

Do not let Lovable invent the numbers. If the API is unreachable, render the
error state — never fall back to the mock's "2,200 videos".

---

## 6. Section C — "When each fact came up" (timeline) — implemented

From PDF page 1, below section B.

**Layout.** Left rail with month labels (`JUNE`, `JULY`, `SEPTEMBER`,
`OCTOBER`), a vertical 1 px rule, and one node per moment. Nodes alternate
between a filled dark dot (major) and a hollow ring (minor). To the right of a
node: a small label (`Court ruling`, `Announcement`, `Televised debate`,
`17 Oct. Protest`, `Program launch`), the title in display type, `N videos in 3
days`, then up to three fact chips.

**Data.** `factTimeline(factId)` returns the moments already ranked and counted:
one node per calendar day (the event's own date when the corpus names it,
otherwise its first covered day), a 3-day centred window, and the verdict split
**for the selected fact**. A moment is only emitted when the fact is cited in it,
so each fact has a genuinely different timeline — that difference is the feature,
not a bug. `videos` is citations, `totalVideos` is everything posted in the
window; show both. Chips are the *other* facts cited alongside (hide the
highlighted one). The section follows the fact chosen in section B — do not hold
a second selection.

**Copy.** Month labels uppercase; node meta `{n} videos in 3 days`; chips are
fact names.

**States.** An event with no three-day burst shows `sparse coverage` instead of a
count. Fewer than two events → hide the section.

**Acceptance.** [ ] months derive from dates [ ] counts match the API [ ] the
17 October node is present and distinct from the 1961 memory thread.

---

## 7. Section D — "The videos behind the numbers" — implemented

**Layout.** Horizontal strip of 5–6 video cards on the paper surface (no card
chrome). Each: 9/16 thumbnail, views in the top-left in paper at 13 px, creator
handle below, then a two-line meta: `Against · education budget`. Cards link to
the video detail.

**Data.** `behindTheNumbers(limit: 6)` — already balanced (quota per verdict, one
per creator and per fact, verified labels only). Each card needs `views`,
`creator.handle`, `leaning`, `fact.category`.

**Share control.** The "Share this finding as a 9:16 card" button draws a
1080×1920 canvas (title, six rows with verdict colour, footer with the sample
size and date range, wordmark) and downloads it as PNG. It is not a link to
another page — if you cannot implement the canvas, remove the button rather than
leaving it inert.

**Copy.** Meta format: `{For|Against|No side} · {fact category}` in sentence case.

**Acceptance.** [ ] 6 cards max, horizontally scrollable on mobile with snap
[ ] the verdict word matches the API leaning [ ] no card shadow.

---

## 8. Remaining section E — Events page

**Route:** `/events`. **PDF page 2.**

### E1. Event selector
Three bordered panels in a row (12 px radius, 1 px `rule`; no shadow). Each:
`Event 1 · {date}`, title in display type, `{n} videos in the 14-day window`.
Active panel: ink background, paper text. Below 768 px: horizontal scroll.

### E2. Before/after comparison
Header row: `Candidate` | `Number of videos` | `Change` | `Leaning of videos after`
(right-aligned). One row per candidate:
- a scale track with a grey dot at the "before" position and a dark dot at
  "after", joined by a 1 px line (this is a range, not a bar chart);
- `{before} → {after}` next to the after dot;
- change as `+121%` / `−40%`; **`—` when the before window is empty** (the API
  returns `null`; never print `0%`);
- a 3-segment stacked bar (favourable blue, critical ochre, neutral grey) with a
  caption `Mostly favourable · 45% fav. / 35% crit.` or `Split · …`.
Event-day videos are excluded from both windows — say so in the footnote.

**Data:** `eventImpact(id, windowDays: 7)`; fields `before`, `after`,
`changePct`, `favorableAfter`, `criticalAfter`, `neutralAfter`, `unclearAfter`.

### E3. Three events side by side
Three panels: `Event {n} · {title}`, `Biggest increase`, candidate name +
`+{n}%`, and the leaning line. Derive "biggest increase" from the max
`changePct` with a non-null baseline.

**Footnote:** `Same search queries for every window. Leaning counts only labels
whose evidence was found verbatim in the video. Videos posted on the event day
are excluded from both windows.`

**Acceptance.** [ ] null baselines render as `—` [ ] leaning counts sum to
`after` [ ] keyboard focus reaches the event panels [ ] the active panel is not
signalled by colour alone (add a border/weight change).

---

## 9. Remaining section F — Facts page

**Route:** `/facts`. **PDF page 3.**

### F1. Fact chips
`Pension reform`, `Immigration law`, `[Fact from catalog]` — same pill style as
section B, active = ink fill.

### F2. Anchor fact header
Left: eyebrow `ANCHOR FACT · {category}` in 11 px uppercase `ink-soft`; the
statement in display type (up to 2 lines); `Checked against [official source]`
with the source as a link. Right: three metrics — `Videos citing it`,
`Creators`, `Different stories` — large numerals in display type above 11 px
uppercase labels.

**Data:** `fact(id)` → `videos`, `creators`, `stories.length`, `sourceName`,
`sourceUrl`, `verified`.

> If `verified` is false, do **not** print "verified". Print `Anchor pending
> review` and keep the source link. The brief is explicit that the app records
> interpretations and does not judge them.

### F3. "What creators say it led to"
Left column (~48%): heading, one-line explainer, then one row per story:
label + `{n} videos`, and a 3-segment leaning bar underneath. Rows are buttons;
the active row gets a 1 px ink border.

### F4. Selected story panel
Right column: eyebrow `Selected story`; headline `“{fact statement}” → {story
label}`; `Aimed at` label; candidate chips (`{name}  {Leaning} · {n}`), each
coloured by leaning; then 2 video cards.

### F5. Video cards
Creator handle + platform + `{Leaning} toward {Candidate}` + views; two labelled
quote rows — `Fact` (verbatim) and `Led to` (verbatim) — each on a tinted
surface; a `See the evidence` link to the video detail.

**Data:** `fact(id)` → `stories { label videos favorable critical neutral unclear }`,
`aimedAt { candidate { name } leaning videos }`, `videosList`.

**Acceptance.** [ ] story counts sum to the fact's videos [ ] every candidate
chip names a leaning [ ] no story selected by default if fewer than 2 exist.

---

## 10. Remaining section G — Video detail (newsroom)

**Layout.** Two columns: 300 px thumbnail column (9/16, play, `Open on TikTok`
button) and a content column of stacked panels (12 px radius, 1 px rule).

1. **Creator header:** `@handle` in display type, `[n] followers`, chips:
   platform, `Talking video · 0:48`, `1.2M views`, `Posted {date}, 1 day after
   the court ruling`.
2. **Verdict card:** candidate name + leaning pill + `Confidence: high · counted
   in the totals`; `Transcript excerpt` with the **quote highlighted** inside
   surrounding text (`[transcript before] … [quote] … [after]`); a check line
   `Quote found word for word in the transcript`.
3. **Fact cited:** two rows — `Fact` (anchor statement, with `See all videos
   citing it`) and `Led to` (story label).
4. **Irony check:** one paragraph. If no irony: `No sign of irony in this video.`
   If irony: `Held out of the totals until a journalist reviews it.` Never
   auto-clear a held-out label.
5. **Actions:** `Report a wrong label`, `Copy citation` (secondary buttons).
6. **Footnote:** `Labels for named creators are for newsroom use. Published
   pieces show totals only.`

**Data:** `video(id)` → `verdicts { candidate, leaning, confidence, quote,
verified, heldOut }`, `facts { fact { statement } }`, `creator`.

**Acceptance.** [ ] a held-out label never looks like a verified one [ ] the
quote highlight uses the FACT underline, not the verdict fill [ ] "Copy
citation" copies quote + URL + creator.

---

## 11. Remaining section H — Share card

**Format:** 1200×630, `#141210` background, paper text, ochre accent.

- Eyebrow: `PRÉSIDENTIELLE 2027`
- Headline (display, 64 px, 3 lines max): `After {event label}, videos about
  {candidate} {tripled|doubled|rose}`
- Hero numbers: `{before}` in grey, `→`, `{after}` in paper at 120 px; captions
  `week before` / `week after`.
- `How the {n} new videos talked about him` + a 3-segment bar with
  `{against}% critical` / `{for}% favorable` / `{none}% neutral`.
- Footer: `Not a poll.` + `Sample of TikTok and Instagram videos indexed by
  Oriane, 7 days before and after {event}.` + `Factpicker` + date.

**Data:** `eventImpact(id)` for one candidate. Generate the verb with a rule:
≥3× `tripled`, ≥2× `doubled`, >0 `rose {n}%`, <0 `fell {n}%`.

**Acceptance.** [ ] numbers are the API's, not rounded differently [ ] "Not a
poll" is always present [ ] text stays inside 48 px safe margins.

---

## 12. Remaining section I — "How we did this"

One 62ch column of 14.5 px serif, `ink-soft`, above the footer. Content:

> We collected TikTok and Instagram videos mentioning candidates from the Oriane
> index posted between {first} and {last}. The index does not cover every video,
> so counts describe our sample. For each video, a language model extracted three
> parts: the fact, matched to a list of facts we wrote and checked against the
> creator's own words; what the creator said it meant, grouped into a short
> label; and the verdict, the candidate it was aimed at and whether for or
> against. Each part is kept only when its quote appears word for word in the
> video. Our hand-labelled checks are reported in `docs/stance-model-analysis.md`.
> We record how creators interpret facts; we do not judge whether those
> interpretations are accurate. This is not a poll.

Footer: `Factpicker · Not a poll · Data through {date}`.

---

## 13. Lovable prompt pack

Paste in this order. One prompt per step; do not let Lovable bundle the whole
site into one generation.

**Prompt 1 — shell**

> Build a Next.js + Tailwind + shadcn site called Factpicker. Page background
> `#faf7ef`, text `#191512`. Fonts: Playfair Display (headlines), Source Serif 4
> (prose), Inter (UI). Content column max 1180 px with 24 px side padding. Header:
> 56 px tall, 1 px bottom border `#dcd4c4`, a three-bar mark (two ochre bars, one
> ink) + "Factpicker" wordmark at 17 px, nav Story only (Events / Facts are
> added when those pages ship) plus the EN/FR control, with a `#f2ece0` rounded
> pill on the active item. No shadows, no gradients, no
> default shadcn card styling. Add CSS variables for: paper `#faf7ef`,
> paper-deep `#f2ece0`, ink `#191512`, ink-soft `#5b544a`, rule `#dcd4c4`,
> ochre `#b9852c`, ochre-ink `#7d5518`, ochre-soft `#f1e3c8`, tile `#211d1a`,
> for `#5b7fc7`, against `#b9852c`, none `#b9b3a6`.

**Prompt 2 — hero**

> Add a centred hero: a 11.5 px uppercase ochre-ink kicker "PRÉSIDENTIELLE 2027 ·
> AUGUST TO NOVEMBER 2026"; an H1 "Same facts, opposite opinions" in Playfair at
> clamp(2.75rem, 6.4vw, 5.25rem), line-height .98, tracking -.025em, forced break
> before "opinions" at ≥768 px; a serif intro at clamp(1.15rem, 2vw, 1.5rem),
> max 46ch; a 13 px byline "By [Your name] · Data through {date}". Do not add a
> subheading, badge, or CTA.

**Prompt 3 — anatomy**

> Below the hero, add "Anatomy of an opinion" (Playfair, clamp(2rem,3.4vw,2.85rem))
> with a serif intro line. Under it a row of pill buttons (`@handle`, 13 px, 32 px
> tall, active = ink fill with paper text) and a ghost "Pause rotation" control at
> the end. Then a 2-column grid: 300 px video tile (aspect 4/5 on mobile, 9/15 at
> ≥640 px, dark tile, thumbnail, centred 56 px play circle, handle + platform +
> views bottom-left, plus a 12.5 px "Open on {platform} ↗" link) and a quote
> column. The quote is one serif block at clamp(1.35rem,2.1vw,1.9rem),
> line-height 1.52, wrapped in curly quotes, made of four spans: opening (plain),
> fact (solid 2 px ink underline, offset 4 px), meaning (dotted 2.5 px ochre
> underline, offset 6 px), verdict (ochre fill, `#fffaf0` text, padding .04em
> .16em). Use `box-decoration-break: clone`. Below the quote, three legend
> columns separated by rules: 2 px solid ink / 2.5 px dotted ochre / 2.5 px solid
> ochre, each with an 11 px uppercase label and a 15 px serif description.

**Prompt 4 — anatomy behaviour**

> Clicking the tile replaces it with an iframe of `embedUrl` (9/16, allow
> autoplay; no download or re-host). Auto-advance the card every 9 s; pause on
> hover and on focus within; never auto-advance when `prefers-reduced-motion:
> reduce`; the toggle has `aria-pressed`. Animate the quote swap only: 260 ms,
> `cubic-bezier(.16,1,.3,1)`, 3 px rise. If a card has no opening segment, omit
> it — never invent text.

**Prompt 5 — readings / sankey**

> Add "One fact, many readings" with an intro, a row of fact pills sorted by video
> count, then a bordered panel: eyebrow "The fact", the fact title in Playfair,
> and "`{statement} · N videos`". Below it, render a three-column flow diagram
> from `{ nodes, links }`: a 10 px ink bar at left; reading nodes at x=300
> (340 wide, 46–76 tall, paper fill, `#dcd4c4` border, 6 px radius, serif label +
> right-aligned count); verdict bands at x=820 (250 wide, 64 tall, soft fill +
> 4 px colour keyline). Links are cubic Bézier ribbons: fact→reading at 30%
> opacity in `#dcd4c4`; reading→verdict at 42% in the verdict colour. Hovering a
> reading dims unrelated ribbons to 8%. Under 640 px replace the diagram with a
> list of readings, each with a 10 px stacked verdict bar and a legend row.
> Caption, centred, 62ch: "Of {n} videos citing this fact, {a}% used it against a
> candidate, {f}% in support of one, and {x}% took no side. The most common
> reading: “{label}”." If `videos < 4`, show the "not enough to read a breakdown"
> message instead.

**Prompt 6 — events / facts pages**

> Build the Events page: three bordered event panels (active = ink fill), each
> with date, title, "N videos in the 14-day window"; below, a per-candidate
> before/after table with a dot-line-dot scale, `before → after`, `+N%` (or `—`
> when before is 0), and a 3-segment leaning bar. Then a three-up comparison with
> "Biggest increase". Build the Facts page: fact pills, an anchor-fact header with
> three metrics and a source link, a "What creators say it led to" list with
> leaning bars, a selected-story panel with candidate chips, and two video cards
> with verbatim "Fact" / "Led to" rows. Same tokens, same type scale, no cards
> inside cards.

---

## 14. What not to do

- Do not use Lovable's default fonts, greys, or `rounded-xl shadow-sm` cards.
- Do not centre body copy wider than 62ch.
- Do not colour small text with `ochre`; use `ochre-ink`.
- Do not print `0%` for an undefined change — use `—`.
- Do not claim "2,200 videos" or "verified" unless the API says so.
- Do not shrink the Sankey below 640 px; switch to the list.
- Do not autoplay the embed or auto-rotate under reduced motion.
- Do not label a creator from a single video (`minVideos` is 2).
- Do not paraphrase a quote in the anatomy or the fact cards.
- Turn off Lovable's dark-mode toggle and theme switcher: the brief is light-only.
- Do not add a hero image, logo illustration, or icon set beyond the three-bar
  mark and Lucide icons already used.

## 15. Mock payload (build the UI before the API is wired)

Use this shape so components can be built without the service. Replace every
value with the API's; never ship these numbers. `links` is truncated for
brevity — render whatever the API returns and reconcile against `nodes`.

```json
{
  "dataset": { "videos": 217, "window": { "first": "2026-08-08", "last": "2026-11-02" } },
  "entryPage": [{
    "videoId": "cnt_demo",
    "coverage": "full",
    "quality": 1,
    "fact": { "id": "pension_2023_64", "statement": "The 2023 pension reform raised the legal retirement age to 64", "verified": false },
    "verdict": { "candidateId": "philippe", "candidate": { "name": "Édouard Philippe" }, "leaning": "CRITICAL", "verified": true },
    "attribution": {
      "handle": "lesprit.critique", "platform": "INSTAGRAM",
      "platformId": "De15tiqjcIb",
      "embedUrl": "https://www.instagram.com/p/De15tiqjcIb/embed",
      "views": 4352094, "postedAt": "2026-10-23T00:00:00.000Z",
      "thumbnailUrl": "https://…", "url": "https://www.instagram.com/p/De15tiqjcIb/", "format": "talking"
    },
    "segments": [
      { "role": "OPENING", "text": "Cette semaine, on voulait parler de samedi dernier", "truncated": true,
        "style": { "underline": "none", "tone": "ink", "fill": false, "className": "anatomy-segment--opening", "legend": "Opening", "description": "The creator's opening words, shortened." } },
      { "role": "FACT", "text": "Réforme des retraites, des millions de gens dans la rue.", "truncated": false,
        "style": { "underline": "solid", "tone": "ink", "fill": false, "className": "anatomy-segment--fact", "legend": "1 · THE FACT", "description": "Matched to our fact list and checked against the source." } },
      { "role": "MEANING", "text": "Trois quarts des Français contre, la majorité de l'Assemblée contre.", "truncated": false,
        "style": { "underline": "dotted", "tone": "ochre", "fill": false, "className": "anatomy-segment--meaning", "legend": "2 · WHAT THEY SAY IT MEANS", "description": "The creator's interpretation. We record it; we don't judge it." } },
      { "role": "VERDICT", "text": "Celui qui résume encore mieux le pouvoir, c'est Édouard Philippe.", "truncated": false,
        "style": { "underline": "none", "tone": "ochre", "fill": true, "className": "anatomy-segment--verdict", "legend": "3 · THE VERDICT", "description": "Who it is aimed at, and whether it is for or against them." } }
    ]
  }],
  "facts": [{
    "id": "cost_of_living", "category": "Cost of living",
    "statement": "Prices rose faster than wages, squeezing household purchasing power", "videos": 34,
    "sankey": {
      "nodes": [
        { "id": "fact", "label": "Cost of living", "column": 0, "videos": 34, "views": 0 },
        { "id": "reading:protests", "label": "Sparked protests", "column": 1, "videos": 10, "views": 0 },
        { "id": "reading:funding", "label": "About funding the system", "column": 1, "videos": 6, "views": 0 },
        { "id": "verdict:FOR", "label": "For a candidate", "column": 2, "videos": 6, "views": 0 },
        { "id": "verdict:AGAINST", "label": "Against a candidate", "column": 2, "videos": 12, "views": 0 },
        { "id": "verdict:NONE", "label": "No side", "column": 2, "videos": 16, "views": 0 }
      ],
      "links": [
        { "source": "fact", "target": "reading:protests", "videos": 10, "views": 0 },
        { "source": "reading:protests", "target": "verdict:AGAINST", "videos": 6, "views": 0 },
        { "source": "reading:protests", "target": "verdict:NONE", "videos": 4, "views": 0 }
      ],
      "summary": { "videos": 34, "forPct": 17.6, "againstPct": 35.3, "nonePct": 47.1, "topReading": "Sparked protests" }
    }
  }]
}
```

## 16. Reference implementation

`web-demo/src/` is the source of truth for section A and B: `app/page.tsx`,
`components/anatomy-card.tsx`, `components/readings-sankey.tsx`,
`app/globals.css`, `lib/graphql.ts`. Copy the class strings from there rather
than rewriting them.
