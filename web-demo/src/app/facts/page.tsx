import { cookies } from "next/headers";
import { SiteHeader } from "@/components/site-header";
import { FactsView } from "@/components/facts-view";
import { copyFor, rangeLabel, type Locale } from "@/lib/i18n";
import { fetchFactsPage } from "@/lib/graphql";

export const instant = false;

export default async function FactsPage() {
  const store = await cookies();
  const locale: Locale = store.get("locale")?.value === "fr" ? "fr" : "en";
  const copy = copyFor(locale);
  const facts = await fetchFactsPage();
  const range = rangeLabel(locale);

  return (
    <>
      <SiteHeader locale={locale} copy={copy} />
      <main className="pb-24">
        <div className="mx-auto max-w-[1180px] px-6 pt-14 text-center">
          <p className="font-sans text-[11.5px] font-semibold uppercase tracking-[0.16em] text-ochre-ink">
            {range ? copy.fa.kicker.replace("{range}", range) : copy.fa.kicker.replace(" · {range}", "")}
          </p>
          <h1 className="mx-auto mt-4 max-w-[18ch] text-balance font-display text-[clamp(2.6rem,5.4vw,4.4rem)] leading-[1.02] tracking-[-0.02em]">
            {copy.fa.title}
          </h1>
          <p className="mx-auto mt-5 max-w-[60ch] font-serif text-[clamp(1.1rem,1.7vw,1.35rem)] leading-[1.55]">
            {copy.fa.intro}
          </p>
        </div>
        <FactsView facts={facts} copy={copy} locale={locale} />
      </main>
    </>
  );
}
