import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { LOCALE_STORAGE_KEY, detectLocale, translate, type Locale } from "./i18n-dict";

export { LOCALES, DICTIONARIES, translate, detectLocale } from "./i18n-dict";
export type { Locale } from "./i18n-dict";

/**
 * Tiny i18n layer for the operator UI.
 *
 * The dictionary is keyed by the English sentence, so adding a string to a
 * component cannot silently produce an empty label: if a translation is
 * missing the English text is shown instead. Indonesian is the default when the
 * browser asks for it; the choice is remembered in localStorage.
 */

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (text: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }): ReactElement {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore storage failures; the choice still applies for this session.
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) => translate(locale, text, vars),
    [locale],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

export function LanguageSwitch(): ReactElement {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="language" title={t("Language")}>
      <span aria-hidden>{locale === "id" ? "🇮🇩" : "🇬🇧"}</span>
      <select
        value={locale}
        aria-label={t("Language")}
        onChange={(event) => setLocale(event.target.value === "id" ? "id" : "en")}
      >
        <option value="id">Indonesia</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
