/**
 * Motor Mustache-minimal para plantillas de informes.
 *
 * Sintaxis soportada:
 *   {{path.to.var}}     → interpolación con HTML-escape (default seguro)
 *   {{{path.to.var}}}   → interpolación SIN escape (escape hatch para HTML inline)
 *   {{#each items}}…{{/each}}   → iteración sobre array
 *   {{#if expr}}…{{/if}}        → render si expr es truthy
 *
 * Lookup de variables:
 *   - Dentro de `{{#each}}`, `{{nombre}}` referencia al elemento actual
 *     (no a una variable hermana del root). Soporta `{{@index}}` (0-based)
 *     y `{{@number}}` (1-based) para el índice de iteración.
 *   - `path.con.puntos` baja por el objeto activo.
 *   - Si no se encuentra, render vacío (no lanza, NO produce "undefined").
 *
 * No-soportado (a propósito, para no incentivar lógica en plantillas):
 *   - Helpers tipo Handlebars (`{{formatDate x}}`)
 *   - {{else}} blocks
 *   - Comparaciones (`{{#if a == b}}`)
 *   Si necesitas estas, calcula la variable en JS y pásala precomputada.
 *
 * Seguridad: las plantillas las edita Admin/Docente (gente con permisos),
 * pero los VALORES de las variables vienen de profiles/notas (potenciales
 * payloads XSS). Default = escapar. Solo `{{{...}}}` permite HTML crudo;
 * usar SOLO con datos que el desarrollador controla (no input de usuario).
 */

export type TemplateContext = Record<string, unknown>;

// ── Lexer ─────────────────────────────────────────────────────────────

type Token =
  | { kind: "text"; value: string }
  | { kind: "var"; path: string; raw: boolean }
  | { kind: "each_open"; path: string }
  | { kind: "if_open"; path: string }
  | { kind: "each_close" }
  | { kind: "if_close" };

const TAG_RE = /\{\{\{[\s\S]+?\}\}\}|\{\{[\s\S]+?\}\}/g;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src)) !== null) {
    if (m.index > last) {
      tokens.push({ kind: "text", value: src.slice(last, m.index) });
    }
    const tag = m[0];
    if (tag.startsWith("{{{")) {
      tokens.push({ kind: "var", path: tag.slice(3, -3).trim(), raw: true });
    } else {
      const inner = tag.slice(2, -2).trim();
      if (inner.startsWith("#each ")) {
        tokens.push({ kind: "each_open", path: inner.slice(6).trim() });
      } else if (inner.startsWith("#if ")) {
        tokens.push({ kind: "if_open", path: inner.slice(4).trim() });
      } else if (inner === "/each") {
        tokens.push({ kind: "each_close" });
      } else if (inner === "/if") {
        tokens.push({ kind: "if_close" });
      } else {
        tokens.push({ kind: "var", path: inner, raw: false });
      }
    }
    last = m.index + tag.length;
  }
  if (last < src.length) tokens.push({ kind: "text", value: src.slice(last) });
  return tokens;
}

// ── Parser → AST ──────────────────────────────────────────────────────

type Node =
  | { kind: "text"; value: string }
  | { kind: "var"; path: string; raw: boolean }
  | { kind: "each"; path: string; children: Node[] }
  | { kind: "if"; path: string; children: Node[] };

function parse(src: string): Node[] {
  const tokens = tokenize(src);
  let i = 0;

  function parseUntil(stop: Token["kind"] | null): Node[] {
    const out: Node[] = [];
    while (i < tokens.length) {
      const tok = tokens[i];
      if (stop && tok.kind === stop) {
        i++;
        return out;
      }
      if (tok.kind === "text") {
        out.push({ kind: "text", value: tok.value });
        i++;
      } else if (tok.kind === "var") {
        out.push({ kind: "var", path: tok.path, raw: tok.raw });
        i++;
      } else if (tok.kind === "each_open") {
        const path = tok.path;
        i++;
        const children = parseUntil("each_close");
        out.push({ kind: "each", path, children });
      } else if (tok.kind === "if_open") {
        const path = tok.path;
        i++;
        const children = parseUntil("if_close");
        out.push({ kind: "if", path, children });
      } else if (tok.kind === "each_close" || tok.kind === "if_close") {
        // Cerrar sin abrir → ignorar como literal "{{/x}}".
        // No deberíamos llegar acá con plantillas bien formadas.
        i++;
      }
    }
    if (stop !== null) {
      throw new Error(`Plantilla sin cerrar: falta {{/${stop === "each_close" ? "each" : "if"}}}`);
    }
    return out;
  }

  return parseUntil(null);
}

// ── Render ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Lookup de path en una pila de scopes (el último primero — el de
 * `{{#each}}` activo). Soporta `@index` y `@number` como sugar para
 * el índice del each. Devuelve `undefined` si no se encuentra.
 */
function lookup(stack: TemplateContext[], path: string): unknown {
  if (path === "." || path === "this") {
    // En {{#each}} sobre primitivos envolvemos el valor en `{ ".": value }`
    // para que {{.}} lo recupere. Si no existe esa key, devolvemos el
    // frame entero (caso de each sobre objetos donde {{.}} == el objeto).
    const top = stack[stack.length - 1];
    if (top && Object.prototype.hasOwnProperty.call(top, ".")) {
      return (top as Record<string, unknown>)["."];
    }
    return top;
  }
  if (path === "@index") return stack[stack.length - 1]?.["@index"];
  if (path === "@number") return stack[stack.length - 1]?.["@number"];

  const parts = path.split(".");
  // Probar desde el scope más anidado al root — comportamiento clásico
  // Mustache. Permite que dentro de {{#each estudiantes}} se pueda
  // referenciar {{curso.nombre}} (que viene del root).
  for (let s = stack.length - 1; s >= 0; s--) {
    let cur: unknown = stack[s];
    let ok = true;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object") {
        ok = false;
        break;
      }
      cur = (cur as Record<string, unknown>)[p];
      if (cur === undefined) {
        ok = false;
        break;
      }
    }
    if (ok && cur !== undefined) return cur;
  }
  return undefined;
}

function isTruthy(v: unknown): boolean {
  if (v == null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

function renderNodes(nodes: Node[], stack: TemplateContext[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") {
      out += n.value;
    } else if (n.kind === "var") {
      const v = lookup(stack, n.path);
      const s = stringify(v);
      out += n.raw ? s : escapeHtml(s);
    } else if (n.kind === "each") {
      const v = lookup(stack, n.path);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const item = v[i];
          const frame: TemplateContext =
            item != null && typeof item === "object" ? { ...(item as object) } : { ".": item };
          frame["@index"] = i;
          frame["@number"] = i + 1;
          stack.push(frame);
          out += renderNodes(n.children, stack);
          stack.pop();
        }
      }
    } else if (n.kind === "if") {
      const v = lookup(stack, n.path);
      if (isTruthy(v)) out += renderNodes(n.children, stack);
    }
  }
  return out;
}

/**
 * Renderiza una plantilla. Devuelve un string. Lanza solo si la
 * plantilla tiene bloques mal cerrados — todo lo demás (variables
 * faltantes, paths que no resuelven, arrays con tipos raros) se
 * tolera silenciosamente para que un docente con typo no rompa el
 * preview entero.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  const ast = parse(template);
  return renderNodes(ast, [ctx]);
}

/**
 * Catálogo de variables disponibles — para el editor de plantillas.
 * El sidebar derecho lo usa para pintar el árbol clickable.
 *
 * `kind`:
 *   - 'scalar': click inserta `{{path}}`
 *   - 'each': click inserta `{{#each path}}…{{/each}}` (snippet)
 *   - 'group': solo nodo de carpeta (no inserta nada)
 */
export interface VariableNode {
  label: string;
  path: string;
  kind: "scalar" | "each" | "group";
  hint?: string;
  children?: VariableNode[];
}

export const REPORT_VARIABLE_CATALOG: VariableNode[] = [
  {
    label: "Estudiante",
    path: "estudiante",
    kind: "group",
    children: [
      { label: "Nombre", path: "estudiante.nombre", kind: "scalar" },
      { label: "Correo", path: "estudiante.email", kind: "scalar" },
      { label: "Código estudiantil", path: "estudiante.codigo", kind: "scalar", hint: "Matrícula institucional" },
      { label: "Documento de identidad", path: "estudiante.documento", kind: "scalar" },
      { label: "Cohorte", path: "estudiante.cohorte", kind: "scalar", hint: "Periodo de ingreso" },
      { label: "Estado", path: "estudiante.estado", kind: "scalar", hint: "activo / retirado / graduado / aplazado" },
      { label: "Programa", path: "estudiante.programa", kind: "scalar" },
    ],
  },
  {
    label: "Curso",
    path: "curso",
    kind: "group",
    children: [
      { label: "Nombre", path: "curso.nombre", kind: "scalar" },
      { label: "Código", path: "curso.codigo", kind: "scalar" },
      { label: "Semestre", path: "curso.semestre", kind: "scalar", hint: "Si el curso lo tiene definido" },
      { label: "Grupo", path: "curso.grupo", kind: "scalar", hint: "Si el curso lo tiene definido" },
      { label: "Programa académico", path: "curso.programa", kind: "scalar", hint: "Si el curso está asociado a un programa" },
      { label: "Código del programa", path: "curso.programa_codigo", kind: "scalar" },
      { label: "Facultad", path: "curso.facultad", kind: "scalar" },
      { label: "Asignatura del plan", path: "curso.asignatura", kind: "scalar", hint: "Si el curso está asociado a una asignatura del plan" },
      { label: "Código de la asignatura", path: "curso.asignatura_codigo", kind: "scalar" },
      { label: "Créditos", path: "curso.creditos", kind: "scalar" },
      { label: "Horario", path: "curso.horario", kind: "scalar", hint: "Bloques semanales formateados: 'Lun 10:00–12:00 · Jue 14:00–16:00'" },
      { label: "Periodo", path: "periodo", kind: "scalar" },
      { label: "Periodo · Inicio", path: "periodo_obj.start_date", kind: "scalar" },
      { label: "Periodo · Fin", path: "periodo_obj.end_date", kind: "scalar" },
      { label: "Periodo · Estado", path: "periodo_obj.status", kind: "scalar" },
      { label: "Fecha de emisión", path: "fecha_emision", kind: "scalar" },
    ],
  },
  {
    label: "Docente",
    path: "docente",
    kind: "group",
    children: [
      { label: "Nombre", path: "docente.nombre", kind: "scalar" },
      { label: "Correo", path: "docente.email", kind: "scalar" },
    ],
  },
  {
    label: "Institución",
    path: "institucion",
    kind: "group",
    children: [
      { label: "Nombre", path: "institucion.nombre", kind: "scalar" },
      { label: "Logo (URL)", path: "institucion.logo", kind: "scalar" },
    ],
  },
  {
    label: "Notas",
    path: "notas",
    kind: "group",
    children: [
      { label: "Nota final", path: "nota_final", kind: "scalar" },
      { label: "Aprobado (true/false)", path: "aprobado", kind: "scalar", hint: "Para usar con {{#if aprobado}}" },
      { label: "Estado de aprobación", path: "estado_aprobacion", kind: "scalar", hint: "'Aprobado', 'Reprobado' o 'Sin nota'" },
      { label: "Escala máxima", path: "escala_max", kind: "scalar" },
      {
        label: "Iterar cortes",
        path: "cortes",
        kind: "each",
        hint: "{{nombre}}, {{nota}}, {{peso}}",
      },
      {
        label: "Iterar exámenes",
        path: "examenes",
        kind: "each",
        hint: "{{titulo}}, {{nota}}, {{peso}}",
      },
      {
        label: "Iterar talleres",
        path: "talleres",
        kind: "each",
        hint: "{{titulo}}, {{nota}}, {{peso}}",
      },
      {
        label: "Iterar proyectos",
        path: "proyectos",
        kind: "each",
        hint: "{{titulo}}, {{nota}}, {{peso}}",
      },
    ],
  },
  {
    label: "Asistencia",
    path: "asistencia",
    kind: "group",
    children: [
      { label: "Presentes", path: "asistencia.presentes", kind: "scalar" },
      { label: "Ausentes", path: "asistencia.ausentes", kind: "scalar" },
      { label: "Total sesiones", path: "asistencia.total", kind: "scalar" },
      { label: "Porcentaje", path: "asistencia.porcentaje", kind: "scalar" },
    ],
  },
  {
    label: "Curso (solo informes consolidados)",
    path: "estudiantes",
    kind: "group",
    hint: "Solo aparece en informes consolidados de curso",
    children: [
      {
        label: "Iterar estudiantes",
        path: "estudiantes",
        kind: "each",
        hint: "Dentro: {{nombre}}, {{email}}, {{codigo}}, {{documento}}, {{nota_final}}, {{estado_aprobacion}}, {{asistencia.porcentaje}}",
      },
      { label: "Total estudiantes", path: "total_estudiantes", kind: "scalar" },
      { label: "Total aprobados", path: "total_aprobados", kind: "scalar" },
      { label: "Total reprobados", path: "total_reprobados", kind: "scalar" },
      { label: "Total sin nota", path: "total_sin_nota", kind: "scalar" },
    ],
  },
];

/**
 * Snippet que se inserta al click en un nodo del catálogo.
 */
export function variableSnippet(node: VariableNode): string {
  if (node.kind === "each") {
    return `{{#each ${node.path}}}\n  \n{{/each}}`;
  }
  if (node.kind === "group") return "";
  return `{{${node.path}}}`;
}

// ── Generación de informes con IA ─────────────────────────────────────

/**
 * Lista plana de los paths de variable disponibles (recorre el catálogo).
 * Útil para inyectar en el prompt de IA "estas son las variables que
 * puedes usar" y para validaciones. Incluye scalars y eaches.
 */
export function flattenCatalogPaths(
  catalog: VariableNode[] = REPORT_VARIABLE_CATALOG,
): string[] {
  const out: string[] = [];
  const walk = (nodes: VariableNode[]) => {
    for (const n of nodes) {
      if (n.kind !== "group") out.push(n.path);
      if (n.children) walk(n.children);
    }
  };
  walk(catalog);
  return out;
}

/**
 * Resume un TemplateContext a un bloque de texto compacto y legible que
 * se puede inyectar en el `user` message de la IA como "datos del curso".
 * Aplana objetos anidados a `clave: valor` (un nivel) y trunca arrays
 * largos para no inflar el prompt — la IA necesita el shape de los datos,
 * no las 90 filas completas.
 *
 * PURA: no toca DB ni red. El caller pasa el ctx ya construido por
 * `buildReportContext`. Testeada en docx-import.test.ts.
 */
export function summarizeContextForAi(ctx: TemplateContext, maxArrayItems = 5): string {
  const lines: string[] = [];

  const fmtPrimitive = (v: unknown): string => {
    if (v == null) return "—";
    if (typeof v === "string") return v || "—";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v instanceof Date) return v.toISOString();
    return JSON.stringify(v);
  };

  const isPrimitive = (v: unknown): boolean =>
    v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

  for (const [key, value] of Object.entries(ctx)) {
    if (isPrimitive(value)) {
      lines.push(`${key}: ${fmtPrimitive(value)}`);
    } else if (Array.isArray(value)) {
      lines.push(`${key} (${value.length} elementos):`);
      for (const item of value.slice(0, maxArrayItems)) {
        if (isPrimitive(item)) {
          lines.push(`  - ${fmtPrimitive(item)}`);
        } else if (item && typeof item === "object") {
          const pairs = Object.entries(item as Record<string, unknown>)
            .filter(([, v]) => isPrimitive(v))
            .map(([k, v]) => `${k}=${fmtPrimitive(v)}`)
            .join(", ");
          lines.push(`  - ${pairs}`);
        }
      }
      if (value.length > maxArrayItems) {
        lines.push(`  … y ${value.length - maxArrayItems} más`);
      }
    } else if (value && typeof value === "object") {
      const pairs = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => isPrimitive(v))
        .map(([k, v]) => `  ${k}: ${fmtPrimitive(v)}`)
        .join("\n");
      lines.push(`${key}:`);
      if (pairs) lines.push(pairs);
    }
  }
  return lines.join("\n");
}

export interface AiReportPromptArgs {
  /** Texto del informe que el docente está editando (con o sin {{vars}}). */
  draftText: string;
  /** Instrucción libre del docente: qué quiere que la IA genere/rellene. */
  instruction: string;
  /** Contexto del curso ya construido (buildReportContext). */
  ctx: TemplateContext;
  /** Variables disponibles para que la IA inserte placeholders. */
  catalog?: VariableNode[];
}

/**
 * Compone el prompt de IA para generar/rellenar una sección del informe.
 * Devuelve `{ system, user }` listos para el formato chat-completions
 * (mismo contrato que usan los edges IA del repo).
 *
 * Decisión: el prompt instruye a la IA a DEVOLVER el texto del informe
 * usando los placeholders `{{var}}` cuando un dato venga del catálogo (en
 * vez de incrustar el valor concreto), para que el resultado siga siendo
 * una PLANTILLA reutilizable que el template-engine resuelve por
 * estudiante/curso. Los valores concretos van solo como referencia.
 *
 * PURA: no invoca la IA — solo arma los mensajes. El wiring del edge
 * queda en el caller (app.teacher.reports.tsx).
 */
/** Logo de muestra (SVG inline) para el preview cuando no hay logo real. */
export const SAMPLE_LOGO_DATA_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="56">' +
      '<rect width="140" height="56" rx="6" fill="#e5e7eb"/>' +
      '<text x="70" y="34" font-family="sans-serif" font-size="15" fill="#6b7280" text-anchor="middle">LOGO</text></svg>',
  );

/**
 * Contexto de MUESTRA para la vista previa del editor. Rellena cada variable
 * del catálogo con un valor de ejemplo, para que el preview se vea RENDERIZADO
 * (datos reales de ejemplo) en lugar de mostrar los `{{placeholders}}` crudos.
 * El caller (la ruta) puede sobreescribir `institucion` con la marca real del
 * tenant (nombre + logo) para que el logo institucional se vea de verdad.
 *
 * PURA: sin DB ni red. Testeada.
 */
export function buildSampleReportContext(overrides?: Partial<TemplateContext>): TemplateContext {
  const base: TemplateContext = {
    estudiante: {
      nombre: "Juan Pérez Gómez",
      email: "juan.perez@correo.edu.co",
      codigo: "20211020",
      documento: "1.234.567.890",
      cohorte: "2024-1",
      estado: "activo",
      programa: "Ingeniería de Sistemas",
    },
    curso: {
      nombre: "Programación II",
      codigo: "IS-202",
      semestre: "2",
      grupo: "341C",
      programa: "Ingeniería de Sistemas",
      programa_codigo: "IS",
      facultad: "Facultad de Ingeniería",
      asignatura: "Programación Orientada a Objetos",
      asignatura_codigo: "POO-202",
      creditos: 3,
      horario: "Lun 10:00–12:00 · Jue 14:00–16:00",
    },
    periodo: "2026-1",
    periodo_obj: { start_date: "2026-01-20", end_date: "2026-05-30", status: "en curso" },
    fecha_emision: "15 de junio de 2026",
    docente: { nombre: "María Rodríguez", email: "maria.rodriguez@correo.edu.co" },
    institucion: { nombre: "Institución Universitaria", logo: SAMPLE_LOGO_DATA_URI },
    nota_final: "4,3",
    aprobado: true,
    estado_aprobacion: "Aprobado",
    escala_max: 5,
    cortes: [
      { nombre: "Corte 1", nota: "4,0", peso: "30%" },
      { nombre: "Corte 2", nota: "4,2", peso: "30%" },
      { nombre: "Corte 3", nota: "4,6", peso: "40%" },
    ],
    examenes: [
      { titulo: "Parcial 1", nota: "4,0", peso: "15%" },
      { titulo: "Parcial 2", nota: "4,5", peso: "15%" },
    ],
    talleres: [{ titulo: "Taller 1", nota: "4,8", peso: "10%" }],
    proyectos: [{ titulo: "Proyecto final", nota: "4,5", peso: "20%" }],
    asistencia: { presentes: 18, ausentes: 2, total: 20, porcentaje: "90%" },
    estudiantes: [
      { nombre: "Juan Pérez", email: "juan@correo.edu.co", codigo: "20211020", documento: "1.234.567.890", nota_final: "4,3", estado_aprobacion: "Aprobado", asistencia: { porcentaje: "90%" } },
      { nombre: "Ana Gómez", email: "ana@correo.edu.co", codigo: "20211021", documento: "1.234.567.891", nota_final: "3,1", estado_aprobacion: "Aprobado", asistencia: { porcentaje: "85%" } },
      { nombre: "Luis Torres", email: "luis@correo.edu.co", codigo: "20211022", documento: "1.234.567.892", nota_final: "2,4", estado_aprobacion: "Reprobado", asistencia: { porcentaje: "70%" } },
    ],
    total_estudiantes: 25,
    total_aprobados: 20,
    total_reprobados: 4,
    total_sin_nota: 1,
  };
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    // `institucion` se mezcla a nivel de campo para conservar el logo de
    // muestra si el override sólo trae el nombre (o viceversa).
    institucion: {
      ...(base.institucion as Record<string, unknown>),
      ...((overrides.institucion as Record<string, unknown>) ?? {}),
    },
  };
}

export function buildAiReportPrompt(args: AiReportPromptArgs): { system: string; user: string } {
  const { draftText, instruction, ctx, catalog } = args;
  const paths = flattenCatalogPaths(catalog);
  const ctxSummary = summarizeContextForAi(ctx);

  const system = [
    "Eres un asistente que redacta secciones de informes académicos para un docente.",
    "Escribe en español (es-CO), tono formal e institucional, claro y conciso.",
    "El texto que produces es una PLANTILLA: cuando un dato provenga de las variables",
    "disponibles, inserta el placeholder con doble llave (por ejemplo {{estudiante.nombre}})",
    "EN LUGAR del valor concreto, para que el sistema lo reemplace luego por cada",
    "estudiante o curso. Usa los valores concretos solo como referencia de contexto.",
    "Devuelve únicamente el texto/HTML de la sección, sin explicaciones ni comentarios,",
    "sin envolver en bloques de código.",
  ].join("\n");

  const user = [
    `INSTRUCCIÓN DEL DOCENTE:\n${instruction.trim() || "Genera el contenido del informe."}`,
    "",
    `VARIABLES DISPONIBLES (usa estos placeholders {{...}} cuando apliquen):\n${paths.join(", ")}`,
    "",
    `DATOS DEL CURSO (referencia de contexto, no los incrustes literalmente si hay una variable):\n${ctxSummary}`,
    "",
    draftText.trim()
      ? `TEXTO ACTUAL DEL INFORME (mejóralo / complétalo según la instrucción):\n${draftText.trim()}`
      : "El informe está vacío: genera el contenido desde cero según la instrucción.",
  ].join("\n");

  return { system, user };
}
