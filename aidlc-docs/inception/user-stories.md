# Inception — user stories

Personas: **Journalist** (newsroom, needs evidence), **Reader** (published story,
sees totals only), **Analyst** (checks the barometer over time).

## US1 — Story page: one fact, many verdicts
As a journalist I pick an anchor fact and see how creators interpreted it and
which candidate each reading targeted.
**Acceptance:** `story(factId)` returns statement, video/creator counts, stories
with leaning splits, aimedAt with candidate + leaning, and a timeline.
**Maps to:** R3, R4. Test: *story: a fact's stories and targets reconcile*.

## US2 — Events page: what changes after a big moment
As a journalist I open an event and compare coverage of each candidate in the 7
days before and after.
**Acceptance:** before/after counts, percentage change, leaning distribution
after; the event day is excluded; no baseline shows as null.
**Maps to:** R6. Test: *eventImpact: windows exclude the event day*.

## US3 — Facts page: one fact, different stories
As a reader I see the same fact and the different conclusions drawn from it,
with the candidate each conclusion targets.
**Acceptance:** stories ranked by volume; each story shows leaning bars; selecting
one surfaces its videos with verbatim quotes.
**Maps to:** R3, R4. Test: *story*.

## US4 — Video detail (newsroom)
As a journalist I open a video and check the verdict, the quote, where it was
found, and whether irony was detected.
**Acceptance:** verdict carries candidate, leaning, confidence, quote, source,
`verified`, `heldOut`; the video lists the fact it cites.
**Maps to:** R2. Test: *video detail*.

## US5 — Share card
As a journalist I export a single number pair and a split ("15 → 48, 60% critical").
**Acceptance:** `eventImpact` for one candidate returns both numbers and the split
that sums to `after`.
**Maps to:** R6. Test: *eventImpact*.

## US6 — Campaign structure
As an analyst I browse major issues → sub-issues → events to see where coverage
concentrates.
**Acceptance:** `issueGroups` returns nested groups with video counts; every event
placed once.
**Maps to:** R7. Test: *issueGroups*.
