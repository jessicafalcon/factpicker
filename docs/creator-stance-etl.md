# Creator × candidate stance — ETL and method

Answers: **does this handle's coverage favour or attack this candidate, and how
many of its videos do so?** Built to run offline on data already on disk, with
no new Oriane calls.

Status: implemented, tested, and loaded into BigQuery
(`your-gcp-project.cadrage2027.creator_stance`, 331 rows, 137
creators, 31 candidates, 2026-11-07).

---

## 1. What it produces

Two grains, because they answer different questions:

| Grain | Table | Answers |
|---|---|---|
| video × candidate | `video_stance` | what this single post does |
| creator × candidate | `creator_stance` | how this handle covers this candidate, over N videos |

Per creator × candidate row: `videos`, `favorable`, `critical`, `neutral`,
`unclear`, `stance_index`, `view_weighted_index`, `avg_score`, `label`,
`total_views`, and up to three evidence snippets with their marker terms.

```
stance_index = (favorable - critical) / videos          # -1 … +1
label:
  favorable           index >= 0.6
  leaning_favorable   index >= 0.2
  mixed               -0.2 < index < 0.2
  leaning_critical    index <= -0.2
  critical            index <= -0.6
  single_video        exactly one video — the handle is NOT characterised
  insufficient        fewer videos than min-videos (default 2)
  no_signal           enough videos, none expressing a stance
```

A per-video score is `favourable` when `score >= +0.15`, `critical` when
`<= -0.15`, `neutral` inside the band, `unclear` with no usable marker.

**Copy rule.** The output describes posts, never people. Say "4 of this handle's
6 videos about X attack them", not "this creator is biased". `single_video` rows
exist precisely so the UI cannot label a person from one post.

---

## 2. Method: deterministic first, model second

The idea doc's principle — AI only where language needs it — applied to
sentiment.

### 2.1 Lexicon pass (`sentiment.ts`)

1. **Scope.** Caption and on-screen text first, because that is what the creator
   typed and what the viewer reads before pressing play. The transcript is a
   fallback, and the row records `basis: "transcript_fallback"`.
2. **Matching.** 160 weighted French markers, matched with the same
   accent-folding regex as candidate names, so `fierté`/`fierte`,
   `extrême-droite`/`extreme droite` and `MÉLENCHON` all match. Handles
   negation (`ne … pas`, `refuse de`) and intensifiers (`très`, `vraiment`).
3. **Sentence anchoring.** A marker only counts when the candidate is named in
   the same sentence. This is the fix for OCR/round-up noise: "…Édouard Philippe
   était au Havre. La cathédrale est magnifique." no longer scores as praise.
4. **Bounded coreference (transcripts only).** Spoken French uses pronouns. If
   exactly one candidate was named in the two preceding sentences, the marker is
   attributed to them. Captions never use this rule — they name their subject.
5. **Agent vs target.** `"Polony dénonce l'excès de zèle"` is Polony acting, not
   Polony attacked. When the candidate precedes one of `dénonce / accuse /
   attaque / critique / se moque`, the marker is skipped. `"Darmanin accuse Le
   Pen de mollesse"` keeps the marker, because Le Pen is the object.
6. **Typed signals.** Hashtags that combine a name token with an intent word
   (`#avecmarine`, `#jlm2027`, `#votezlepen`) count as support. `#marinebiology`
   does not.
7. **Evidence floor.** One weak marker is noise. A video needs one strong marker
   (weight ≥ 1.5) or two markers, or it is `unclear` with score 0.
8. **Irony guard.** If the creator writes `ironie`, `second degré`, `sarcasme`,
   `je blague`, the video is `unclear`. Believe the creator.

Descriptive ideology words (`extrême droite`, `communiste`, `nationaliste`) were
removed from the lexicon entirely: they describe a position, they do not express
a stance, and they were producing false "critical" labels on neutral reporting.

### 2.2 Batched Gemini pass (`scripts/candidate-stance.ts`)

For the candidate-level artifact the model is not an escalation, it is the main
reader — but it is **batched: one call per video, not per (video, candidate)
pair**. The post is sent once with every candidate that needs a verdict, and the
model returns one entry each. 273 pairs over 209 unique videos therefore cost
209 calls, not 273, and re-runs cost nothing thanks to
`data/analyses/.vertex-cache.json`.

Verified quotes only: a model verdict with a quote that is not a verbatim
substring of the caption, on-screen text or transcript is rejected, and the row
falls back to `unclear` with score 0 (`basis: "gemini:<model>:unverified"`).
Of 257 model verdicts, 214 survived that check and 43 were rejected.

### 2.3 Vertex AI escalation (`vertex.ts`, single-pair mode)

Only videos the lexicon cannot read are sent to `gemini-2.5-flash`:

| Condition | Reason |
|---|---|
| no marker at all | `no_lexicon_signal` |
| positive ≈ negative | `conflicting_markers` (usually irony) |
| otherwise | skipped — deterministic score stands |

The model returns `{stance, score, rationale, evidence_quote}`, and the quote is
re-verified as a verbatim substring before it is allowed into the table. Thinking
is disabled (`thinkingBudget: 0`): Gemini 2.5 otherwise spends the output budget
on hidden reasoning and returns an empty JSON part.

Cost control: **every attempt counts against `--max-vertex-calls`**, and three
consecutive errors abort the escalation, so a bad model id cannot become hundreds
of failed calls.

---

## 3. Cloud architecture

```
Supabase (videos, mentions)
        │  REST, service role
        ▼
Cloud Run job  pipeline/main.ts  ──►  deterministic stance
        │                               │
        │                               └─► Vertex AI (bounded, ambiguous only)
        ▼
Supabase creator_stance / video_stance          BigQuery cadrage2027.creator_stance
        │                                                 │
        └──────────────► Lovable dashboard ◄──────────────┘
```

| Piece | File |
|---|---|
| ETL | `pipeline/etl.ts`, `pipeline/main.ts` |
| Container | `pipeline/Dockerfile` (Node 24, no dependencies, no build step) |
| Deploy | `pipeline/deploy.sh` (API enablement, BQ dataset/table, image, job, optional scheduler) |
| BigQuery schema | `pipeline/schema/creator_stance.json` |
| Supabase schema | `supabase/migrations/0003_creator_stance.sql` |

The job reads Supabase when `--input` is absent, and writes Supabase
(`--write-supabase`) and BigQuery streaming inserts (`--write-bigquery`).
Inside GCP the OAuth token comes from the metadata server; locally from
`GOOGLE_ACCESS_TOKEN`.

### Deploy

```bash
export PROJECT=your-gcp-project
gcloud secrets create supabase-url --data-file=- <<< "$SUPABASE_URL"
gcloud secrets create supabase-service-role-key --data-file=- <<< "$SUPABASE_SERVICE_ROLE_KEY"
./pipeline/deploy.sh              # SCHEDULE=1 to add a daily 06:00 trigger
gcloud run jobs execute cadrage2027-stance --region europe-west1 --wait
```

### Verified on 2026-11-07

- `cadrage2027` dataset and `creator_stance` table created; 331 rows loaded and
  queried (137 creators, 31 candidates).
- Vertex `gemini-2.5-flash` reachable in `us-central1`: a synthetic favourable
  post scored `0.9 / favorable` and a hostile one `-0.8 / critical`, both with
  verified quotes.
- 8 real escalations on the dataset produced 8 usable stances, 0 errors.

---

## 3b. Candidate-level artifact

`npm run stance:candidates` reads `data/oriane/<candidate>.json`, scores every
French video described for a candidate **toward that candidate**, and writes:

| File | Contents |
|---|---|
| `data/analyses/candidate-stance.json` | per-candidate metrics, 273 video×candidate rows, 215 creator×candidate rows |
| `data/analyses/stance-videos.csv` | one row per video×candidate, with quote and URL |
| `data/analyses/stance-creators.csv` | one row per creator×candidate |
| `data/analyses/.vertex-cache.json` | model verdicts, so re-runs are free |

Per candidate: `videos`, `favorable`, `critical`, `neutral`, `unclear`,
`coverage`, `stance_index`, `avg_score`, `view_weighted_index`, `creators`,
`total_views`, `avg_views`, `favorable_pct`, `critical_pct`, `formats`,
`platforms`, and up to three evidence snippets.

Measured on 2026-11-07 (209 videos, 273 pairs, Gemini 2.5 Flash):

| Candidate | Videos | Fav | Crit | Neu | Unclear | Index | Coverage |
|---|---:|---:|---:|---:|---:|---:|---:|
| zemmour | 10 | 0 | 7 | 2 | 1 | -0.7 | 0.9 |
| attal | 10 | 0 | 6 | 3 | 1 | -0.6 | 0.9 |
| philippe | 10 | 0 | 6 | 2 | 2 | -0.6 | 0.8 |
| retailleau | 10 | 0 | 6 | 2 | 2 | -0.6 | 0.8 |
| lepen | 10 | 1 | 6 | 1 | 2 | -0.5 | 0.8 |
| labib | 10 | 5 | 0 | 3 | 2 | 0.5 | 0.8 |
| melenchon | 10 | 4 | 0 | 2 | 4 | 0.4 | 0.6 |
| polony | 10 | 5 | 1 | 2 | 2 | 0.4 | 0.8 |
| kazib | 10 | 6 | 2 | 2 | 0 | 0.4 | 1.0 |

215 of 273 pairs carry a decisive label (79% coverage), against 25 with the
lexicon alone. The negative index on the five best-covered frontrunners reflects
what the top-viewed clips actually say — convictions, satire, and critical
framing dominate — and every row carries the quoted evidence for a journalist to
check.

## 4. Reading the numbers

Current deterministic pass over the 217-video snapshot: 450 video×candidate
scores, 36 decisive, 414 unclear, 331 creator×candidate rows, 13 of which carry
a creator-level label.

That is the honest state of a lexicon on this corpus:

- Most videos are newsroom reports — genuinely `no_signal`.
- Most creators appear once per candidate — `single_video`, by design.
- OCR text on video is partial and noisy (`"ALENTE ATTAQUE A TRAPPES"`).
- Satire (Le Gorafi) and rhetorical questions defeat any word list.

Vertex escalation raises coverage, and the evidence quote is always shown, so a
journalist can accept or reject the label in one glance. That is the point of the
design: **the label is a claim about a post, with its receipt attached.**

### Known limitations (put these on the "How this works" page)

1. Lexicon sentiment reads words, not arguments. Reporting on an attack is
   scored like an attack.
2. Irony is only caught when the creator flags it or the model is asked.
3. OCR fragments can credit a slogan to the wrong sentence.
4. Small samples: never characterise a handle below 2 videos.
5. `stance_index` is a summary of this sample, not a measure of the person.

---

## 5. Commands

```bash
npm run stance:candidates      # Gemini, batched one call/video -> data/analyses/candidate-stance.json
npm run stance:candidates -- --dry-run          # deterministic only, 0 calls
npm run stance                 # deterministic, reads Supabase, writes JSON
npm run stance -- --input data/oriane/top10-all.json
npm run stance -- --vertex --max-vertex-calls 5       # + bounded model calls
npm run stance -- --write-supabase --write-bigquery   # cloud load
npm test                       # 58 tests incl. stance unit + dataset invariants
./scripts/verify-schema.sh     # migrations + load against a throwaway Postgres
```
