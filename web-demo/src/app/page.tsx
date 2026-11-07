import { Suspense } from "react";
import { cookies } from "next/headers";
import { SiteHeader } from "@/components/site-header";
import { connection } from "next/server";
import { AnatomyCard } from "@/components/anatomy-card";
import { StorySections } from "@/components/story-sections";
import { VideosBehind } from "@/components/videos-behind";
import { fetchEntryPage } from "@/lib/graphql";
import { longDate } from "@/lib/utils";
import { copyFor, DEFAULT_LOCALE, fmt, LOCALE_COOKIE, type Locale } from "@/lib/i18n";

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });

function rangeLabel(window: { first: string; last: string } | undefined, locale: Locale): string {
  if (!window) return "PRÉSIDENTIELLE 2027";
  const fmt = new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    month: "long",
    timeZone: "UTC",
  });
  const firstDate = new Date(`${window.first}T00:00:00Z`);
  const lastDate = new Date(`${window.last}T00:00:00Z`);
  const firstMonth = fmt.format(firstDate).toUpperCase();
  const lastMonth = fmt.format(lastDate).toUpperCase();
  const firstYear = firstDate.getUTCFullYear();
  const lastYear = lastDate.getUTCFullYear();
  const joiner = locale === "fr" ? " – " : " TO ";
  const range =
    firstYear === lastYear
      ? `${firstMonth}${joiner}${lastMonth} ${lastYear}`
      : `${firstMonth} ${firstYear}${joiner}${lastMonth} ${lastYear}`;
  return `${locale === "fr" ? "PRÉSIDENTIELLE 2027" : "PRÉSIDENTIELLE 2027"} · ${range}`;
}

export const instant = false;
export const preferredRegion = "fra1";

async function StoryContent() {
  // Read the live dataset on every request instead of caching the build.
  await connection();
  const store = await cookies();
  const locale: Locale = store.get(LOCALE_COOKIE)?.value === "fr" ? "fr" : DEFAULT_LOCALE;
  const copy = copyFor(locale);
  const { items, facts, timelines, behind, dataset, error, endpoint } = await fetchEntryPage(6);

  return (
    <>
      <SiteHeader locale={locale} copy={copy} />
    <main className="w-full min-w-0 flex-1 pb-28">
      <section className="mx-auto max-w-[1180px] px-6 pt-14 text-center md:pt-20">
        <p className="font-sans text-[11.5px] font-semibold uppercase tracking-[0.16em] text-ochre-ink">
          {rangeLabel(dataset?.window, locale)}
        </p>

        <h1 className="mx-auto mt-6 max-w-[16ch] font-display text-[clamp(2.75rem,6.4vw,5.25rem)] leading-[0.98] tracking-[-0.025em] text-balance">
          {copy.hero.titleLead} <span className="md:block">{copy.hero.titleTail}</span>
        </h1>

        <p className="mx-auto mt-8 max-w-[46ch] font-serif text-[clamp(1.15rem,2vw,1.5rem)] leading-[1.55] text-pretty">
          {dataset
            ? fmt(copy.hero.intro, {
                n: dataset.videos,
                first: longDate(dataset.window.first, locale),
                last: longDate(dataset.window.last, locale),
              })
            : copy.hero.intro.split(".")[0] + "."}
        </p>

      </section>

      <div className="mt-20 md:mt-28">
        {error ? (
          <ApiUnavailable endpoint={endpoint} message={error} copy={copy} />
        ) : (
          <AnatomyCard items={items} locale={locale} copy={copy} />
        )}
      </div>

      {!error && facts.length > 0 ? (
        <div className="mt-24 md:mt-32">
          <StorySections facts={facts} timelines={timelines} locale={locale} copy={copy} />
        </div>
      ) : null}

      {!error && behind.length > 0 ? (
        <div className="mt-24 md:mt-32">
          <VideosBehind items={behind} copy={copy} />
        </div>
      ) : null}

      <section className="mx-auto mt-20 max-w-[1180px] px-6">
        <hr className="border-rule" />
        <h2 className="mt-6 font-sans text-[15px] font-semibold text-ink">{copy.how.title}</h2>
        <ul className="mt-4 max-w-[82ch] list-disc space-y-3 pl-5 font-serif text-[14.5px] leading-[1.65] text-ink-soft">
          {copy.how.bullets.map((bullet, index) => (
            <li key={index}>{index === 0 ? fmt(bullet, { n: dataset?.videos ?? 0 }) : bullet}</li>
          ))}
        </ul>
      </section>
    </main>
    </>
  );
}

function ApiUnavailable({ endpoint, message, copy }: { endpoint: string; message: string; copy: ReturnType<typeof copyFor> }) {
  return (
    <section className="mx-auto max-w-[1180px] px-6">
      <div className="rounded-2xl border border-rule bg-paper-deep/60 p-8">
        <h2 className="font-display text-2xl tracking-[-0.01em]">{copy.errors.title}</h2>
        <p className="mt-3 max-w-[60ch] font-serif text-[16px] leading-[1.6] text-ink-soft">
          {copy.errors.body.split("{endpoint}")[0]}
          <code className="rounded bg-paper px-1.5 py-0.5 text-[13px]">{endpoint}</code>
          {copy.errors.body.split("{endpoint}")[1]}
        </p>
        <pre className="mt-5 overflow-x-auto rounded-xl bg-ink px-4 py-3 font-mono text-[13px] text-paper">
          {copy.errors.hint}
        </pre>
        <p className="mt-4 font-mono text-[12px] text-ink-soft/80">{message}</p>
      </div>
    </section>
  );
}

/**
 * The shell is static; everything that reads the API or the locale cookie
 * streams per request. Without this boundary the whole page is prerendered at
 * build time, so one slow cold start at build would be baked in for every visit.
 */
export default function StoryPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen w-full items-center justify-center bg-paper">
          <span className="font-sans text-[13px] tracking-[0.02em] text-ink-soft/70">Factpicker</span>
        </div>
      }
    >
      <StoryContent />
    </Suspense>
  );
}
