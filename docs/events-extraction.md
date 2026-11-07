# Election events in the Oriane snapshot

Generated **2026-11-07** from `data/oriane` only — **no API calls, no model
calls**. Reproduce with `npm run events`; artifacts are
`data/analyses/events.json` and `data/analyses/events.csv`.

- Window: **2026-08-08 → 2026-11-02**
- Corpus: **209 French videos**
- Output: **20 events** (6 scandals), **17 issue topics**, **7 major-issue
  groups**, and a **candidate × topic matrix**
- **123 of 209 videos** fall inside at least one event

## 1. How the data is grouped

Three levels, all in `events.json` under `issue_groups`:

```
major issue  →  sub-issue  →  { topics (long-run issue coverage), events (dated incidents) }
```

| Major issue | Videos | Sub-issues |
|---|---:|---|
| Society & rights | 103 | Education (47) · Security (42) · Ecology and climate (26) · Racism and antisemitism (24) · Health (21) · Immigration (12) |
| Campaign | 94 | Declarations and meetings (85) · Primaries and nominations (18) · Protests (8) · Debates (6) |
| State & institutions | 70 | Government (60) · Institutions (23) |
| Economy & work | 62 | Cost of living (34) · Labour and strikes (26) · Pensions (17) · Budget and debt (12) · Housing (7) |
| Media & democracy | 58 | Media and censorship (58) |
| Rule of law & scandals | 34 | Justice and convictions (27) · Police and custody (11) |
| World | 27 | International (23) · Ukraine and defence (16) · Middle East (11) |

Group totals overlap: one video can discuss education **and** the budget, so the
column is a union of video ids per group, not a partition of the corpus.

An **event** is a dated incident. A **topic** is sustained coverage of an issue
with no single incident attached (e.g. `security`, 42 videos, no event).

## 2. Events, grouped

### Society & rights

| Event | Start | End | Videos | Peak | Conf. |
|---|---|---|---:|---|---|
| Hospital, doctors and access to care | 2026-08-23 | 2026-10-23 | 21 | 08-23 (2) | high |
| Heatwaves, fires and the firefighter protest | 2026-08-26 | 2026-10-20 | 17 | 10-20 (3) | high |
| Immigration, OQTF and regularisation | 2026-08-31 | 2026-10-22 | 12 | 09-08 (3) | high |
| RN antisemitism accusations (Alain Soral reference) | 2026-09-05 | 2026-10-23 | 11 | 10-09 (2) | high |
| Lycée blockades and the UNI / Louise Montangon row | 2026-10-07 | 2026-10-16 | 4 | 10-16 (2) | medium |

### Campaign

| Event | Start | End | Videos | Peak | Conf. |
|---|---|---|---:|---|---|
| Candidate declarations, meetings and polls | 2026-08-23 | 2026-10-26 | 39 | 10-12 (6) | high |
| Socialist primary and Glucksmann's nomination | 2026-08-26 | 2026-10-29 | 18 | 09-18 (4) | high |
| MEDEF summer school debate (REF) | 2026-08-28 | 2026-09-26 | 6 | 08-31 (3) | medium |
| **17 October national mobilisation** | **2026-10-10** | **2026-10-28** | **8** | 10-17 | high |

### Economy & work

| Event | Start | End | Videos | Peak | Conf. |
|---|---|---|---:|---|---|
| Purchasing power, the SMIC and prices | 2026-08-26 | 2026-10-29 | 34 | 09-08 (3) | high |
| Pensions and the reform at 64 | 2026-08-27 | 2026-10-23 | 17 | 09-07 (2) | high |
| Budget, deficit and article 49.3 | 2026-08-28 | 2026-10-26 | 12 | 08-31 (2) | high |
| Housing, rents and social housing | 2026-08-28 | 2026-10-14 | 7 | 08-28 (1) | medium |
| Strikes, unions and demonstrations | 2026-09-01 | 2026-10-29 | 26 | 10-16 (3) | high |

### Media & democracy

| Event | Start | End | Videos | Peak | Conf. |
|---|---|---|---:|---|---|
| Adèle Haenel, France 5 and the cancelled Grande Librairie | 2026-09-11 | single day | 2 | 09-11 | low |

### Rule of law & scandals

| Event | Start | End | Videos | Peak | Conf. |
|---|---|---|---:|---|---|
| Marine Le Pen's conviction and the electronic bracelet | 2026-08-19 | 2026-10-25 | 11 | 10-16 (2) | high |
| Police custody, IGPN and police violence | 2026-09-06 | 2026-10-25 | 9 | 09-06 (2) | high |
| **17 October 1961 memory thread** | **2026-10-20** | 2026-10-21 | 2 | — | low |

### World

| Event | Start | End | Videos | Peak | Conf. |
|---|---|---|---:|---|---|
| Ukraine, Russia and defence | 2026-09-01 | 2026-10-26 | 16 | 09-23 (3) | high |
| Palestine, Gaza and the French left | 2026-09-03 | 2026-10-11 | 11 | 09-06 (2) | high |

## 3. The 17 October thread — and why it needed disambiguation

"17 octobre" means two different things in this corpus:

| Reading | Videos | Anchors | Kept separate by |
|---|---:|---|---|
| 2026 national mobilisation | 8 | `17 octobre` + a mobilisation term (rue, manif, pillages, grève) | `exclude: ["1961"]` |
| 1961 Paris massacre | 2 | `17 octobre 1961`, `1961` | explicit year |

Both were nearly merged by a naive anchor. The 2026 event runs
**2026-10-10 → 10-28** with six active days; previews ("17 octobre dans la
rue", 10-10) precede the day itself, and the aftermath runs to 10-28
(Le Monde/Mediapart coverage of the "alertes de violences du 17 octobre",
LFI's response, and the Amiens police-van controversy on 10-20).

Its **sub-issue breakdown** (`topic_breakdown` in the JSON) inside the same
Campaign group: ecology 4, government 3, security 3, labour 3 —
i.e. the protest is discussed through security and labour, not through
education, in this sample. That is the "side impact on other specific topics"
you asked about; it is computed per event, not asserted.

## 4. Coverage gap: the RN congress in Orléans

**Not in this dataset.** Verified three ways:

| Probe | Hits |
|---|---:|
| `orléans` / `orleans` | **0** |
| `congrès` / `congres` | **1** — a Horizons merchandise page ("Congrès Marseille"), not the RN |
| `rassemblement national` | 16 (but none mentions a congress or Orléans) |

I did not add an event for it. If the index is extended, the anchors that would
catch it are `orléans`, `congrès du rn`, `congrès de rentrée`, `congrès
d'investiture` — `scripts/extract-events.ts` accepts them as a two-line
addition. Same situation for the televised debate: the corpus has 24 `débat`
videos but no `débat télévisé`, so there is no dated debate event.

## 5. Scandals (6)

| Scandal | Commencement | Span | Videos | Active days |
|---|---|---|---:|---:|
| Marine Le Pen conviction / electronic bracelet | 2026-08-19 | → 10-25 | 11 | 10 |
| RN antisemitism accusations | 2026-09-05 | → 10-23 | 11 | 8 |
| Police custody / IGPN | 2026-09-06 | → 10-25 | 9 | 7 |
| Adèle Haenel / France 5 | 2026-09-11 | single day | 2 | 1 |
| Lycée blockades + UNI / Montangon | 2026-10-07 | → 10-16 | 4 | 3 |
| 17 October 1961 memory | 2026-10-20 | 2 days | 2 | 2 |

## 6. Candidate × topic matrix

`candidate_topic_matrix` answers "what is each candidate talked about, and with
what leaning" — the raw material for the Facts page. `index` is
`(favourable − critical) / videos` for that candidate on that topic, using the
v2 stance labels. Examples:

| Candidate | Videos | Strongest topics (videos, index) |
|---|---:|---|
| Mélenchon | 142 | campaign (25, +0.04), government (14, +0.07), purchasing power (14, 0) |
| Le Pen | 135 | campaign (22, −0.05), government (17, −0.12), racism (9, −0.44) |
| Philippe | 108 | campaign (21, −0.19), government (13, −0.23) |
| Bardella | 102 | campaign (11, 0), scandals (9, −0.33) |
| Glucksmann | 92 | campaign (20, −0.15), security (7, −0.29) |
| Attal | 86 | campaign (19, −0.05), purchasing power (9, −0.22) |

## 7. Method and limits

1. Text = caption + on-screen text + transcript, accent-folded.
2. Anchors match on word boundaries; `groups` add AND-of-OR logic; `exclude`
   removes a disambiguating sense (1961).
3. An event needs **≥2 videos**. Catch-alls (government, institutions) are
   topics only.
4. Mentioned dates require an explicit year and are restricted to 2026.
5. Every event carries `video_ids`, `evidence` (up to 4 quotes), a per-day
   `timeline`, and a `topic_breakdown`.

Known weaknesses: OCR can put a name into a video that does not discuss that
person; anchors are curated, so an event nobody defined is missed (the Orléans
congress above is the live example); two-video events are real but thin and are
marked `low`.
