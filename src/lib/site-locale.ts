export type SiteLocale = "es-419";

export const DEFAULT_SITE_LOCALE: SiteLocale = "es-419";

export function resolveBrowserLocale(): SiteLocale {
  return DEFAULT_SITE_LOCALE;
}
