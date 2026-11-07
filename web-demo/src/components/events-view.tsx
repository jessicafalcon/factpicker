"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { fmt, type Copy, type Locale } from "@/lib/i18n";
import type { Insight, Impact } from "@/lib/graphql";

const short = (iso: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso.slice(0, 10)}T00:00:00Z`),
  );

const chip = (title: string) => {
  const words = title.replace(/,.*$/, "").split(" ");
  const out: string[] = [];
  for (const word of words) {
    if (out.join(" ").length + word.length > 22) break;
    out.push(word);
  }
  return out.join(" ") + (out.join(" ") === words.join(" ") ? "" : "…");
};

const MULT = (value: number | null) => (value === null ? "—" : `${value}×`);

function Rise({ impact, copy, locale }: { impact: Impact | null; copy: Copy; locale: Locale }) {
  if (!impact) return null;
  const before = impact.favorableBeforePerDay ?? impact.criticalBeforePerDay;
  const after = impact.favorableAfterPerDay ?? impact.criticalAfterPerDay;
  return (
    <div className="rounded-[10px] border border-rule bg-paper-deep/40 p-4">
      <p className="font-sans text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-soft">
        {before === impact.favorableBeforePerDay ? copy.ev.biggestFav : copy.ev.biggestCrit}
      </p>
      <p className="mt-2 font-display text-[20px] leading-tight">{impact.candidate.name}</p>
      <p className="mt-1 font-serif text-[15px] text-ink">
        {fmt(copy.ev.perDay, { before: before.toFixed(1), after: after.toFixed(1) })}
      </p>
      <p className="mt-0.5 font-sans text-[11.5px] text-ink-soft">
        {before > 0 ? `${(after / before).toFixed(2)}×` : "—"}
      </p>
    </div>
  );
}

function Split({ row }: { row: Impact }) {
  const total = row.favorableAfter + row.criticalAfter + row.neutralAfter || 1;
  return (
    <span className="flex h-1.5 w-24 overflow-hidden rounded-full bg-paper-deep">
      <span className="bg-for/70" style={{ width: `${(row.favorableAfter / total) * 100}%` }} />
      <span className="bg-against/70" style={{ width: `${(row.criticalAfter / total) * 100}%` }} />
      <span className="bg-none/70" style={{ width: `${(row.neutralAfter / total) * 100}%` }} />
    </span>
  );
}

export function EventsView({ insights, copy, locale }: { insights: Insight[]; copy: Copy; locale: Locale }) {
  const [selected, setSelected] = useState(0);
  if (insights.length === 0) return null;
  const insight = insights[selected];

  return (
    <div className="mx-auto max-w-[1180px] px-6">
      <div className="mt-10 flex flex-wrap gap-2">
        {insights.map((item, index) => (
          <button
            key={item.event.id}
            type="button"
            onClick={() => setSelected(index)}
            aria-pressed={index === selected}
            className={cn(
              "rounded-full border px-4 py-2 font-sans text-[12.5px] transition",
              index === selected ? "border-ink bg-ink text-paper" : "border-rule text-ink hover:border-ink/40",
            )}
          >
            {short(item.event.commencement, locale)} · {chip(item.event.title)}
          </button>
        ))}
      </div>

      <div className="mt-8 border-t border-rule pt-6">
        <p className="font-sans text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-soft">
          {short(insight.event.commencement, locale)}
        </p>
        <h2 className="mt-1 max-w-[30ch] font-display text-[clamp(1.5rem,2.4vw,2rem)] leading-[1.15]">
          {insight.event.title}
        </h2>
        <p className="mt-2 font-serif text-[16px] text-ink-soft">
          {fmt(copy.ev.after, { n: insight.afterVideos, x: insight.multiplier ?? 0 })}
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Rise impact={insight.biggestFavorable} copy={copy} locale={locale} />
          <Rise impact={insight.biggestCritical} copy={copy} locale={locale} />
        </div>
        <p className="mt-3 font-serif text-[12.5px] text-ink-soft">{copy.ev.note}</p>

        <h3 className="mt-10 font-display text-[22px]">{copy.ev.table}</h3>
        <div className="mt-3 flex justify-between font-sans text-[10.5px] uppercase tracking-[0.1em] text-ink-soft">
          <span>{copy.ev.colBefore}</span>
          <span>{copy.ev.colAfter}</span>
        </div>
        <ul className="mt-2 divide-y divide-rule border-y border-rule">
          {insight.impacts.slice(0, 8).map((row) => (
            <li key={row.candidate.id} className="grid grid-cols-[1fr_auto] items-center gap-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="font-serif text-[15px]">{row.candidate.name}</span>
                <Split row={row} />
              </div>
              <span className="flex items-baseline gap-3 font-sans text-[12.5px] tabular-nums text-ink-soft">
                <span>{row.beforePerDay.toFixed(1)}</span>
                <span className="text-ink">→ {row.afterPerDay.toFixed(1)}</span>
                <span className="w-10 text-right text-ink">
                  {(() => {
                    const before = Number(row.beforePerDay.toFixed(1));
                    const after = Number(row.afterPerDay.toFixed(1));
                    return before > 0 ? `${(after / before).toFixed(1).replace(/\.0$/, "")}×` : "—";
                  })()}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <h3 className="mt-10 font-display text-[22px]">{copy.ev.topics}</h3>
        <ul className="mt-3 flex flex-wrap gap-2">
          {insight.facts.map((fact) => (
            <li key={fact.id} className="rounded-full border border-rule px-3 py-1.5 font-sans text-[12px]">
              {fact.label} <span className="text-ink-soft">· {fact.videos}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 font-serif text-[12.5px] text-ink-soft">{copy.ev.openFact}</p>

        <details className="mt-8 border-t border-rule pt-4">
          <summary className="cursor-pointer font-sans text-[12.5px] font-semibold">{copy.ev.how}</summary>
          <p className="mt-2 max-w-[70ch] font-serif text-[13.5px] leading-relaxed text-ink-soft">{copy.ev.howBody}</p>
        </details>
      </div>
    </div>
  );
}
