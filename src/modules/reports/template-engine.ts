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

import { ranuraHtml } from "./signature-slots";

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
  /** Traducción EN del label (paridad es↔en). TemplateEditor usa este cuando
   *  el idioma activo es inglés; si falta, cae a `label`. Co-locado (no i18n
   *  keys) porque los labels/paths se repiten y una key estable sería ambigua. */
  labelEn?: string;
  path: string;
  kind: "scalar" | "each" | "group";
  /**
   * Inserta `{{{path}}}` (triple llave, SIN escapar) en vez de `{{path}}`.
   *
   * Existe para UN caso: variables cuyo valor es marcado que este código produce
   * —hoy solo la ranura de firma de `signature-slots.ts`—. NO se usa para valores
   * que vengan de la base (nombres, notas, retroalimentación): esos son input de
   * usuario y sin escapar son un XSS en el documento.
   */
  raw?: boolean;
  hint?: string;
  hintEn?: string;
  children?: VariableNode[];
}

export const REPORT_VARIABLE_CATALOG: VariableNode[] = [
  {
    label: "Estudiante",
    labelEn: "Student",
    path: "estudiante",
    kind: "group",
    children: [
      { label: "Nombre", labelEn: "Name", path: "estudiante.nombre", kind: "scalar" },
      { label: "Correo", labelEn: "Email", path: "estudiante.email", kind: "scalar" },
      { label: "Código estudiantil", labelEn: "Student ID", path: "estudiante.codigo", kind: "scalar", hint: "Matrícula institucional", hintEn: "Institutional enrollment ID" },
      { label: "Documento de identidad", labelEn: "ID document", path: "estudiante.documento", kind: "scalar" },
      { label: "Cohorte", labelEn: "Cohort", path: "estudiante.cohorte", kind: "scalar", hint: "Periodo de ingreso", hintEn: "Entry term" },
      { label: "Estado", labelEn: "Status", path: "estudiante.estado", kind: "scalar", hint: "activo / retirado / graduado / aplazado", hintEn: "active / withdrawn / graduated / deferred" },
      { label: "Programa", labelEn: "Program", path: "estudiante.programa", kind: "scalar" },
    ],
  },
  {
    label: "Curso",
    labelEn: "Course",
    path: "curso",
    kind: "group",
    children: [
      { label: "Nombre", labelEn: "Name", path: "curso.nombre", kind: "scalar" },
      { label: "Código", labelEn: "Code", path: "curso.codigo", kind: "scalar" },
      { label: "Semestre", labelEn: "Semester", path: "curso.semestre", kind: "scalar", hint: "Si el curso lo tiene definido", hintEn: "If the course has it defined" },
      { label: "Grupo", labelEn: "Group", path: "curso.grupo", kind: "scalar", hint: "Si el curso lo tiene definido", hintEn: "If the course has it defined" },
      { label: "Programa académico", labelEn: "Academic program", path: "curso.programa", kind: "scalar", hint: "Si el curso está asociado a un programa", hintEn: "If the course is linked to a program" },
      { label: "Código del programa", labelEn: "Program code", path: "curso.programa_codigo", kind: "scalar" },
      { label: "Facultad", labelEn: "Faculty", path: "curso.facultad", kind: "scalar" },
      { label: "Asignatura del plan", labelEn: "Curriculum subject", path: "curso.asignatura", kind: "scalar", hint: "Si el curso está asociado a una asignatura del plan", hintEn: "If the course is linked to a curriculum subject" },
      { label: "Código de la asignatura", labelEn: "Subject code", path: "curso.asignatura_codigo", kind: "scalar" },
      { label: "Créditos", labelEn: "Credits", path: "curso.creditos", kind: "scalar" },
      { label: "Objetivos de la asignatura", labelEn: "Subject objectives", path: "curso.objetivos", kind: "scalar", hint: "Se editan en Académico → Asignaturas; cambian en un solo lugar para todos los documentos", hintEn: "Edited in Academic → Subjects; change in one place for every document" },
      { label: "Contenidos de la asignatura", labelEn: "Subject contents", path: "curso.contenidos", kind: "scalar" },
      { label: "Bibliografía", labelEn: "Bibliography", path: "curso.bibliografia", kind: "scalar" },
      { label: "Intensidad horaria", labelEn: "Weekly hours", path: "curso.intensidad_horaria", kind: "scalar" },
      { label: "Sistema de evaluación", labelEn: "Assessment system", path: "curso.sistema_evaluacion", kind: "scalar" },
      { label: "Horario", labelEn: "Schedule", path: "curso.horario", kind: "scalar", hint: "Bloques semanales formateados: 'Lun 10:00–12:00 · Jue 14:00–16:00'", hintEn: "Formatted weekly blocks: 'Mon 10:00–12:00 · Thu 14:00–16:00'" },
      // El vocero del curso: quien es y como contactarlo. NO es un campo de
      // texto del curso — es el matriculado que el docente marco como vocero
      // (course_enrollments.vocero_marcado_at). El dato existia y no habia
      // variable, y por eso el Acuerdo Pedagogico salia con esas casillas en
      // blanco aunque el docente ya lo hubiera marcado.
      { label: "Vocero · Nombre", labelEn: "Class rep · Name", path: "curso.vocero.nombre", kind: "scalar", hint: "El matriculado marcado como vocero. Se marca en el curso, en «Vocero»", hintEn: "The enrolled student marked as class rep. Set it on the course, under «Vocero»" },
      { label: "Vocero · Teléfono", labelEn: "Class rep · Phone", path: "curso.vocero.telefono", kind: "scalar", hint: "Se escribe al marcar al vocero. Vacío si nadie lo cargó: la casilla queda para llenar a mano", hintEn: "Entered when marking the class rep. Empty if nobody filled it in: the box is left to write by hand" },
      { label: "Vocero · Correo", labelEn: "Class rep · Email", path: "curso.vocero.email", kind: "scalar", hint: "El institucional; si no tiene, el personal", hintEn: "The institutional one; the personal one as a fallback" },
      { label: "Vocero · Documento", labelEn: "Class rep · ID document", path: "curso.vocero.documento", kind: "scalar" },
      { label: "Periodo", labelEn: "Term", path: "periodo", kind: "scalar" },
      { label: "Periodo · Inicio", labelEn: "Term · Start", path: "periodo_obj.start_date", kind: "scalar" },
      { label: "Periodo · Fin", labelEn: "Term · End", path: "periodo_obj.end_date", kind: "scalar" },
      { label: "Periodo · Estado", labelEn: "Term · Status", path: "periodo_obj.status", kind: "scalar" },
      { label: "Fecha de emisión", labelEn: "Issue date", path: "fecha_emision", kind: "scalar" },
    ],
  },
  {
    label: "Docente",
    labelEn: "Teacher",
    path: "docente",
    kind: "group",
    children: [
      { label: "Nombre", labelEn: "Name", path: "docente.nombre", kind: "scalar" },
      { label: "Correo", labelEn: "Email", path: "docente.email", kind: "scalar" },
    ],
  },
  {
    label: "Institución",
    labelEn: "Institution",
    path: "institucion",
    kind: "group",
    children: [
      { label: "Nombre", labelEn: "Name", path: "institucion.nombre", kind: "scalar" },
      { label: "Logo (URL)", labelEn: "Logo (URL)", path: "institucion.logo", kind: "scalar" },
      { label: "Ciudad", labelEn: "City", path: "institucion.ciudad", kind: "scalar", hint: "La ciudad de la sede. Se escribe una vez en Configuración → General y la usan todos los informes", hintEn: "The campus city. Set it once in Settings → General and every report uses it" },
    ],
  },
  {
    label: "Notas",
    labelEn: "Grades",
    path: "notas",
    kind: "group",
    children: [
      { label: "Nota final", labelEn: "Final grade", path: "nota_final", kind: "scalar" },
      { label: "Aprobado (true/false)", labelEn: "Passed (true/false)", path: "aprobado", kind: "scalar", hint: "Para usar con {{#if aprobado}}", hintEn: "For use with {{#if aprobado}}" },
      { label: "Estado de aprobación", labelEn: "Pass status", path: "estado_aprobacion", kind: "scalar", hint: "'Aprobado', 'Reprobado' o 'Sin nota'", hintEn: "'Passed', 'Failed' or 'No grade'" },
      { label: "Escala máxima", labelEn: "Max scale", path: "escala_max", kind: "scalar" },
      {
        label: "Iterar cortes",
        labelEn: "Iterate terms",
        path: "cortes",
        kind: "each",
        hint: "{{nombre}}, {{nota}}, {{peso}}",
      },
      {
        label: "Iterar exámenes",
        labelEn: "Iterate exams",
        path: "examenes",
        kind: "each",
        hint: "{{titulo}}, {{nota}}, {{peso}}",
      },
      {
        label: "Iterar talleres",
        labelEn: "Iterate workshops",
        path: "talleres",
        kind: "each",
        hint: "{{titulo}}, {{nota}}, {{peso}}",
      },
      {
        label: "Iterar proyectos",
        labelEn: "Iterate projects",
        path: "proyectos",
        kind: "each",
        hint: "{{titulo}}, {{nota}}, {{peso}}",
      },
    ],
  },
  {
    // UNA evaluación concreta (el examen, taller o proyecto que se elige al
    // GENERAR el informe, no al redactar la plantilla). Es lo que permite que la
    // MISMA plantilla sirva para cualquier prueba: el cuestionario se recorre con
    // `{{#each evaluacion.preguntas}}` y el título sale de la variable, así que no
    // hay que hacer una plantilla por prueba.
    label: "Evaluación (la que elijas al generar)",
    labelEn: "Assessment (chosen when generating)",
    path: "evaluacion",
    kind: "group",
    hint: "Solo se llena si al generar el informe eliges un examen, taller o proyecto",
    hintEn: "Only filled in if you pick an exam, workshop or project when generating",
    children: [
      { label: "Título", labelEn: "Title", path: "evaluacion.titulo", kind: "scalar" },
      { label: "Clase de actividad", labelEn: "Activity kind", path: "evaluacion.tipo", kind: "scalar", hint: "examen / taller / proyecto", hintEn: "exam / workshop / project" },
      { label: "Fecha de entrega", labelEn: "Submitted on", path: "evaluacion.fecha_entrega", kind: "scalar" },
      { label: "Estado de la entrega", labelEn: "Submission status", path: "evaluacion.estado", kind: "scalar" },
      { label: "Puntaje obtenido", labelEn: "Points earned", path: "evaluacion.puntaje_obtenido", kind: "scalar" },
      { label: "Puntaje total", labelEn: "Points possible", path: "evaluacion.puntaje_total", kind: "scalar" },
      { label: "Nota", labelEn: "Grade", path: "evaluacion.nota", kind: "scalar", hint: "En la escala del curso, la misma que muestra el libro de notas", hintEn: "On the course scale, the same one the gradebook shows" },
      { label: "Cuánto aporta a la nota final", labelEn: "Weight in the final grade", path: "evaluacion.aporte_nota_final", kind: "scalar", hint: "Frase ya armada; dice 'no aporta' cuando la actividad no tiene peso", hintEn: "Ready-made sentence; says 'does not count' when the activity has no weight" },
      { label: "Preguntas respondidas", labelEn: "Questions answered", path: "evaluacion.respondidas", kind: "scalar", hint: "Ej. '10 de 13'", hintEn: "e.g. '10 of 13'" },
      { label: "Comentario del docente", labelEn: "Teacher comment", path: "evaluacion.comentario_docente", kind: "scalar" },
      { label: "Promedio del grupo", labelEn: "Class average", path: "evaluacion.grupo.promedio_curso", kind: "scalar", hint: "Promedio de quienes entregaron, para ubicar al estudiante sin nombrar a nadie", hintEn: "Average of those who submitted, to place the student without naming anyone" },
      { label: "Total de preguntas", labelEn: "Total questions", path: "evaluacion.total_preguntas", kind: "scalar" },
      { label: "Correctas", labelEn: "Correct", path: "evaluacion.correctas", kind: "scalar" },
      { label: "Parciales", labelEn: "Partially correct", path: "evaluacion.parciales", kind: "scalar" },
      { label: "Incorrectas", labelEn: "Incorrect", path: "evaluacion.incorrectas", kind: "scalar" },
      { label: "Sin responder", labelEn: "Unanswered", path: "evaluacion.sin_responder", kind: "scalar" },
      {
        label: "Iterar todas las preguntas",
        labelEn: "Iterate every question",
        path: "evaluacion.preguntas",
        kind: "each",
        hint: "Dentro: {{numero}}, {{enunciado}}, {{tipo}}, {{respuesta}}, {{respuesta_correcta}}, {{obtenido}}, {{puntos}}, {{retroalimentacion}}, {{resultado}}, {{porcentaje_curso}}",
        hintEn: "Inside: {{numero}}, {{enunciado}}, {{tipo}}, {{respuesta}}, {{respuesta_correcta}}, {{obtenido}}, {{puntos}}, {{retroalimentacion}}, {{resultado}}, {{porcentaje_curso}}",
      },
      {
        label: "Iterar lo que hay que reforzar",
        labelEn: "Iterate what needs work",
        path: "evaluacion.preguntas_a_reforzar",
        kind: "each",
        hint: "Las que no quedaron correctas. Mismos campos que la lista completa. Envolvelo en {{#if evaluacion.preguntas_a_reforzar}} para que la sección desaparezca cuando no hay ninguna",
        hintEn: "The ones that were not correct. Same fields as the full list. Wrap it in {{#if evaluacion.preguntas_a_reforzar}} so the section disappears when there are none",
      },
      {
        label: "Iterar las que quedaron bien",
        labelEn: "Iterate the correct ones",
        path: "evaluacion.preguntas_correctas",
        kind: "each",
        hint: "Mismos campos que la lista completa",
        hintEn: "Same fields as the full list",
      },
      {
        // El criterio de corrección está escrito PARA EL DOCENTE y en la práctica
        // es la clave de respuestas ("Correcta: 'Una tabla intermedia…'"). Existe
        // como variable porque un informe interno de revisión lo necesita, pero
        // va en su propio grupo para que nadie lo ponga por descuido en el
        // documento que se le entrega al estudiante.
        label: "Solo uso docente",
        labelEn: "Teacher-only",
        path: "evaluacion.docente",
        kind: "group",
        hint: "No lo pongas en un informe que le entregas al estudiante",
        hintEn: "Do not put this in a report you hand to the student",
        children: [
          {
            label: "Criterio de corrección",
            labelEn: "Grading criteria",
            path: "criterio_docente",
            kind: "scalar",
            hint: "Es la clave de respuestas: dice qué se esperaba. Solo dentro de un bucle de preguntas, y solo en un informe interno",
            hintEn: "It is the answer key: it states what was expected. Only inside a questions loop, and only in an internal report",
          },
        ],
      },
    ],
  },
  {
    // La firma como VARIABLE, no como caja. El valor es la RANURA anclada a la
    // persona (un recuadro vacío), nunca una firma: al generar el informe todavía
    // no hay ninguna, y el documento guardado es justo lo que se firma.
    label: "Firma",
    labelEn: "Signature",
    path: "firmantes",
    kind: "group",
    hint: "Insertá la ranura donde quieras: al pie, en una celda, al lado de un párrafo",
    hintEn: "Insert the signature slot anywhere: in a footer, a cell, next to a paragraph",
    children: [
      {
        label: "Ranura de firma del estudiante",
        labelEn: "Student signature slot",
        path: "firmantes.estudiante.ranura",
        kind: "scalar",
        raw: true,
        hint: "Solo en informes POR ESTUDIANTE. Queda un recuadro donde ese estudiante —y solo él— puede firmar",
        hintEn: "Student reports only. Leaves a box where that student — and only that student — can sign",
      },
      {
        label: "Nombre de quien firma",
        labelEn: "Signer name",
        path: "firmantes.estudiante.nombre",
        kind: "scalar",
        hint: "Para rotular la ranura ('Firma de …')",
        hintEn: "To label the slot ('Signed by …')",
      },
      {
        label: "Ranura de firma de la fila",
        labelEn: "Row signature slot",
        path: "ranura",
        kind: "scalar",
        raw: true,
        hint: "Solo sirve DENTRO de {{#each estudiantes}}: es la ranura del estudiante de esa fila",
        hintEn: "Only works INSIDE {{#each estudiantes}}: it is that row's student slot",
      },
    ],
  },
  {
    label: "Asistencia",
    labelEn: "Attendance",
    path: "asistencia",
    kind: "group",
    children: [
      { label: "Presentes", labelEn: "Present", path: "asistencia.presentes", kind: "scalar" },
      { label: "Ausentes", labelEn: "Absent", path: "asistencia.ausentes", kind: "scalar" },
      { label: "Total sesiones", labelEn: "Total sessions", path: "asistencia.total", kind: "scalar" },
      { label: "Porcentaje", labelEn: "Percentage", path: "asistencia.porcentaje", kind: "scalar" },
    ],
  },
  {
    label: "Curso (solo informes consolidados)",
    labelEn: "Course (consolidated reports only)",
    path: "estudiantes",
    kind: "group",
    hint: "Solo aparece en informes consolidados de curso",
    hintEn: "Only appears in consolidated course reports",
    children: [
      {
        label: "Iterar estudiantes",
        labelEn: "Iterate students",
        path: "estudiantes",
        kind: "each",
        hint: "Dentro: {{nombre}}, {{email}}, {{codigo}}, {{documento}}, {{nota_final}}, {{estado_aprobacion}}, {{asistencia.porcentaje}}",
        hintEn: "Inside: {{nombre}}, {{email}}, {{codigo}}, {{documento}}, {{nota_final}}, {{estado_aprobacion}}, {{asistencia.porcentaje}}",
      },
      { label: "Total estudiantes", labelEn: "Total students", path: "total_estudiantes", kind: "scalar" },
      { label: "Total aprobados", labelEn: "Total passed", path: "total_aprobados", kind: "scalar" },
      { label: "Total reprobados", labelEn: "Total failed", path: "total_reprobados", kind: "scalar" },
      { label: "Total sin nota", labelEn: "Total without grade", path: "total_sin_nota", kind: "scalar" },
    ],
  },
];

/**
 * Catálogo de variables ORDENADO según el tipo de informe (scope) — pero
 * mostrando TODAS las variables en ambos scopes, para poder REFERENCIAR datos
 * del curso aunque el informe sea por estudiante (y los escalares del alumno
 * aunque sea por curso). El scope sólo cambia el ORDEN (lo relevante primero):
 *   - 'estudiante': primero estudiante/notas/asistencia, luego curso/docente/
 *     institución y el consolidado `{{#each estudiantes}}`.
 *   - 'curso': primero curso + consolidado `{{#each estudiantes}}` + docente/
 *     institución, luego los escalares del alumno.
 */
export function reportCatalogForScope(
  scope: "estudiante" | "curso",
  catalog: VariableNode[] = REPORT_VARIABLE_CATALOG,
): VariableNode[] {
  const order =
    scope === "estudiante"
      ? [
          "estudiante",
          "evaluacion",
          "notas",
          "asistencia",
          "firmantes",
          "curso",
          "docente",
          "institucion",
          "estudiantes",
        ]
      : [
          "curso",
          "estudiantes",
          "firmantes",
          "docente",
          "institucion",
          "notas",
          "asistencia",
          "evaluacion",
          "estudiante",
        ];
  const rank = (path: string) => {
    const i = order.indexOf(path);
    return i < 0 ? order.length : i;
  };
  return [...catalog].sort((a, b) => rank(a.path) - rank(b.path));
}

/**
 * Filtra el catálogo de variables por texto, PRESERVANDO la jerarquía.
 *
 * El catálogo tiene 49 variables en 7 grupos: buscar "peso" u "objetivos"
 * recorriendo el panel a mano obliga a abrir grupos uno por uno, y las de abajo
 * quedan fuera de pantalla.
 *
 * ── Tres decisiones que cambian el resultado ──────────────────────────
 * 1. **Sin acentos ni mayúsculas**: se busca "codigo" y tiene que aparecer
 *    "Código". En un catálogo en español, exigir la tilde convierte el buscador
 *    en un adorno.
 * 2. **Se busca también en el `path` y en el `hint`**: el docente que ya vio
 *    `{{curso.grupo}}` en otra plantilla escribe "curso.grupo", no "Grupo". Y el
 *    hint es donde viven los campos que solo existen DENTRO de un `each`
 *    (`{{nota_final}}`, `{{documento}}`…), que de otro modo no serían
 *    encontrables por ningún texto.
 * 3. **Un grupo que matchea trae TODOS sus hijos**: buscar "Curso" debe mostrar
 *    el grupo Curso completo, no solo el hijo llamado igual. Si no, el resultado
 *    de buscar el nombre de una carpeta es más pobre que abrirla.
 *
 * Devuelve una copia; nunca muta el catálogo de entrada. Consulta vacía ⇒ el
 * catálogo tal cual (misma referencia de nodos), para no re-renderizar de más.
 */
export function filterVariableCatalog(catalog: VariableNode[], query: string): VariableNode[] {
  const q = normalizeForSearch(query);
  if (!q) return catalog;

  const coincide = (n: VariableNode) =>
    normalizeForSearch(n.label).includes(q) ||
    normalizeForSearch(n.labelEn ?? "").includes(q) ||
    normalizeForSearch(n.path).includes(q) ||
    normalizeForSearch(n.hint ?? "").includes(q) ||
    normalizeForSearch(n.hintEn ?? "").includes(q);

  const podar = (nodos: VariableNode[]): VariableNode[] => {
    const out: VariableNode[] = [];
    for (const n of nodos) {
      if (coincide(n)) {
        // Matchea el nodo: se lleva su subárbol intacto.
        out.push(n);
        continue;
      }
      const hijos = n.children ? podar(n.children) : [];
      if (hijos.length > 0) out.push({ ...n, children: hijos });
    }
    return out;
  };
  return podar(catalog);
}

/**
 * Minúsculas y sin diacríticos, para comparar texto en español.
 *
 * `NFD` separa la letra de su tilde y el rango `\u0300-\u036f` borra la tilde:
 * "Código" → "codigo". Es la misma normalización que hace falta para que
 * "asignatura" encuentre "Asignatura del plan".
 */
export function normalizeForSearch(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Cuenta las variables clickables (no grupos) de un catálogo, recursivo. */
export function countCatalogLeaves(catalog: VariableNode[]): number {
  let n = 0;
  const walk = (nodos: VariableNode[]) => {
    for (const nodo of nodos) {
      if (nodo.kind !== "group") n++;
      if (nodo.children) walk(nodo.children);
    }
  };
  walk(catalog);
  return n;
}

/**
 * Snippet que se inserta al click en un nodo del catálogo.
 */
export function variableSnippet(node: VariableNode): string {
  if (node.kind === "each") {
    return `{{#each ${node.path}}}\n  \n{{/each}}`;
  }
  if (node.kind === "group") return "";
  // Triple llave para las variables cuyo valor ES marcado (la ranura de firma).
  // Entra en el editor como TEXTO plano igual que cualquier otro token —el guard
  // de bloques de `insertAtCursor` busca `{{#` o `{{/`, y acá el carácter que
  // sigue a `{{` es `{`—, así que no hace falta ningún camino de inserción de
  // HTML: ese pasa por `execCommand("insertHTML")`, que no garantiza preservar la
  // clase de la que depende reconocer la ranura.
  if (node.raw) return `{{{${node.path}}}}`;
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
  // Ids de muestra: la ranura de firma se ancla a un id, así que sin esto la
  // vista previa siempre mostraría ranuras SIN ancla —o sea el renglón para
  // firmar a mano— y el docente no podría comprobar en la previa que la firma
  // quedó bien puesta, que es justo para lo que abre la previa.
  const uidMuestra = "11111111-1111-4111-8111-111111111111";
  const uidsFila = [uidMuestra, "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const preguntaMuestra = (
    numero: number,
    enunciado: string,
    resultado: string,
    obtenido: string,
  ) => ({
    numero: String(numero),
    enunciado,
    tipo: "Selección múltiple",
    puntos: "1",
    obtenido,
    respuesta: "Una tabla intermedia con las dos llaves foráneas.",
    respuesta_correcta: "Una tabla intermedia con las dos llaves foráneas.",
    retroalimentacion: "La idea central está bien; falta nombrar la llave primaria compuesta.",
    resultado,
    porcentaje_curso: "62%",
    criterio_docente: "Debe mencionar la tabla intermedia y las dos llaves foráneas.",
  });
  const base: TemplateContext = {
    estudiante: {
      // No se expone en el panel de variables (un UUID a la vista no le sirve a
      // nadie); su único consumidor es la ranura de firma.
      user_id: uidMuestra,
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
      // Con saltos de línea reales: así la vista previa muestra cómo queda un
      // sílabo de varias líneas dentro de la plantilla (que lo pinta con
      // `white-space: pre-line`).
      objetivos: [
        "Comprender los pilares de la programación orientada a objetos.",
        "Implementar estructuras de datos dinámicas.",
        "Construir interfaces gráficas de usuario.",
      ].join("\n"),
      contenidos: "Clases y objetos. Herencia y polimorfismo. Colecciones. Interfaces gráficas.",
      bibliografia: "Deitel & Deitel, Java: How to Program.",
      intensidad_horaria: "4 horas semanales",
      sistema_evaluacion: "Tres cortes: 30% / 30% / 40%.",
      horario: "Lun 10:00–12:00 · Jue 14:00–16:00",
    },
    periodo: "2026-1",
    periodo_obj: { start_date: "2026-01-20", end_date: "2026-05-30", status: "en curso" },
    fecha_emision: "15 de junio de 2026",
    docente: { nombre: "María Rodríguez", email: "maria.rodriguez@correo.edu.co" },
    institucion: { nombre: "Institución Universitaria", logo: SAMPLE_LOGO_DATA_URI },
    firmantes: {
      estudiante: {
        user_id: uidMuestra,
        nombre: "Juan Pérez Gómez",
        ranura: ranuraHtml(uidMuestra),
      },
    },
    evaluacion: {
      tipo: "examen",
      titulo: "Prueba diagnóstica",
      fecha_entrega: "12 mar 2026, 10:24",
      estado: "Calificada",
      puntaje_obtenido: "8,5",
      puntaje_total: "13",
      nota: "3,3",
      aporte_nota_final: "Esta actividad no aporta a la nota final del curso.",
      respondidas: "10 de 13",
      comentario_docente: "Buen manejo de las relaciones; repasá la normalización.",
      total_preguntas: "13",
      correctas: "7",
      parciales: "2",
      incorrectas: "1",
      sin_responder: "3",
      grupo: { promedio_curso: "3,1" },
      preguntas: [
        preguntaMuestra(1, "¿Cómo se representa una relación de muchos a muchos?", "Correcta", "1"),
        preguntaMuestra(2, "¿Qué garantiza una llave foránea?", "Parcial", "0,5"),
        preguntaMuestra(3, "¿Para qué sirve normalizar?", "Sin responder", "0"),
      ],
      preguntas_a_reforzar: [
        preguntaMuestra(2, "¿Qué garantiza una llave foránea?", "Parcial", "0,5"),
        preguntaMuestra(3, "¿Para qué sirve normalizar?", "Sin responder", "0"),
      ],
      preguntas_correctas: [
        preguntaMuestra(1, "¿Cómo se representa una relación de muchos a muchos?", "Correcta", "1"),
      ],
    },
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
      { user_id: uidsFila[0], ranura: ranuraHtml(uidsFila[0]), nombre: "Juan Pérez", email: "juan@correo.edu.co", codigo: "20211020", documento: "1.234.567.890", nota_final: "4,3", estado_aprobacion: "Aprobado", asistencia: { porcentaje: "90%" } },
      { user_id: uidsFila[1], ranura: ranuraHtml(uidsFila[1]), nombre: "Ana Gómez", email: "ana@correo.edu.co", codigo: "20211021", documento: "1.234.567.891", nota_final: "3,1", estado_aprobacion: "Aprobado", asistencia: { porcentaje: "85%" } },
      { user_id: uidsFila[2], ranura: ranuraHtml(uidsFila[2]), nombre: "Luis Torres", email: "luis@correo.edu.co", codigo: "20211022", documento: "1.234.567.892", nota_final: "2,4", estado_aprobacion: "Reprobado", asistencia: { porcentaje: "70%" } },
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

/**
 * System prompt POR DEFECTO de la generación de informes con IA
 * (use_case `report_generation`). Es el "platform default" editable desde
 * Admin → IA → Prompts. DEBE mantenerse byte-idéntico con:
 *   - el seed de la migración 20260976000000_report_generation_prompt.sql
 *   - el FALLBACK del edge `ai-generate-report`
 *   - el defaultPrompt de `AdminPromptsPanel` (use_case report_generation)
 */
export const DEFAULT_REPORT_GENERATION_PROMPT = [
  "Eres un asistente que redacta secciones de informes académicos para un docente.",
  "Escribe en español (es-CO), tono formal e institucional, claro y conciso.",
  "El texto que produces es una PLANTILLA: cuando un dato provenga de las variables",
  "disponibles, inserta el placeholder con doble llave (por ejemplo {{estudiante.nombre}})",
  "EN LUGAR del valor concreto, para que el sistema lo reemplace luego por cada",
  "estudiante o curso. Usa los valores concretos solo como referencia de contexto.",
  "Devuelve únicamente el texto/HTML de la sección, sin explicaciones ni comentarios,",
  "sin envolver en bloques de código.",
].join("\n");

/** Quita imágenes embebidas (data URIs base64) que inflan el prompt — el
 *  modelo no necesita los bytes de la imagen, solo saber que hay una. */
function stripDataUris(s: string): string {
  return s
    .replace(/\bsrc\s*=\s*"data:[^"]*"/gi, 'src="[imagen]"')
    .replace(/\bsrc\s*=\s*'data:[^']*'/gi, "src='[imagen]'");
}

export function buildAiReportPrompt(args: AiReportPromptArgs): { system: string; user: string } {
  const { draftText, instruction, ctx, catalog } = args;
  const paths = flattenCatalogPaths(catalog);
  // Topes anti `prompt_too_large` (el edge rechaza > 200K chars): el resumen
  // del curso y el texto del borrador se acotan, y se eliminan las imágenes
  // embebidas (data URIs) del borrador antes de mandarlo.
  const ctxSummary = summarizeContextForAi(ctx).slice(0, 12_000);
  const cleanDraft = stripDataUris(draftText ?? "").trim().slice(0, 8_000);

  const system = DEFAULT_REPORT_GENERATION_PROMPT;

  const user = [
    `INSTRUCCIÓN DEL DOCENTE:\n${instruction.trim() || "Genera el contenido del informe."}`,
    "",
    `VARIABLES DISPONIBLES (usa estos placeholders {{...}} cuando apliquen):\n${paths.join(", ")}`,
    "",
    `DATOS DEL CURSO (referencia de contexto, no los incrustes literalmente si hay una variable):\n${ctxSummary}`,
    "",
    cleanDraft
      ? `TEXTO ACTUAL DEL INFORME (mejóralo / complétalo según la instrucción):\n${cleanDraft}`
      : "El informe está vacío: genera el contenido desde cero según la instrucción.",
  ].join("\n");

  return { system, user };
}
