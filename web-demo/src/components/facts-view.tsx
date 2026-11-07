"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { fmt, factLabel, type Copy, type Locale } from "@/lib/i18n";
import type { FactPage } from "@/lib/graphql";

const LEANING = {
  FAVORABLE: "for",
  CRITICAL: "against",
  NEUTRAL: "none",
} as const;

export function FactsView({ facts, copy, locale }: { facts: FactPage[]; copy: Copy; locale: Locale }) {
  const ordered = [...facts].sort((a, b) => b.videos - a.videos);
  const [factId, setFactId] = useState(ordered[0]?.id ?? "");
  const [story, setStory] = useState(0);
  const fact = ordered.find((item) => item.id === factId) ?? ordered[0];
  if (!fact) return null;
  const reading = fact.readings[Math.min(story, fact.readings.length - 1)];
  const total = reading ? reading.favorable + reading.critical + reading.neutral || 1 : 1;
  const dominantWord = copy.leaning[(reading?.dominant.toLowerCase() ?? "neutral") as keyof Copy["leaning"]];

  return (
    <div className="mx-auto max-w-[1180px] px-6">
      <div className="mt-10 flex flex-wrap gap-2">
        {ordered.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => { setFactId(item.id); setStory(0); }}
            aria-pressed={item.id === fact.id}
            className={cn(
              "rounded-full border px-4 py-2 font-sans text-[12.5px] transition",
              item.id === fact.id ? "border-ink bg-ink text-paper" : "border-rule text-ink hover:border-ink/40",
            )}
          >
            {factLabel(item, locale)} <span className={item.id === fact.id ? "text-paper/60" : "text-ink-soft"}>· {item.videos}</span>
          </button>
        ))}
      </div>

      <div className="mt-8 border-t border-rule pt-6">
        <p className="font-sans text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-soft">{copy.fa.fact}</p>
        <h2 className="mt-1 max-w-[34ch] font-display text-[clamp(1.4rem,2.2vw,1.9rem)] leading-[1.2]">
          {fact.statement}
        </h2>
        <p className="mt-2 font-serif text-[13px] text-ink-soft">
          {fmt(fact.sourceName ? copy.fa.checked : copy.fa.unverified, { source: fact.sourceName ?? "—", n: fact.videos })}
        </p>

        <h3 className="mt-9 font-display text-[22px]">{copy.fa.stories}</h3>
        <ul className="mt-3 divide-y divide-rule border-y border-rule">
          {(fact.readings ?? []).map((item, index) => {
            const sum = item.favorable + item.critical + item.neutral || 1;
            return (
              <li key={item.label}>
                <button
                  type="button"
                  onClick={() => setStory(index)}
                  aria-pressed={index === (reading ? fact.readings.indexOf(reading) : 0)}
                  className={cn("flex w-full items-center justify-between gap-4 py-3 text-left", index === story && "bg-paper-deep/40")}
                >
                  <span className="font-serif text-[15px]">{item.label}</span>
                  <span className="flex items-center gap-3">
                    <span className="flex h-1.5 w-28 overflow-hidden rounded-full bg-paper-deep">
                      <span className="bg-for/70" style={{ width: `${(item.favorable / sum) * 100}%` }} />
                      <span className="bg-against/70" style={{ width: `${(item.critical / sum) * 100}%` }} />
                      <span className="bg-none/70" style={{ width: `${(item.neutral / sum) * 100}%` }} />
                    </span>
                    <span className="font-sans text-[11.5px] text-ink-soft">
                      {item.videos} · {fmt(copy.fa.mostly, { x: copy.leaning[item.dominant.toLowerCase() as keyof Copy["leaning"]] })}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {reading ? (
          <section className="mt-10">
            <h3 className="font-display text-[22px]">{copy.fa.inWords}</h3>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {reading.representatives.map((item) => (
                <article key={item.attribution.url} className="rounded-[10px] border border-rule p-5">
                  <p className="font-serif text-[16px] leading-[1.55]">
                    <span aria-hidden>“</span>
                    {item.segments.map((segment, index) => (
                      <span key={`${segment.role}-${index}`} className={segment.style.className}>
                        {segment.text}
                        {segment.truncated ? "…" : ""}
                        {index < item.segments.length - 1 ? " " : ""}
                      </span>
                    ))}
                    <span aria-hidden>”</span>
                  </p>
                  <p className="mt-3 font-sans text-[12px]">
                    <a href={item.attribution.url} target="_blank" rel="noreferrer" className="font-semibold underline decoration-rule underline-offset-2">
                      @{item.attribution.handle}
                    </a>
                    <span className="text-ink-soft">
                      {" · "}{item.attribution.platform.toLowerCase()}
                      {item.attribution.views ? ` · ${item.attribution.views.toLocaleString(locale === "fr" ? "fr-FR" : "en-GB")} views` : ""}
                    </span>
                  </p>
                  {item.verdict?.candidate ? (
                    <p className="mt-1 font-sans text-[11.5px] text-ink-soft">
                      {dominantWord} · {item.verdict.candidate.name}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
            <p className="mt-3 font-serif text-[12.5px] text-ink-soft">
              {copy.fa.verbatim} · {reading.videos} {reading.videos === 1 ? "video" : "videos"}
            </p>
          </section>
        ) : null}

        <details className="mt-10 border-t border-rule pt-4">
          <summary className="cursor-pointer font-sans text-[12.5px] font-semibold">{copy.fa.read}</summary>
          <p className="mt-2 max-w-[70ch] font-serif text-[13.5px] leading-relaxed text-ink-soft">{copy.fa.readBody}</p>
        </details>
      </div>
    </div>
  );
}
