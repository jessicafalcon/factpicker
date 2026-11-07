# Stance extraction: why it says "unclear", and what to use instead

Investigation date **2026-11-07**. All numbers come from local data
(`data/oriane`, 217 videos) and paid calls that were capped and cached. Every
claim below has a file or a command behind it.

Artifacts: `data/analyses/stance-ablation.json`,
`data/analyses/gold-stance.json`,
`data/analyses/runs/{v1-exact,v2-fuzzy}/`, `data/analyses/runs/comparison.json`.

---

## 1. The premise, checked

The "7 or 8 of 10 unclear" figure matches the **deterministic lexicon** artifact,
not the Gemini one:

| Artifact | Rule | Unclear |
|---|---|---:|
| `creator-stance.json` | lexicon only, no model | **412 / 450 = 91.6%** |
| `candidate-stance.json` (v1) | Gemini zero-shot, verbatim evidence only | **58 / 273 = 21.2%** |
| `runs/v2-fuzzy` | Gemini cache + fuzzy evidence + relevance rules | **41 / 273 = 15.0%** |

The v1 figure is from the original artifact; the reconstruction in
`runs/v1-exact` gives 56 because it re-verifies quotes across all three fields
(see §5). Both are far from 91.6%.

So the model is not returning unclear for 8 of 10 videos. The 91.6% figure is the
word-list baseline, which is a different component. Still, 21% → 15% is not good
enough, and the rest of this document is about where those 58 cases actually come
from.

## 2. Ground truth first

To measure anything I hand-labelled 24 videos (12 that the model called unclear,
12 that it called decisive, stratified across candidates): `gold-stance.json`.

| Gold label | Count |
|---|---:|
| neutral | 12 |
| irrelevant (candidate not actually discussed) | 5 |
| critical | 3 |
| favorable | 2 |
| ambiguous | 2 |

**Only 5 of 24 posts carry a stance at all.** That is the first real finding: the
candidate files are dominated by listicles, news quotes and OCR noise, so a low
decisive rate is partly the truth about the corpus, not a model failure. Labelling
was done from caption + on-screen text + transcript before running any new
configuration.

## 3. Where the 58 "unclear" actually come from

| Cause | Pairs | Evidence |
|---|---:|---|
| Candidate not in the text at all (`absent`) | 12 | `assessRelevance` returns absent; e.g. Spanish Messi video in Arthaud's file |
| Model returned a stance but **no quote** | 26 | empty `evidence_quote` in `.vertex-cache.json` |
| Model returned a stance **with a quote that failed verbatim matching** | 17 | 16 of them recoverable by sentence-level fuzzy matching |
| List rows (candidate named inside a candidate list) | 71 | `assessRelevance` = listicle; these were being counted as unclear instead of neutral |

Only **17 of 58** are "the model was unsure and hedging". The rest are a taxonomy
problem (neutral vs unclear vs irrelevant) and an evidence-matching problem.

## 4. Ablation: zero-shot vs few-shot vs Pro vs embeddings

Same 24 gold items, same prompts except the variable under test. 18 batched calls
per configuration, 0 failures.

| Config | Agreement | Stance recall | Stance precision | False stance |
|---|---:|---:|---:|---:|
| A. `gemini-2.5-flash`, zero-shot (baseline) | **87.5%** | 40% | 100% | 0 |
| B. `gemini-2.5-flash` + 6 French exemplars | **87.5%** | **60%** | 75% | 1 |
| C. `gemini-2.5-pro`, zero-shot, thinking=512 | 83.3% | 20% | 100% | 0 |
| D. `gemini-embedding-001` nearest-anchor | 58.3% | 40% | 36.4% | 7 |

Read it carefully:

- **Few-shot is the only thing that improves recall** (40% → 60%), at the cost of
  one false positive (a stool joke labelled critical for Asselineau). Net
  agreement is unchanged because the sample is small; the direction is what
  matters, and it is the cheap fix.
- **Pro is worse, not better.** It is more conservative (recall 20%) and costs
  ~10x more per call. For this extraction task a bigger model does not buy
  accuracy; it buys hedging.
- **Embeddings are unusable as a stance classifier.** 58% agreement, 7 false
  stances out of 11 predictions. Cosine similarity to "support"/"attack" anchors
  cannot separate *"he attacks X"* from *"X attacks him"*, which is most of
  political speech.

### The relevance gate (negative result)

A text-only gate scored **45.8%** on a three-way decision
(`stance_possible` / `neutral_only` / `irrelevant`):

```
irrelevant      -> stance_possible 5/5   (never detected)
neutral_only    -> 7 correct, 6 missed, 1 wrong
stance_possible -> 4 correct, 1 wrongly suppressed
```

Its listicle detector is precise when it fires (7/7), but it misses 6 of 12 list
rows and cannot tell "Pierre Cazeneuve" from "Bernard Cazeneuve". **Do not use it
as a filter.** Its only safe use is the curated namesake guard for ambiguous
surnames.

## 5. Evidence matching: the cheap 80-row win

`matchEvidence` does verbatim first, then a sentence-level fuzzy match, and
always returns a real substring of the source (never invented text):

| Rule | Exact evidence | Fuzzy evidence | Unclear | Coverage |
|---|---:|---:|---:|---:|
| v1: verbatim only | 214 | 0 | 56 | 79.5% |
| v2: verbatim + fuzzy + relevance rules | 144 | **80** | 41 | **85.0%** |

On the gold set v2 keeps 87.5% agreement and 100% precision. The fuzzy path was
never the source of a wrong label: every fuzzy match had similarity ≥ 0.91, and
the one v2 error was an **entity** confusion (a namesake), fixed with the
first-name guard.

## 6. What models are actually available (not assumed)

Probed against project `your-gcp-project`, region `us-central1`:

| Model id | Status |
|---|---|
| `gemini-3.8-flash`, `gemini-3-flash`, `gemini-3.0-flash`, `gemini-3-pro` | **404 — do not exist in this project/region** |
| `gemini-2.5-flash` | 200, works |
| `gemini-2.5-pro` | 200, works, requires thinking budget > 0 |
| `gemini-2.0-flash`, `gemini-2.5-flash-latest`, `gemini-1.5-*` | 404 |
| `gemini-embedding-001` | 200, 3072-d |
| `text-embedding-005` | 200, 768-d |
| `text-multilingual-embedding-002` | 200, 768-d |

There is no "Gemini 3.8 Flash" to switch to. Any plan that depends on that id
will fail at the first call.

## 7. Recommendation

**Use `gemini-2.5-flash` with few-shot prompting and the v2 evidence rules. Do
not switch to Pro, and do not build stance on embeddings.**

The pipeline, in order:

1. **Relevance, cheaply and conservatively.**
   - `absent` (candidate not in caption/on-screen/transcript) → `irrelevant`, no stance.
   - `listicle` (≥5 candidates in the text, or list markers) → `neutral`, no model call.
   - `namesake_risk` for the curated ambiguous surnames (Cazeneuve, Le Pen,
     Philippe, Bertrand, Mathieu, Lalanne, Ruffin, Markovic, Becht, Labib) when
     only the surname matched and the first name is absent → `unclear`, no stance.
2. **Stance, one batched call per video** (`gemini-2.5-flash`, temperature 0,
   `thinkingBudget: 0`) with six French exemplars covering: satirical jab →
   critical, campaign placard → favourable, news quote → neutral, list row →
   neutral, party attack → critical, generic rant → neutral.
3. **Evidence: verbatim, then fuzzy sentence match (≥0.7 token containment),
   else reject.** Store the mode (`exact` / `fuzzy` / `none`) and show it in the UI.
4. **Escalate to `gemini-2.5-pro` only** for pairs where two flash passes
   disagree, and only with a bounded per-run cap. It is not a default.
5. **Use embeddings for dedupe and triage, not labelling.** `gemini-embedding-001`
   (3072-d) to cluster the 14 exact-duplicate videos and near-reposts (sally /
   sallysurtiktok), and to order the LLM queue by novelty. Measured 36% precision
   means it must not write a label.

Expected effect, measured on the pieces: coverage 79.5% → 85.0% from evidence +
relevance with **zero model change and zero extra calls**; a further +20 points of
stance recall from few-shot, accepting ~1 false positive in 24.

### Cost at the current scale

| Step | Calls | Notes |
|---|---:|---|
| batched flash pass, 209 videos | 209 | cached in `.vertex-cache.json` |
| few-shot re-run (new prompt) | 209 | ~$0.15 at current flash pricing |
| embeddings for dedupe only | ~45 | anchors + one call per 5 videos |
| Pro adjudication (optional) | ≤20 | ~$0.10, only on disagreements |

## 8. What was changed in the repo

- `supabase/functions/_shared/stance-quality.ts` — relevance gate, namesake
  guard, fuzzy evidence matcher, few-shot exemplars.
- `supabase/functions/_shared/embeddings.ts` — Vertex embeddings, cosine, anchor
  scoring, duplicate fingerprints.
- `supabase/functions/_shared/vertex.ts` — batched classification now takes
  `fewShot`, a relevance hint and a thinking budget.
- `scripts/stance-ablation.ts` — the experiment above, reproducible.
- `scripts/stance-eval.ts` — v1 vs v2 rules over all 273 pairs + gold scoring.
- `data/analyses/runs/` — versioned outputs. The root `candidate-stance.json`
  was replaced once before run directories existed; v1 labels are reconstructed
  from the cache in `runs/v1-exact/` so the history is not lost.

## 9. Limits of this analysis

- The gold set is 24 videos; one item moves agreement by 4 points. Treat the
  recall/precision gap between flash and few-shot as directionally right, not
  final.
- My labels are one reader's judgement. A second annotator should settle
  borderline sarcasm before the demo claims an accuracy number.
- `neutral` and `unclear` are still adjacent. The UI should render them
  differently and never imply that "unclear" means the model failed.
- None of this fixes satire (Le Gorafi) or OCR that mangles a name
  into a different person. Both need entity resolution on the creator, not a
  better prompt.
