# data/

Everything here is produced by scripts, never hand-edited. Re-run the script to
refresh; the file names are stable so the UI and the docs can rely on them.

```
data/
├── raw/                              # what Monid scraped, untouched
│   ├── wikipedia-2027.json/.txt          main election article (dataforseo extract)
│   ├── wikipedia-candidatures.json/.txt  declared-candidacies article
│   ├── tavily-candidatures.json          markdown render of the same page
│   └── candidatures.md                   203 KB clean markdown, parsed for the roster
├── query-plan.json                   # live counts per candidate + the canonical body
├── oriane/
│   ├── _query-catalog.json           # all 34 catalog queries with resolved bodies
│   ├── _filter-matrix.json           # measured granularity of every filter facet
│   ├── top10-all.json                # 217 unique videos + 865 mentions, normalized
│   ├── <candidate>.json              # one file per candidate (31)
│   └── _query.json                   # exact Oriane body used for each candidate
├── analyses/
│   ├── prompts.json                  # every (video × candidate) prompt, verbatim
│   ├── analyses.json                 # filled by `npm run analyze` (needs LLM_API_KEY)
│   ├── claims.json                   # verified claims only
│   ├── failures.json                 # per-pair errors, for retry
│   ├── creator-stance.json           # deterministic stance ETL output (no model calls)
│   ├── creator-stance-vertex.json    # specimen with a bounded Vertex escalation run
│   ├── candidate-stance.json         # per-candidate stance + metrics (Gemini, batched)
│   ├── stance-videos.csv             # one row per video×candidate, with quote
│   ├── stance-creators.csv           # one row per creator×candidate
│   ├── .vertex-cache.json            # model verdicts; makes re-runs free
│   ├── events.json                   # events + issue_groups + candidate_topic_matrix
│   ├── events.csv                    # long format: one row per event × active day
│   ├── gold-stance.json              # 24 hand-labelled videos (stance ground truth)
│   ├── stance-ablation.json          # baseline vs few-shot vs pro vs embeddings
│   ├── runs/                         # versioned stance rules (v1-exact, v2-fuzzy)
│   ├── timeline-stats.json           # range, monthly/weekly/daily, hours, gaps, per candidate
│   ├── timeline-monthly.csv
│   ├── timeline-weekly.csv
│   └── timeline-candidates.csv
└── verify/                           # COPY payloads used by scripts/verify-schema.sh
```

## Provenance

| Artifact | Source | Retrieved |
|---|---|---|
| `raw/wikipedia-*` | `fr.wikipedia.org` via Monid (`dataforseo /onpage/content-parsing`, `tavily /extract`) | 2026-11-07 |
| `oriane/*` | `connect.oriane.xyz/rest/contents/search` (`projection=full`) | 2026-11-07 |
| `query-plan.json` | live count probes | regenerated per run |

The candidate roster comes from the *Candidatures à l'élection présidentielle
française de 2027* page (revision 31 Oct 2026), cross-checked against the
first-round polling table of the main article (Ifop / Ipsos / OpinionWay, late
Oct 2026). 30 declared candidates, plus Jordan Bardella as a discussed
non-candidate.

## Shape of `top10-all.json`

```jsonc
{
  "generatedAt": "2026-11-07T…",
  "query": { "since": "2026-06-01", "sort": "interactionsCount:desc,viewsCount:desc", "perCandidate": 10 },
  "candidates": [{ "id": "lepen", "name": "Marine Le Pen", "party": "…", "status": "declared", "tier": "frontrunner", "communities": ["…"] }],
  "stats": { "videos": 217, "mentions": 865, "french": 209, "imagePosts": 47, "withTranscript": 176 },
  "mentionCounts": { "strong": { "lepen": 55 }, "weak": { "lepen": 31 } },
  "videos": [ /* VideoRow: id, platform, url, creator_*, views, caption, transcript, on_screen_text, format, is_french … */ ],
  "mentions": [ /* video_id, candidate_id, matched_terms, source_field, source_key, strength, occurrences[{start,end}] */ ]
}
```

`occurrences` are character offsets into the field named by `source_key`
(`transcript`, `caption`, `on_screen_text[2]`), so the evidence highlight is
`text.slice(start, end)` with no re-matching in the browser.

## `analyses/creator-stance.json`

Produced by `npm run stance` (see `docs/creator-stance-etl.md`).

```jsonc
{
  "generatedAt": "2026-11-07T…",
  "params": { "minVideos": 2, "neutralBand": 0.15, "vertex": null },
  "stats": { "videos": 217, "scoredPairs": 450, "favorable": 21, "critical": 15,
             "unclear": 414, "creatorCandidatePairs": 331, "modelCalls": 0 },
  "rows": [ /* creator × candidate: videos, favorable, critical, neutral, unclear,
               stance_index, view_weighted_index, label, evidence[] */ ],
  "perVideo": [ /* video × candidate: score, label, basis, markers, quote */ ],
  "creatorTotals": [ /* per handle across candidates */ ],
  "escalations": [ /* Vertex calls, with reason and result */ ]
}
```

`label` values and thresholds are documented in `docs/creator-stance-etl.md`.
`single_video` and `insufficient` mean the sample cannot support a
creator-level stance — the UI shows the video-level label instead.

## Stance run history

`data/analyses/runs/` keeps every rule version instead of overwriting:

| Run | Rule | Unclear | Coverage |
|---|---|---:|---:|
| `runs/v1-exact` | model verdict accepted only on a verbatim quote | 56/273 | 79.5% |
| `runs/v2-fuzzy` | + fuzzy sentence evidence + relevance/namesake rules | 41/273 | 85.0% |

`runs/comparison.json` scores both on the 24-video gold set, and
`docs/stance-model-analysis.md` explains the ablation and the recommended model.
`events.json` also carries the three-level hierarchy (`issue_groups`:
major issue → sub-issue → topics/events) and `candidate_topic_matrix`
(what each candidate is talked about, with leaning counts).

The root `candidate-stance.json` is the last promoted run; new runs write to
`data/analyses/runs/<version>/` unless `--out-dir data/analyses` is passed
explicitly.

## Regenerating

```bash
npm run pull:top10      # Oriane -> data/oriane/
npm run probe:filters   # -> data/oriane/_filter-matrix.json
npm run demo            # -> data/query-plan.json + _query-catalog.json
npm run analyze         # -> data/analyses/ (dry-run without LLM_API_KEY)
npm run stance          # -> data/analyses/creator-stance.json (no API calls)
npm run stance:candidates  # -> candidate-stance.json + CSVs (Gemini, ~209 calls, cached)
npm run timeline        # -> timeline-stats.json + timeline-*.csv (no API calls)
npm run events          # -> events.json + events.csv (no API calls)
npm run stance:eval     # -> runs/v1-exact, runs/v2-fuzzy, runs/comparison.json (no API calls)
npm run stance:ablation # -> stance-ablation.json (few-shot / pro / embeddings, cached)
./scripts/verify-schema.sh   # migrations + load on throwaway Postgres 16
npm test                # validates all of the above
```

## Timeline snapshot

`timeline-stats.json` covers **2026-08-08 23:43 UTC → 2026-11-02 15:01 UTC**
(85 days, 12.1 weeks, 77 active days out of 86), bucketed in Europe/Paris
time. Findings and caveats: `docs/timeline-stats.md`.

The window is an artifact of the pull (`since=2026-06-01`, top 10 per candidate
by interactions): nothing older than early August survived the engagement cut,
so do not read the start of the range as the start of the campaign.

## Notes and known limits

- **French-only demo.** Foreign-language videos are fetched then dropped by
  `detectFrench`; `stats.french` must stay ≥ 90% of `stats.videos` (the dataset
  test enforces it).
- **Low-volume candidates.** Becht and Markovic return 1 usable French video
  each. That is a finding, not a bug: the overview ranks by video count, so they
  fall to the bottom on their own.
- **OCR noise.** On-screen text on video is partial (`"L'HEU"`, `"ES PROS"`).
  Trust captions and full lines over fragments.
- **No video URLs from the API.** `url` is constructed from `platformId` +
  `platformType`; the Instagram value is the shortcode, not the media id.
- **Stance is a sample statistic.** 36 of 450 video×candidate scores are
  decisive with the lexicon alone; the rest are `unclear` or escalated to
  Vertex. Never characterise a handle from fewer than 2 videos.
- **Vision scores are loose.** `visualSimilarity` means "similar scene", not
  "same person". Keep `minScore ≥ 0.3` and pair with a text filter.
