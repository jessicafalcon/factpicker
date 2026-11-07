"use client";

import { useRouter } from "next/navigation";
import { LOCALES, LOCALE_COOKIE, type Locale } from "@/lib/i18n";

export function LanguageSwitcher({ locale }: { locale: Locale }) {
  const router = useRouter();

  const choose = (next: Locale) => {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`;
    router.refresh();
  };

  return (
    <div
      role="group"
      aria-label="Language / Langue"
      className="flex items-center rounded-full border border-rule p-0.5"
    >
      {LOCALES.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => choose(item)}
          aria-pressed={item === locale}
          className={
            item === locale
              ? "rounded-full bg-ink px-2 py-0.5 font-sans text-[11.5px] font-semibold text-paper"
              : "rounded-full px-2 py-0.5 font-sans text-[11.5px] font-medium text-ink-soft transition-colors hover:text-ink"
          }
        >
          {item.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
