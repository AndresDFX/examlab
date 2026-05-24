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
      { label: "Código", path: "estudiante.codigo", kind: "scalar", hint: "Si está disponible" },
    ],
  },
  {
    label: "Curso",
    path: "curso",
    kind: "group",
    children: [
      { label: "Nombre", path: "curso.nombre", kind: "scalar" },
      { label: "Código", path: "curso.codigo", kind: "scalar" },
      { label: "Periodo", path: "periodo", kind: "scalar" },
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
    label: "Curso (solo scope='curso')",
    path: "estudiantes",
    kind: "group",
    hint: "Solo aparece en informes consolidados de curso",
    children: [
      {
        label: "Iterar estudiantes",
        path: "estudiantes",
        kind: "each",
        hint: "Dentro: {{nombre}}, {{email}}, {{nota_final}}, {{asistencia.porcentaje}}",
      },
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
