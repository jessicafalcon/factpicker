"use client";

import { useMemo, useState } from "react";
import { ReadingsSankey } from "@/components/readings-sankey";
import { FactTimeline } from "@/components/fact-timeline";
import type { FactItem, FactTimeline as Timeline } from "@/lib/graphql";
import type { Copy, Locale } from "@/lib/i18n";

/**
 * Owns the fact selection so the timeline can follow the Sankey without a
 * second round trip: every fact's timeline is already in the page payload.
 */
export function StorySections({
  facts,
  timelines,
  locale,
  copy,
}: {
  facts: FactItem[];
  timelines: Timeline[];
  locale: Locale;
  copy: Copy;
}) {
  const ordered = useMemo(() => [...facts].sort((a, b) => b.videos - a.videos), [facts]);
  const [factId, setFactId] = useState(ordered[0]?.id ?? "");
  const timeline = timelines.find((item) => item.factId === factId) ?? timelines[0] ?? null;

  return (
    <>
      <ReadingsSankey facts={facts} selectedId={factId} onSelect={setFactId} locale={locale} copy={copy} />
      {timeline ? (
        <div className="mt-24 md:mt-32">
          <FactTimeline timeline={timeline} locale={locale} copy={copy} />
        </div>
      ) : null}
    </>
  );
}
