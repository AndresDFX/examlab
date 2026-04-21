/**
 * Forces the i18n language to the given course's configured language while
 * the hook is mounted, and restores the previous (user-preferred) language
 * when it unmounts.
 *
 * Used in student-facing routes that carry a courseId/examId — teachers and
 * admins keep their own UI language regardless of course.
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_LANGUAGE, type SupportedLanguage } from "@/i18n";

export function useCourseLanguage(courseLanguage: string | null | undefined) {
  const { i18n } = useTranslation();

  useEffect(() => {
    if (!courseLanguage) return;
    const lang: SupportedLanguage =
      courseLanguage === "en" || courseLanguage === "es" ? courseLanguage : DEFAULT_LANGUAGE;
    const prev = i18n.language;
    if (lang !== prev) void i18n.changeLanguage(lang);
    return () => {
      if (i18n.language !== prev) void i18n.changeLanguage(prev);
    };
  }, [courseLanguage, i18n]);
}
