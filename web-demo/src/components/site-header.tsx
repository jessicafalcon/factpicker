import Link from "next/link";
import { LanguageSwitcher } from "@/components/language-switcher";
import type { Copy, Locale } from "@/lib/i18n";

export function SiteHeader({ locale, copy }: { locale: Locale; copy: Copy }) {
  const NAV = [{ label: copy.nav.story, href: "/", ready: true }];
  return (
    <header className="border-b border-rule/80">
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between gap-4 px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <BrandMark />
          <span className="font-sans text-[17px] font-semibold tracking-[-0.01em]">Factpicker</span>
        </Link>

        <div className="flex min-w-0 items-center gap-3">
        <nav aria-label="Sections" className="flex min-w-0 items-center gap-1">
          {NAV.map((item) =>
            item.ready ? (
              <Link
                key={item.label}
                href={item.href}
                aria-current="page"
                className="rounded-md bg-paper-deep px-3.5 py-1.5 font-sans text-[14px] font-medium text-ink"
              >
                {item.label}
              </Link>
            ) : (
              <span
                key={item.label}
                aria-disabled="true"
                title="Next build step — this page is not built yet"
                className="cursor-default rounded-md px-3.5 py-1.5 font-sans text-[14px] text-ink-soft/70"
              >
                {item.label}
              </span>
            ),
          )}
        </nav>
        <LanguageSwitcher locale={locale} />
        </div>
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <span aria-hidden className="flex items-end gap-[3px]">
      <span className="h-[9px] w-[4px] rounded-[1px] bg-ochre" />
      <span className="h-[15px] w-[4px] rounded-[1px] bg-ochre" />
      <span className="h-[12px] w-[4px] rounded-[1px] bg-ink" />
    </span>
  );
}
