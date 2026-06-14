import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll } from "vitest";
// Inicializa i18n en el entorno de test. Sin esto, los componentes que usan
// `t()` (DataPagination, HelpHint, …) devuelven la CLAVE cruda
// (`hc_componentsUiDataPagination.goToPage`) en vez del texto, y los tests que
// asertan el texto traducido fallan. Forzamos español — es el default de la
// app y el idioma que asertan los tests; además, el LanguageDetector podría
// elegir "en" desde el `navigator.language` de jsdom.
import i18n from "@/i18n";

beforeAll(async () => {
  await i18n.changeLanguage("es");
});

afterEach(() => {
  cleanup();
});
