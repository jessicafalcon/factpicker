"use client";

import { Play } from "lucide-react";
import type { BehindItem } from "@/lib/graphql";
import { fmt, type Copy } from "@/lib/i18n";

// `css` paints the 3px rule (vivid); `text` is the darker variant that passes
// 4.5:1 at 12px on paper.
const VERDICT: Record<BehindItem["leaning"], { word: string; css: string; text: string }> = {
  FAVORABLE: { word: "Support", css: "var(--color-for)", text: "var(--color-for-ink)" },
  CRITICAL: { word: "Against", css: "var(--color-against)", text: "var(--color-ochre-ink)" },
  NEUTRAL: { word: "No side", css: "var(--color-none)", text: "var(--color-none-ink)" },
};

const compact = (value: number | null) => {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
};

export function VideosBehind({ items, copy }: { items: BehindItem[]; copy: Copy }) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="behind-heading" className="mx-auto max-w-[1180px] px-6">
      <h2
        id="behind-heading"
        className="max-w-[26ch] font-display text-[clamp(2rem,3.4vw,2.85rem)] leading-[1.1] tracking-[-0.02em]"
      >
        {copy.behind.title}
      </h2>
      <p className="mt-5 max-w-[62ch] font-serif text-[clamp(1.05rem,1.5vw,1.2rem)] leading-[1.6] text-ink">
        {copy.behind.intro}
      </p>

      <ul className="mt-10 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((item) => {
          const verdict = VERDICT[item.leaning];
          return (
            <li key={item.video.id} className="min-w-0">
              <a
                href={item.video.url}
                target="_blank"
                rel="noreferrer"
                className="group relative block aspect-[9/16] overflow-hidden rounded-[10px] bg-tile"
                style={{ boxShadow: `inset 0 -3px 0 0 ${verdict.css}` }}
                aria-label={`${item.candidate?.name ?? item.fact.category} — ${verdict.word} — @${item.video.creator.handle}, ${compact(item.video.views)} views`}
              >
                {item.video.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.video.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : null}
                <span className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/5 to-black/40" />
                <span className="absolute left-3 top-2.5 font-sans text-[11.5px] font-medium text-paper/90">
                  {fmt(copy.behind.views, { n: compact(item.video.views) })}
                </span>
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex size-10 items-center justify-center rounded-full border border-paper/85 text-paper transition-transform duration-200 group-hover:scale-105">
                    <Play className="ml-0.5 size-4" fill="currentColor" strokeWidth={0} />
                  </span>
                </span>
              </a>
              <p className="mt-2.5 truncate font-sans text-[12.5px] font-semibold text-ink">
                @{item.video.creator.handle}
              </p>
              <p className="mt-0.5 truncate font-sans text-[12px]" style={{ color: verdict.text }}>
                {item.candidate?.name ?? item.fact.category}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
