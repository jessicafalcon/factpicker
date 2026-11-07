"use client";

import { cn } from "@/lib/utils";
import { eventLabel, eventTitle, factLabel, fmt, type Copy, type Locale } from "@/lib/i18n";
import type { FactTimeline, TimelineMoment } from "@/lib/graphql";

const shortDate = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

const monthName = (date: string, locale: Locale) => {
  const value = new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
  return value.charAt(0).toUpperCase() + value.slice(1);
};

function MomentRow({
  moment,
  windowDays,
  locale,
  copy,
}: {
  moment: TimelineMoment;
  windowDays: number;
  locale: Locale;
  copy: Copy;
}) {
  const major = moment.videos >= 8;
  const split = moment.verdicts;
  const total = split.forCandidate + split.againstCandidate + split.noSide;
  const share = (value: number) => `${total ? (value / total) * 100 : 0}%`;

  return (
    <li className="grid grid-cols-[32px_1fr] items-start py-4 sm:grid-cols-[160px_48px_1fr]">
      <div className="hidden pr-4 text-right sm:block">
        <p className="text-[12px] font-semibold leading-tight text-ink">{shortDate(moment.date, locale)}</p>
        <p className="mt-0.5 text-[11px] leading-tight text-ink-soft">{eventLabel(moment.label, locale)}</p>
      </div>

      <div className="relative flex justify-center pt-1">
        <span
          aria-hidden
          className={cn(
            "relative z-10 block rounded-full ring-4 ring-paper",
            major ? "size-[26px] bg-ink" : "size-[18px] border-2 border-ink bg-paper",
          )}
        />
      </div>

      <div className="min-w-0 pl-3 sm:pl-4">
        <p className="text-[11.5px] text-ink-soft sm:hidden">
          {shortDate(moment.date, locale)} · {eventLabel(moment.label, locale)}
        </p>
        <h3 className="text-[15px] font-semibold leading-snug text-ink">
          {eventTitle(moment.id, moment.title, locale)}
        </h3>
        <p className="mt-0.5 text-[12.5px] text-ink-soft">
          <span className="font-medium text-ink">
            {fmt(moment.videos === 1 ? copy.timeline.citingOne : copy.timeline.citingMany, { n: moment.videos })}
          </span>
          <span className="text-ink-soft">
            {" · "}
            {fmt(copy.timeline.posted, { n: moment.totalVideos, days: windowDays })}
          </span>
        </p>

        {moment.hasSelectedFact && total > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="flex h-1.5 w-20 overflow-hidden rounded-full bg-paper-deep" aria-hidden>
              <span className="h-full bg-for/70" style={{ width: share(split.forCandidate) }} />
              <span className="h-full bg-against/70" style={{ width: share(split.againstCandidate) }} />
              <span className="h-full bg-none/70" style={{ width: share(split.noSide) }} />
            </span>
            <span className="font-sans text-[11px] tabular-nums text-ink-soft">
              {fmt(copy.timeline.for, { n: split.forCandidate })} ·{" "}
              {fmt(copy.timeline.against, { n: split.againstCandidate })} ·{" "}
              {fmt(copy.timeline.none, { n: split.noSide })}
            </span>
          </div>
        ) : null}

        {moment.facts.some((chip) => !chip.highlighted) ? (
        <ul className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <li className="font-sans text-[11px] uppercase tracking-[0.1em] text-ink-soft">{copy.timeline.alsoCited}</li>
          {moment.facts.filter((chip) => !chip.highlighted).map((chip) => (
            <li
              key={chip.id}
              className={cn(
                "rounded-full border px-2.5 py-1 font-sans text-[11.5px] leading-none",
                chip.highlighted ? "border-ink bg-ink text-paper" : "border-rule text-ink",
              )}
            >
              {factLabel({ id: chip.id, category: chip.label }, locale)}{" "}
              <span className="text-ink-soft">· {chip.videos}</span>
            </li>
          ))}
        </ul>
        ) : null}
      </div>
    </li>
  );
}

export function FactTimeline({
  timeline,
  locale,
  copy,
}: {
  timeline: FactTimeline;
  locale: Locale;
  copy: Copy;
}) {
  const groups: Array<{ month: string; moments: TimelineMoment[] }> = [];
  for (const moment of timeline.moments) {
    const group = groups.find((item) => item.month === moment.month);
    if (group) group.moments.push(moment);
    else groups.push({ month: moment.month, moments: [moment] });
  }

  return (
    <section aria-labelledby="timeline-heading" className="mx-auto max-w-[1180px] px-6">
      <h2
        id="timeline-heading"
        className="max-w-[18ch] font-display text-[clamp(2rem,3.4vw,2.85rem)] leading-[1.1] tracking-[-0.02em]"
      >
        {copy.timeline.title}
      </h2>
      <p className="mt-5 max-w-[62ch] font-serif text-[clamp(1.05rem,1.5vw,1.2rem)] leading-[1.6] text-ink">
        {copy.timeline.intro}
      </p>

      {timeline.moments.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 font-sans text-[12.5px] text-ink-soft">
          <span className="font-medium text-ink">{fmt(copy.timeline.moments, { n: timeline.moments.length })}</span>
          <span>{fmt(copy.timeline.citingIt, { n: timeline.videosInBursts })}</span>
          <span>
            {shortDate(timeline.moments[0].date, locale)} –{" "}
            {shortDate(timeline.moments[timeline.moments.length - 1].date, locale)}
          </span>
        </div>
      ) : null}

      <div className="relative mt-10">
        <span aria-hidden className="absolute bottom-6 left-[15px] top-2 w-px bg-rule sm:left-[183px]" />

        {groups.map((group) => (
          <div key={group.month}>
            <div className="grid grid-cols-[32px_1fr] items-center pt-8 first:pt-0 sm:grid-cols-[160px_48px_1fr]">
              <p className="hidden pr-4 text-right font-display text-[22px] leading-none text-ink sm:block">
                {monthName(group.moments[0].date, locale)}
              </p>
              <span aria-hidden className="relative z-10 mx-auto block size-1.5 rounded-full bg-ink" />
              <p className="pl-3 font-display text-[20px] leading-none text-ink sm:hidden">
                {monthName(group.moments[0].date, locale)}
              </p>
            </div>
            <ol>
              {group.moments.map((moment) => (
                <MomentRow
                  key={moment.id}
                  moment={moment}
                  windowDays={timeline.windowDays}
                  locale={locale}
                  copy={copy}
                />
              ))}
            </ol>
          </div>
        ))}
      </div>

      <p className="mt-10 max-w-[62ch] font-serif text-[13.5px] leading-[1.6] text-ink-soft">
        {fmt(copy.timeline.footer, { days: timeline.windowDays })}
      </p>
    </section>
  );
}
