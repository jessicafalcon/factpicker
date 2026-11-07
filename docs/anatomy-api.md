# Anatomy of an opinion — API integration

The entry-page card from the brief, rendered from recorded data. Contract:
`anatomy(videoId)` and `entryPage(limit)` in `api/schema.graphql`.
Extractor: `api/src/anatomy.ts`. Prefetched artifact: `data/analyses/anatomy.json`
(`npm run anatomy`, no API calls).

## 1. Placeholder → field

| Placeholder in the design | Field | Notes |
|---|---|---|
| `@creator_handle` (bottom of the video) | `attribution.handle` | no `@`; the UI adds it |
| `TikTok · 640k views` | `attribution.platform`, `attribution.views` | `Platform` enum |
| Thumbnail / play target | `attribution.thumbnailUrl`, `attribution.url` | `url` opens the post |
| Publication time | `attribution.postedAt`, `attribution.format` | ISO timestamp |
| `"[Opening words from the transcript]..."` | `segments[role=OPENING].text` | first 12 words, stops before the fact; `truncated` → render an ellipsis |
| `"[the fact, as the creator states it …]"` | `segments[role=FACT].text` + `fact.id`, `fact.statement`, `fact.sourceName`, `fact.verified` | the anchor sentence; `verified` is false until a journalist checks the source |
| `"[what they say it means: …]"` | `segments[role=MEANING].text` | the sentence that follows the fact |
| `"[their verdict: … [Candidate] …]"` | `segments[role=VERDICT].text` + `verdict.candidate`, `verdict.leaning`, `verdict.quote`, `verdict.verified` | the verified stance quote or the sentence around it |
| Legend `1 · THE FACT` / `2 · …` / `3 · …` | `segments[].style.legend`, `style.description` | text is in the API so the legend cannot drift |

Every segment is a **verbatim slice** of one cleaned source text:

```
sourceText.slice(segment.start, segment.end) === segment.text   // trimmed
composed.slice(segment.composedStart, segment.composedEnd) === segment.text
composed === segments.map(s => s.text).join(" ")
```

`segments[]` arrive in the design's step order — `OPENING → FACT → MEANING →
VERDICT` — and their **source** spans never overlap or duplicate each other. The
composed quote is therefore a curated sequence, not a contiguous passage; each
segment still points at its own verbatim position with `start`/`end`.

## 2. Style contract (image #2)

Each segment carries the token set, so the frontend does not hard-code roles:

```json
{
  "role": "FACT",
  "style": {
    "underline": "solid",
    "tone": "ink",
    "fill": false,
    "className": "anatomy-segment--fact",
    "legend": "1 · THE FACT",
    "description": "Matched to our fact list and checked against the source."
  }
}
```

| Role | underline | tone | fill | Meaning in the brief |
|---|---|---|---|---|
| `OPENING` | `none` | `ink` | `false` | quoted context, no decoration |
| `FACT` | `solid` | `ink` | `false` | "1 · THE FACT" — matched to the fact list |
| `MEANING` | `dotted` | `ochre` | `false` | "2 · WHAT THEY SAY IT MEANS" — the interpretation |
| `VERDICT` | `none` | `ochre` | `true` | "3 · THE VERDICT" — filled highlight |

Reference CSS (tokens are placeholders — bind them to the site palette):

```css
.anatomy-segment--fact    { text-decoration: underline solid currentColor; text-underline-offset: 3px; text-decoration-thickness: 1.5px; }
.anatomy-segment--meaning { text-decoration: underline dotted var(--anatomy-ochre); text-underline-offset: 4px; }
.anatomy-segment--verdict { background: var(--anatomy-ochre); color: var(--anatomy-paper); padding: 0 .15em; box-decoration-break: clone; }
.anatomy-segment--opening { color: inherit; }
```

## 3. Render recipe

```jsx
<article className="anatomy">
  <a className="anatomy__media" href={a.attribution.url}>
    <img src={a.attribution.thumbnailUrl} alt="" />
    <span className="anatomy__handle">@{a.attribution.handle}</span>
    <span className="anatomy__meta">{platformLabel(a.attribution.platform)} · {compact(a.attribution.views)} views</span>
  </a>

  <blockquote className="anatomy__quote">
    {a.segments.map((segment) => (
      <span key={segment.role} className={segment.style.className}>{segment.text}</span>
    ))}
  </blockquote>

  <ol className="anatomy__legend">
    {["FACT", "MEANING", "VERDICT"].map((role) => {
      const style = a.segments.find((s) => s.role === role)?.style;
      return style && (
        <li key={role} className={style.className}>
          <strong>{style.legend}</strong>
          <p>{style.description}</p>
        </li>
      );
    })}
  </ol>
</article>
```

Notes:
- Render segments **in the order given**. They already follow the design's steps;
  a verdict spoken before the fact still appears as step 3, with its own source span.
- Add an ellipsis only when `segment.truncated` is true.
- Do not wrap the verdict in a second `<mark>`: `fill: true` already encodes the highlight.

## 4. Coverage and quality

| `coverage` | Meaning | Render |
|---|---|---|
| `full` | opening (optional) + fact + meaning + verdict | the full card |
| `no_meaning` | no distinct interpretation sentence | fact + verdict, skip step 2 |
| `no_verdict` | stance quote is the same sentence as the fact | fact + meaning, no step 3 |
| `no_fact` | no fact-catalog anchor in the text | not an entry card |
| `no_text` | under 40 characters of usable text | not an entry card |

`quality` (0..1) scores readability: segment lengths, punctuation density, word
variety. `entryPage` only returns `coverage: "full"` with `quality >= 0.6`, one
card per creator, ranked by quality then reach, with one 17 October video forced
into the set to match the brief's opening.

## 5. What the extractor does, and does not

- **Fact** = the sentence containing an anchor term from `api/data/facts.json`,
  starting at the sentence boundary so it reads as a statement. A one-word hit
  ("OQTF.") is not promoted.
- **Meaning** = the next sentence after the fact, unless that sentence is the
  verdict (then it is skipped rather than duplicated).
- **Verdict** = the verified stance quote (`exact`/`fuzzy`) or the sentence
  around the candidate mention. A label whose quote failed verification is never
  used.
- It does **not** paraphrase, summarise or invent. If the three steps do not
  exist in the text, the card reports lower coverage instead of manufacturing one.

## 6. Playback and rotation

- The tile renders the real `thumbnailUrl`. Clicking mounts
  `attribution.embedUrl` in an iframe (TikTok / Instagram / YouTube's own player),
  so playback stays inside the platform and the app re-hosts nothing. If there is
  no embed id, the click opens the post instead.
- The card rotates to the next handle every 9 s. It pauses on hover, on keyboard
  focus, when the tab is hidden, and always when `prefers-reduced-motion` is set;
  the toggle in the chips row is the explicit control (`aria-pressed`).
- Rotation and the embed are verified in a browser over CDP, not just asserted:
  clicking mounts an iframe with the expected `src`, and after 10 s the active
  chip changes.

## 7. Current yield

`npm run anatomy` over the 217-video snapshot: **211 items**, of which
**18 are `full`**, 26 `no_verdict`, 7 `no_meaning`, 160 `no_fact`. Six pass the
entry gate — the binding constraint is the six-fact catalog, not the videos.
Adding facts to `api/data/facts.json` increases yield with no code change.

Sample entry card (ulyces.co, 1.2M views, 17 October thread):

```
FACT     Une vidéo tournée samedi 17 octobre à Amiens provoque une vive polémique…
MEANING  Selon les médias locaux, six fourgons de police auraient été mobilisés…
VERDICT  Dupont-Aignan a notamment dénoncé une différence de traitement…
```
