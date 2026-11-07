"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, compactNumber, daysBetween, PLATFORM_LABEL } from "@/lib/utils";
import { anatomyTopic, factLabel, fmt, type Copy, type Locale } from "@/lib/i18n";
import type { AnatomyItem, AnatomyRole } from "@/lib/graphql";

const longDateFor = (iso: string | null, locale: Locale) =>
  iso
    ? new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(iso))
    : "";

const ROLES: AnatomyRole[] = ["OPENING", "FACT", "MEANING", "VERDICT"];
const ROTATE_MS = 9000;

function introFor(item: AnatomyItem, locale: Locale, copy: Copy): string {
  const posted = longDateFor(item.attribution.postedAt, locale);
  if (item.fact?.id === "protest_17_october_2026" && item.attribution.postedAt) {
    const days = daysBetween("2026-10-17", item.attribution.postedAt.slice(0, 10));
    if (days === 1) return copy.anatomy.introDayAfter;
    if (days > 1) return fmt(copy.anatomy.introThread, { n: days });
    return copy.anatomy.introRunup;
  }
  const phrase = item.fact ? anatomyTopic(item.fact.id, locale) : undefined;
  return phrase
    ? fmt(copy.anatomy.introAbout, { topic: phrase, date: posted })
    : fmt(copy.anatomy.introPosted, { date: posted });
}

export function AnatomyCard({ items, locale, copy }: { items: AnatomyItem[]; locale: Locale; copy: Copy }) {
  const initial = useMemo(() => {
    const complete = items.findIndex((item) => item.segments.length === 4);
    return complete >= 0 ? complete : 0;
  }, [items]);
  const [selected, setSelected] = useState(initial);
  const [auto, setAuto] = useState(true);
  const [held, setHeld] = useState(false);

  // Respect the visitor's motion preference: never auto-rotate for them.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setAuto(false);
  }, []);

  // Advance on a timer; hovering or focusing holds it. Including `selected`
  // restarts the interval, so a manual pick gets a full beat before moving on.
  useEffect(() => {
    if (!auto || held || items.length < 2) return;
    const timer = setInterval(() => setSelected((current) => (current + 1) % items.length), ROTATE_MS);
    return () => clearInterval(timer);
  }, [auto, held, selected, items.length]);

  if (items.length === 0) return null;
  const item = items[selected] ?? items[0];

  return (
    <section aria-labelledby="anatomy-heading" className="mx-auto max-w-[1180px] px-6">
      <h2
        id="anatomy-heading"
        className="max-w-[16ch] font-display text-[clamp(2rem,3.4vw,2.85rem)] leading-[1.1] tracking-[-0.02em]"
      >
        {copy.anatomy.title}
      </h2>
      <p className="mt-5 max-w-[54ch] font-serif text-[clamp(1.05rem,1.5vw,1.2rem)] leading-[1.6] text-ink">
        {fmt(copy.anatomy.intro, { line: introFor(item, locale, copy) })}
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-2" aria-label="Choose a sample video">
        {items.map((sample, index) => (
          <Button
            key={sample.videoId}
            type="button"
            variant={index === selected ? "default" : "outline"}
            size="sm"
            aria-pressed={index === selected}
            title={`${sample.fact ? factLabel({ id: sample.fact.id, category: sample.fact.statement }, locale) : copy.anatomy.title} · ${longDateFor(sample.attribution.postedAt, locale)}`}
            onClick={() => setSelected(index)}
          >
            @{sample.attribution.handle}
          </Button>
        ))}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto gap-1.5 text-ink-soft"
          aria-pressed={auto}
          onClick={() => setAuto((value) => !value)}
          title={auto ? copy.anatomy.pause : copy.anatomy.rotate}
        >
          {auto ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
          {auto ? copy.anatomy.pause : copy.anatomy.rotate}
        </Button>
      </div>

      <div
        className="mt-10 grid gap-10 md:grid-cols-[300px_minmax(0,1fr)] md:gap-12"
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocusCapture={() => setHeld(true)}
        onBlurCapture={() => setHeld(false)}
      >
        <VideoPreview key={item.videoId} item={item} copy={copy} />

        <div className="min-w-0">
          <div aria-live="polite" key={item.videoId} className="anatomy-swap">
            <blockquote className="font-serif text-[clamp(1.35rem,2.1vw,1.9rem)] leading-[1.52] tracking-[-0.005em]">
              <span aria-hidden="true">“</span>
              {item.segments.map((segment, index) => (
                <span key={segment.role} className={cn("anatomy-segment", segment.style.className)}>
                  {segment.text}
                  {segment.truncated ? "…" : ""}
                  {index < item.segments.length - 1 ? " " : ""}
                </span>
              ))}
              <span aria-hidden="true">”</span>
            </blockquote>

            <p className="sr-only">
              {fmt(copy.anatomy.srVerdict, {
                leaning: copy.leaning[(item.verdict?.leaning.toLowerCase() ?? "unclear") as keyof Copy["leaning"]],
                candidate: item.verdict?.candidate?.name ?? "—",
              })}
            </p>
          </div>

          <Legend item={item} copy={copy} />
        </div>
      </div>
    </section>
  );
}

/**
 * The tile shows the real thumbnail. Clicking loads the platform's own embed —
 * we never re-host or download the media, so playback stays inside TikTok's or
 * Instagram's player and their attribution rules.
 */
function VideoPreview({ item, copy }: { item: AnatomyItem; copy: Copy }) {
  const [playing, setPlaying] = useState(false);
  const a = item.attribution;
  const platformLabel = PLATFORM_LABEL[a.platform];

  if (playing && a.embedUrl) {
    return (
      <div className="relative aspect-[9/16] w-full max-w-[300px] overflow-hidden rounded-2xl bg-tile">
        <iframe
          src={a.embedUrl}
          title={`${a.handle} on ${platformLabel}`}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; encrypted-media; picture-in-picture; clipboard-write"
          allowFullScreen
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    );
  }

  return (
    <div className="w-full max-w-[300px]">
      <button
        type="button"
        onClick={() => (a.embedUrl ? setPlaying(true) : window.open(a.url, "_blank", "noopener"))}
        className="group relative block aspect-[4/5] w-full overflow-hidden rounded-2xl bg-tile sm:aspect-[9/15]"
        aria-label={a.embedUrl ? `Play ${a.handle}'s video` : `Open ${a.handle}'s post on ${platformLabel}`}
      >
        {a.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={a.thumbnailUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/30" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-14 items-center justify-center rounded-full border-2 border-paper/90 text-paper transition-transform duration-300 ease-out group-hover:scale-105">
            <Play aria-hidden className="size-6 translate-x-[1px]" fill="currentColor" strokeWidth={0} />
          </span>
        </span>
        <span className="pointer-events-none absolute inset-x-0 bottom-0 p-5">
          <span className="block font-sans text-[15px] font-medium text-paper">@{a.handle}</span>
          <span className="mt-0.5 block font-sans text-[13px] text-paper/75">
            {platformLabel} · {fmt(copy.anatomy.views, { n: compactNumber(a.views) })}
          </span>
        </span>
      </button>

      <a
        href={a.url}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1 font-sans text-[12.5px] text-ink-soft underline-offset-4 hover:text-ink hover:underline"
      >
        {fmt(copy.anatomy.openOn, { platform: platformLabel })}
        <ArrowUpRight aria-hidden className="size-3.5" />
      </a>
    </div>
  );
}

function Legend({ item, copy }: { item: AnatomyItem; copy: Copy }) {
  const entries = ROLES.filter((role) => role !== "OPENING")
    .map((role) => item.segments.find((segment) => segment.role === role))
    .filter(Boolean);

  return (
    <div className="mt-12 grid gap-8 sm:grid-cols-3 sm:gap-6" aria-label="How to read the three steps">
      {entries.map((segment) => (
        <div key={segment!.role}>
          <div className={cn("h-0", `legend-rule--${segment!.role.toLowerCase()}`)} />
          <p className="mt-3 font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-ink">
            {copy.anatomy.legend[segment!.role as keyof Copy["anatomy"]["legend"]].label}
          </p>
          <p className="mt-2 max-w-[34ch] font-serif text-[15px] leading-[1.5] text-ink-soft">
            {copy.anatomy.legend[segment!.role as keyof Copy["anatomy"]["legend"]].description}
          </p>
        </div>
      ))}
    </div>
  );
}
