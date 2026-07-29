/**
 * MAPEO OFICIAL lenguaje × compilador.
 *
 * Fuente única de verdad de "qué lenguaje puede ejecutar cada proveedor y con
 * qué identificador". Antes esto vivía disperso en tablas separadas dentro del
 * edge (`ONLINECOMPILER_MAP`, `JDOODLE_MAP`, `AWS_LAMBDA_LANGUAGES`) y en listas
 * de `<SelectItem>` hardcodeadas en 6 pantallas, sin que ninguna derivara de la
 * otra. El resultado era que la UI ofrecía lenguajes que el runner no soportaba
 * (y al revés), y agregar un lenguaje implicaba tocar 8 lugares sin que nada
 * avisara si te olvidabas de uno.
 *
 * ⚠️ INVARIANTE CROSS-FILE: este archivo está REPLICADO en
 * `supabase/functions/execute-code/language-support.ts` porque Deno no puede
 * importar de `src/`. Si cambiás el mapeo, cambiá LOS DOS. El test
 * `language-support.test.ts` compara ambas copias y falla si divergen.
 */

/** Lenguajes que el sistema sabe EJECUTAR (no incluye los de solo-entrega). */
export type CodeLanguage =
  | "java"
  | "kotlin"
  | "python"
  | "javascript"
  | "typescript"
  | "c"
  | "cpp"
  | "csharp"
  | "fsharp"
  | "go"
  | "rust"
  | "php"
  | "ruby"
  | "haskell";

/**
 * Compiladores. `aws_lambda` es el runner PROPIO (la VM de Judge0): un solo
 * slot, no dos. Judge0 es la implementación que corre detrás de ese proveedor,
 * así que no aparece como opción aparte en la UI ni en la DB — si apareciera,
 * el admin tendría que elegir entre "el Lambda" y "Judge0" siendo lo mismo.
 */
export type CodeProvider = "onlinecompiler" | "jdoodle" | "aws_lambda" | "cheerp";

/**
 * Subconjunto que la UI ofrece hoy en los selectores de código EJECUTABLE.
 *
 * Deliberadamente más chico que `CodeLanguage`: el mapeo documenta todo lo que
 * el motor puede correr, pero exponer 14 lenguajes en el editor del alumno es
 * una decisión de producto aparte. Para habilitar uno, agregalo acá — el resto
 * de la app lo toma solo.
 */
export const UI_EXECUTABLE_LANGUAGES: readonly CodeLanguage[] = [
  "java",
  "kotlin",
  "python",
  "javascript",
] as const;

/** Etiquetas visibles. Nombres propios: NO se traducen. */
export const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  java: "Java",
  kotlin: "Kotlin",
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  fsharp: "F#",
  go: "Go",
  rust: "Rust",
  php: "PHP",
  ruby: "Ruby",
  haskell: "Haskell",
};

/** Identificador del lenguaje en Monaco (resaltado de sintaxis). */
export const MONACO_LANGUAGE: Record<CodeLanguage, string> = {
  java: "java",
  kotlin: "kotlin",
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  c: "c",
  cpp: "cpp",
  csharp: "csharp",
  fsharp: "fsharp",
  go: "go",
  rust: "rust",
  php: "php",
  ruby: "ruby",
  haskell: "plaintext", // Monaco no trae gramática de Haskell.
};

/**
 * Judge0 — `language_id` de cada lenguaje. Judge0 es lo que corre en la VM
 * propia, detrás del proveedor `aws_lambda`.
 *
 * ⚠️ Los ids NO son universales: dependen de la VERSIÓN de Judge0 instalada en
 * la VM. Los de acá son los de Judge0 CE 1.13.x. Verificalos contra tu
 * instancia con `GET {JUDGE0_URL}/languages` y corregí si difieren — un id
 * equivocado no falla al arrancar, ejecuta OTRO lenguaje (p. ej. mandar Kotlin
 * al compilador de Java), que es un fallo mudo y caro de diagnosticar.
 * `scripts/judge0-verify-languages.mjs` hace esa comparación automáticamente.
 */
export const JUDGE0_LANGUAGE_ID: Partial<Record<CodeLanguage, number>> = {
  java: 62, // Java (OpenJDK 13.0.1)
  kotlin: 78, // Kotlin (1.3.70)
  python: 71, // Python (3.8.1)
  javascript: 63, // JavaScript (Node.js 12.14.0)
  typescript: 74, // TypeScript (3.7.4)
  c: 50, // C (GCC 9.2.0)
  cpp: 54, // C++ (GCC 9.2.0)
  csharp: 51, // C# (Mono 6.6.0.161)
  fsharp: 87, // F# (.NET Core SDK 3.1.202)
  go: 60, // Go (1.13.5)
  rust: 73, // Rust (1.40.0)
  php: 68, // PHP (7.4.1)
  ruby: 72, // Ruby (2.7.0)
  haskell: 61, // Haskell (GHC 8.8.1)
};

/** OnlineCompiler.io — id del compilador. */
export const ONLINECOMPILER_ID: Partial<Record<CodeLanguage, string>> = {
  // openjdk-21 devuelve HTTP 400 en su API; solo aceptan openjdk-25.
  java: "openjdk-25",
  python: "python-3.14",
  javascript: "typescript-deno",
  typescript: "typescript-deno",
  c: "gcc-15",
  cpp: "g++-15",
  csharp: "dotnet-csharp-9",
  fsharp: "dotnet-fsharp-9",
  go: "go-1.26",
  rust: "rust-1.93",
  php: "php-8.5",
  ruby: "ruby-4.0",
  haskell: "haskell-9.12",
  // kotlin: SIN SOPORTE CONFIRMADO. No inventar un id: si no está acá, el
  // ruteo manda el lenguaje a otro proveedor que sí lo soporte.
};

/** JDoodle — `language` + `versionIndex`. */
export const JDOODLE_ID: Partial<Record<CodeLanguage, { language: string; versionIndex: string }>> =
  {
    java: { language: "java", versionIndex: "4" },
    kotlin: { language: "kotlin", versionIndex: "3" },
    python: { language: "python3", versionIndex: "4" },
    javascript: { language: "nodejs", versionIndex: "4" },
    typescript: { language: "typescript", versionIndex: "1" },
    c: { language: "c", versionIndex: "5" },
    cpp: { language: "cpp17", versionIndex: "1" },
    csharp: { language: "csharp", versionIndex: "4" },
    fsharp: { language: "fsharp", versionIndex: "1" },
    go: { language: "go", versionIndex: "4" },
    rust: { language: "rust", versionIndex: "4" },
    php: { language: "php", versionIndex: "4" },
    ruby: { language: "ruby", versionIndex: "4" },
    haskell: { language: "haskell", versionIndex: "3" },
  };

/**
 * Runner PROPIO (`aws_lambda`) — la VM de Judge0.
 *
 * Se declara EXPLÍCITO y no derivado de `JUDGE0_LANGUAGE_ID` a propósito: Judge0
 * conoce los 14, pero lo que la VM tenga realmente instalado y habilitado es una
 * cuestión de despliegue. Declarar los 14 acá haría que el ruteo mandara, por
 * ejemplo, Haskell a la VM y fallara ahí en vez de irse a un proveedor que sí lo
 * corre. Se amplía a medida que se confirma cada lenguaje en la VM.
 *
 * Kotlin ESTÁ incluido porque es el objetivo de esta integración; requiere que
 * el lenguaje esté habilitado en la VM (`GET /languages` debe listar Kotlin).
 * Si no lo está, el ruteo lo manda a JDoodle, que también lo soporta.
 */
export const AWS_LAMBDA_LANGUAGES: readonly CodeLanguage[] = [
  "java",
  "python",
  "kotlin",
] as const;

/** CheerpJ corre bytecode JVM en el navegador. No existe `kotlinc` en el
 *  navegador, así que Kotlin NO entra — solo Java. */
export const CHEERP_LANGUAGES: readonly CodeLanguage[] = ["java"] as const;

/** ¿Este proveedor puede ejecutar este lenguaje? */
export function providerSupports(provider: CodeProvider, language: CodeLanguage): boolean {
  switch (provider) {
    case "onlinecompiler":
      return ONLINECOMPILER_ID[language] !== undefined;
    case "jdoodle":
      return JDOODLE_ID[language] !== undefined;
    case "aws_lambda":
      return AWS_LAMBDA_LANGUAGES.includes(language);
    case "cheerp":
      return CHEERP_LANGUAGES.includes(language);
  }
}

/**
 * Orden de preferencia para ELEGIR un proveedor cuando el configurado no
 * soporta el lenguaje pedido. Judge0 primero por ser infraestructura propia
 * (sin cuota de terceros ni costo por corrida).
 */
const FALLBACK_ORDER: readonly CodeProvider[] = [
  "aws_lambda", // VM propia (Judge0): sin cuota de terceros ni costo por corrida
  "jdoodle",
  "onlinecompiler",
] as const;

/**
 * Resuelve QUÉ proveedor va a ejecutar realmente.
 *
 * WHY existe: antes el fallback era `onlinecompiler` hardcodeado en 3 lugares
 * del edge. Con Kotlin eso se rompe, porque OnlineCompiler.io no lo soporta:
 * un tenant con ese default mandaría Kotlin a un proveedor que no lo conoce.
 * Ahora el fallback se decide por el MAPEO, no por una constante.
 *
 * Devuelve `null` cuando NINGÚN proveedor soporta el lenguaje — el caller debe
 * mostrar un error explícito, nunca intentar a ciegas.
 */
export function resolveProviderFor(
  language: CodeLanguage,
  preferred: CodeProvider,
): CodeProvider | null {
  // `cheerp` es client-side: del lado server siempre se resuelve a otro.
  if (preferred !== "cheerp" && providerSupports(preferred, language)) return preferred;
  for (const p of FALLBACK_ORDER) {
    if (providerSupports(p, language)) return p;
  }
  return null;
}

/** Proveedores válidos para un lenguaje, en orden de preferencia. Incluye
 *  `cheerp` solo para Java (es la única opción client-side). */
export function providersForLanguage(language: CodeLanguage): CodeProvider[] {
  const out: CodeProvider[] = [];
  for (const p of ["aws_lambda", "onlinecompiler", "cheerp", "jdoodle"] as CodeProvider[]) {
    if (providerSupports(p, language)) out.push(p);
  }
  return out;
}

/** Chequeo de exhaustividad: si agregás un lenguaje al union y te olvidás de
 *  una tabla obligatoria, esto rompe el build (no espera al runtime). */
const _exhaustiveLabels: Record<CodeLanguage, string> = LANGUAGE_LABEL;
const _exhaustiveMonaco: Record<CodeLanguage, string> = MONACO_LANGUAGE;
void _exhaustiveLabels;
void _exhaustiveMonaco;
