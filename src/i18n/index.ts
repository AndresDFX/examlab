/**
 * i18n setup for ExamLab.
 *
 * - Default + initial language: Spanish (`es`).
 * - Falls back to `es` for any unknown key or locale.
 * - Language is stored in `localStorage` via the detector so user preference
 *   survives reloads.
 * - When the student navigates into a course-scoped route, a higher layer
 *   (`useCourseLanguage`) temporarily forces the course's configured language
 *   and restores the user preference on exit.
 */
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import es from "./locales/es.json";

export const SUPPORTED_LANGUAGES = ["es", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = "es";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      es: { translation: es },
      en: { translation: en },
    },
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "examlab:lang",
    },
    returnNull: false,
  });

export default i18n;
