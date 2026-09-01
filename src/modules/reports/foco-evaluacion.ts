/**
 * El DETALLE de UNA evaluación concreta —el examen, taller o proyecto que el
 * docente elige al generar el informe— convertido en el sub-objeto `evaluacion`
 * del contexto de plantillas.
 *
 * ── Por qué hace falta, si el contexto ya trae exámenes y talleres ─────
 * Lo que el contexto trae hoy es el ROLL-UP: título, nota y peso. Con eso se
 * arma un boletín, pero no un informe que le sirva al estudiante: para eso hace
 * falta qué preguntó la prueba, qué contestó él, cuánto sacó en cada una y qué
 * le dijo la retroalimentación. Nada de eso es dato nuevo en la base —vive en
 * `answers.__breakdown` (examen) y en una fila por pregunta (taller/proyecto)—;
 * lo que faltaba era leerlo.
 *
 * ── PURO a propósito ──────────────────────────────────────────────────
 * Recibe filas y devuelve el objeto. No consulta la base, no importa React y no
 * conoce Supabase, así que las cinco trampas del dato de abajo se pueden probar
 * una por una sin levantar nada. Las consultas viven en `report-context.ts`.
 *
 * ── Las cinco trampas del dato, y por qué están acá y no en la pantalla ─
 * 1. **La nota NO se recalcula.** `submissions.ai_grade` NO es una nota en la
 *    escala del curso: es la SUMA CRUDA de puntos (medido: una entrega con
 *    `ai_grade` 3,5 sobre 10 preguntas de 0,5). El informe recibe la nota YA
 *    resuelta por el mismo camino que el libro de notas y no la deduce del
 *    detalle. Si la dedujera, el papel firmado diría una nota y la pantalla del
 *    curso otra, para la misma prueba.
 * 2. **El puntaje del docente gana.** `answers.__manual_overrides[qid].score`
 *    pisa a `__breakdown[].earned`. Hoy no hay ningún override en producción, así
 *    que mirar solo el desglose *parece* correcto y miente el día que un docente
 *    corrija una pregunta a mano.
 * 3. **Se recorren las PREGUNTAS, nunca las claves de `answers`.** Ese objeto
 *    mezcla respuestas con metadatos reservados: `__breakdown`,
 *    `__manual_overrides`, `__session_id`, `__warning_events`, `__saved_at` y
 *    `__current_idx` (los seis verificados en entregas reales). Iterar sus claves
 *    mete basura en el documento.
 * 4. **La respuesta se normaliza por tipo.** Una `cerrada` guarda el ÍNDICE de la
 *    opción, no su texto; una `bd_sql` guarda un objeto; una `so_consola`, un
 *    sobre con el transcript. Volcar el valor crudo le imprime al estudiante un
 *    "1" o un JSON, que es peor que no imprimir nada.
 * 5. **El criterio de corrección es la clave de respuestas.** `expected_rubric`
 *    está escrito para el docente y en la práctica dice la respuesta ("Correcta:
 *    'Una tabla intermedia…'"). Viaja en el objeto porque un informe interno de
 *    revisión lo necesita, pero por eso el catálogo lo separa en "Solo uso
 *    docente" y la plantilla que se entrega no lo usa.
 *
 * ── Los textos en español de acá son CONTENIDO del documento ───────────
 * `resultado`, `respondidas` y la frase del aporte a la nota son parte del
 * documento generado, no de la interfaz: salen impresos dentro del informe, cuyo
 * cuerpo es una plantilla en es-CO. Por eso van literales y no por `t(...)` — lo
 * que se traduce es la pantalla que rodea al documento.
 */
import { formatDateTime, formatNumber } from "@/shared/lib/format";
import { isQuestionAnswered } from "@/modules/exams/answered";
import { sqlSourceForDisplay } from "@/modules/database/sql-answer";
import { v86TranscriptForDisplay } from "@/modules/serverconsole/v86-answer";
import { parseNetworkAnswer } from "@/modules/network/scenario";
import { statusLabel } from "@/shared/utils/status-labels";

export type FocoTipo = "examen" | "taller" | "proyecto";

/** Los CUATRO resultados posibles de una pregunta. No hay un quinto. */
export type ResultadoPregunta = "Correcta" | "Parcial" | "Incorrecta" | "Sin responder";

/** Etiqueta de `evaluacion.tipo`, para el documento. */
const ETIQUETA_TIPO: Record<FocoTipo, string> = {
  examen: "examen",
  taller: "taller",
  proyecto: "proyecto",
};

/**
 * Una pregunta, ya normalizada desde cualquiera de las tres tablas de origen.
 * `questions` y `workshop_questions` tienen el MISMO shape (verificado por REST);
 * `project_files` no: ahí el enunciado son `title` + `description`.
 */
export interface PreguntaFuente {
  id: string;
  enunciado: string;
  tipo: string;
  puntos: number;
  posicion: number;
  /** `expected_rubric`: el criterio de corrección. Solo uso docente. */
  criterio: string;
  opciones: unknown;
  starter_code: string | null;
  language: string | null;
}

/** Fila de `questions` o de `workshop_questions`. */
export interface FilaPreguntaBanco {
  id: string;
  content?: string | null;
  type?: string | null;
  points?: number | null;
  position?: number | null;
  expected_rubric?: string | null;
  options?: unknown;
  starter_code?: string | null;
  language?: string | null;
}

/** Fila de `project_files`. */
export interface FilaArchivoProyecto {
  id: string;
  title?: string | null;
  description?: string | null;
  type?: string | null;
  points?: number | null;
  position?: number | null;
  expected_rubric?: string | null;
  options?: unknown;
  starter_code?: string | null;
  language?: string | null;
}

/** Lo que un estudiante dejó en UNA pregunta. */
export interface RespuestaFuente {
  /** Valor tal cual lo guardó el alumno. Se normaliza según el tipo. */
  valor: unknown;
  /** Puntos obtenidos. `null` = todavía sin puntaje. */
  obtenido: number | null;
  retroalimentacion: string;
}

/** Fila de `workshop_submission_answers` o de `project_submission_files`. */
export interface FilaRespuestaItem {
  /** `question_id` en talleres; `file_id` en proyectos. */
  id: string;
  answer_text?: string | null;
  selected_option?: string | number | null;
  code_content?: string | null;
  diagram_code?: string | null;
  /** `project_submission_files.content`. */
  content?: string | null;
  ai_grade?: number | null;
  ai_feedback?: string | null;
}

export interface PreguntaEvaluacion {
  numero: string;
  enunciado: string;
  tipo: string;
  puntos: string;
  obtenido: string;
  respuesta: string;
  respuesta_correcta: string;
  retroalimentacion: string;
  resultado: ResultadoPregunta;
  porcentaje_curso: string;
  /** Solo uso docente: es la clave de respuestas. */
  criterio_docente: string;
}

export interface EvaluacionCtx {
  tipo: string;
  titulo: string;
  fecha_entrega: string;
  estado: string;
  puntaje_obtenido: string;
  puntaje_total: string;
  nota: string;
  aporte_nota_final: string;
  respondidas: string;
  comentario_docente: string;
  total_preguntas: string;
  correctas: string;
  parciales: string;
  incorrectas: string;
  sin_responder: string;
  grupo: { promedio_curso: string };
  preguntas: PreguntaEvaluacion[];
  preguntas_a_reforzar: PreguntaEvaluacion[];
  preguntas_correctas: PreguntaEvaluacion[];
}

export interface ArgsConstruirEvaluacion {
  tipo: FocoTipo;
  titulo: string;
  /** % de la nota final del curso que aporta la actividad. */
  peso: number;
  /**
   * Nota de la actividad para ESTE estudiante, en la escala del curso, YA
   * resuelta por el mismo camino que el libro de notas. Nunca se recalcula acá.
   */
  nota: number | null;
  /** ISO de la entrega. Se formatea acá. */
  fechaEntrega?: string | null;
  /** Valor crudo de la columna `status`. Se traduce acá. */
  estado?: string | null;
  comentarioDocente?: string | null;
  preguntas: PreguntaFuente[];
  respuestas: Map<string, RespuestaFuente>;
  /**
   * Las respuestas de TODO el curso (incluida la del estudiante). Alimentan
   * `porcentaje_curso`: ubicar al estudiante frente al grupo sin nombrar a nadie.
   */
  respuestasCurso?: ReadonlyArray<Map<string, RespuestaFuente>>;
  /** Notas resueltas de todo el curso, para `grupo.promedio_curso`. */
  notasCurso?: ReadonlyArray<number | null>;
}

// ── Adaptadores de fila → PreguntaFuente ────────────────────────────

function num(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** `questions` y `workshop_questions` (mismo shape). Ordena por `position`. */
export function preguntasDeBanco(filas: ReadonlyArray<FilaPreguntaBanco>): PreguntaFuente[] {
  return [...filas]
    .map((f, i) => ({
      id: f.id,
      enunciado: (f.content ?? "").trim(),
      tipo: f.type ?? "abierta",
      puntos: num(f.points, 0),
      posicion: num(f.position, i),
      criterio: (f.expected_rubric ?? "").trim(),
      opciones: f.options ?? null,
      starter_code: f.starter_code ?? null,
      language: f.language ?? null,
    }))
    .sort((a, b) => a.posicion - b.posicion);
}

/**
 * `project_files`. El enunciado es `title` + `description`: el `title` solo es
 * un rótulo ("Justificación de decisiones de diseño") y sin la descripción el
 * estudiante no reconoce qué le pidieron. `content` existe en la tabla pero está
 * vacío en todo lo que hay en producción, así que no se usa como enunciado.
 */
export function preguntasDeProyecto(
  filas: ReadonlyArray<FilaArchivoProyecto>,
): PreguntaFuente[] {
  return [...filas]
    .map((f, i) => {
      const titulo = (f.title ?? "").trim();
      const desc = (f.description ?? "").trim();
      return {
        id: f.id,
        enunciado: [titulo, desc].filter(Boolean).join(" — "),
        tipo: f.type ?? "abierta",
        puntos: num(f.points, 0),
        posicion: num(f.position, i),
        criterio: (f.expected_rubric ?? "").trim(),
        opciones: f.options ?? null,
        starter_code: f.starter_code ?? null,
        language: f.language ?? null,
      };
    })
    .sort((a, b) => a.posicion - b.posicion);
}

// ── Adaptadores de entrega → Map<qid, RespuestaFuente> ──────────────

/** Claves reservadas de `submissions.answers`: NO son respuestas. */
export const CLAVES_RESERVADAS_ANSWERS = [
  "__breakdown",
  "__manual_overrides",
  "__session_id",
  "__warning_events",
  "__saved_at",
  "__current_idx",
] as const;

interface FilaDesglose {
  qid?: string;
  earned?: number | null;
  feedback?: string | null;
}

/**
 * Entrega de EXAMEN: el detalle vive dentro del JSONB `answers`.
 *
 * Se recorren las PREGUNTAS (nunca las claves de `answers`) y el puntaje sale de
 * `__manual_overrides[qid]` si existe y de `__breakdown` si no — en ese orden,
 * porque la corrección a mano del docente es la que vale.
 */
export function respuestasDeExamen(
  preguntas: ReadonlyArray<PreguntaFuente>,
  answers: unknown,
): Map<string, RespuestaFuente> {
  const mapa = new Map<string, RespuestaFuente>();
  const obj = (answers && typeof answers === "object" ? answers : {}) as Record<string, unknown>;
  const desglose = Array.isArray(obj.__breakdown) ? (obj.__breakdown as FilaDesglose[]) : [];
  const porQid = new Map<string, FilaDesglose>();
  for (const d of desglose) if (d && typeof d.qid === "string") porQid.set(d.qid, d);
  const overrides = (
    obj.__manual_overrides && typeof obj.__manual_overrides === "object"
      ? obj.__manual_overrides
      : {}
  ) as Record<string, { score?: unknown; feedback?: unknown } | undefined>;

  for (const q of preguntas) {
    const d = porQid.get(q.id);
    const ov = overrides[q.id];
    const puntajeOverride = ov && ov.score != null ? Number(ov.score) : null;
    const puntajeIa = d && d.earned != null ? Number(d.earned) : null;
    const obtenido =
      puntajeOverride != null && Number.isFinite(puntajeOverride) ? puntajeOverride : puntajeIa;
    const fb =
      (typeof ov?.feedback === "string" ? ov.feedback : "") || (d?.feedback ?? "") || "";
    mapa.set(q.id, {
      valor: obj[q.id],
      obtenido: obtenido != null && Number.isFinite(obtenido) ? obtenido : null,
      retroalimentacion: String(fb).trim(),
    });
  }
  return mapa;
}

/**
 * Entrega de TALLER o PROYECTO: una fila por pregunta, con su nota y su
 * retroalimentación en columnas propias.
 *
 * El orden de preferencia del valor (`code_content` → `diagram_code` →
 * `selected_option` → `answer_text` → `content`) es el MISMO que usa la pantalla
 * de calificación del taller; si divergiera, el informe mostraría una respuesta
 * distinta de la que el docente ve al calificar.
 */
export function respuestasDeFilas(
  preguntas: ReadonlyArray<PreguntaFuente>,
  filas: ReadonlyArray<FilaRespuestaItem>,
): Map<string, RespuestaFuente> {
  const porId = new Map<string, FilaRespuestaItem>();
  for (const f of filas) if (f && f.id) porId.set(f.id, f);
  const mapa = new Map<string, RespuestaFuente>();
  for (const q of preguntas) {
    const f = porId.get(q.id);
    if (!f) {
      mapa.set(q.id, { valor: undefined, obtenido: null, retroalimentacion: "" });
      continue;
    }
    let valor: unknown =
      f.code_content ?? f.diagram_code ?? f.selected_option ?? f.answer_text ?? f.content ?? undefined;
    // En una pregunta cerrada el taller guarda el ÍNDICE como texto
    // (`String(raw)`), y el predicado de "respondida" espera un número.
    if (
      (q.tipo === "cerrada" || q.tipo === "cerrada_multi") &&
      typeof valor === "string" &&
      valor.trim() !== "" &&
      Number.isFinite(Number(valor))
    ) {
      valor = Number(valor);
    }
    mapa.set(q.id, {
      valor,
      obtenido: f.ai_grade != null && Number.isFinite(Number(f.ai_grade)) ? Number(f.ai_grade) : null,
      retroalimentacion: (f.ai_feedback ?? "").trim(),
    });
  }
  return mapa;
}

// ── Normalización de la respuesta según el tipo ─────────────────────

function opcionesTexto(opciones: unknown): string[] {
  const o = opciones as { choices?: unknown } | null;
  if (!o || !Array.isArray(o.choices)) return [];
  return o.choices.map((c) => String(c ?? ""));
}

/** Texto legible de la respuesta del alumno, según el tipo de pregunta. */
export function respuestaLegible(q: PreguntaFuente, valor: unknown): string {
  if (valor == null) return "";
  const choices = opcionesTexto(q.opciones);
  switch (q.tipo) {
    case "cerrada": {
      const i = Number(valor);
      if (!Number.isFinite(i) || i < 0) return "";
      return choices[i] ?? String(i + 1);
    }
    case "cerrada_multi": {
      if (!Array.isArray(valor)) return "";
      return valor
        .map((v) => {
          const i = Number(v);
          return choices[i] ?? (Number.isFinite(i) ? String(i + 1) : "");
        })
        .filter(Boolean)
        .join(" · ");
    }
    case "bd_sql":
      // El SQL que escribió, no el sobre con los resultados: en un informe lo
      // que se lee es la consulta.
      return sqlSourceForDisplay(valor) ?? "";
    case "so_consola":
      return v86TranscriptForDisplay(valor) ?? (typeof valor === "string" ? valor : "");
    case "red_consola":
    case "red_gui": {
      const parsed = parseNetworkAnswer(valor);
      if (!parsed) return "";
      const comandos = Object.values(parsed.histories)
        .flatMap((h) => (Array.isArray(h) ? h : []))
        .map((c) => String(c));
      return comandos.join("\n");
    }
    default:
      if (typeof valor === "string") return valor;
      if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
      // Cualquier otro objeto: mejor vacío que un JSON crudo dentro de un
      // documento que el estudiante recibe firmado.
      return "";
  }
}

/** La respuesta correcta, cuando la pregunta TIENE una. */
export function respuestaCorrectaLegible(q: PreguntaFuente): string {
  const choices = opcionesTexto(q.opciones);
  const o = q.opciones as { correct_index?: unknown; correct_indices?: unknown } | null;
  if (q.tipo === "cerrada") {
    const i = Number(o?.correct_index);
    if (!Number.isFinite(i) || i < 0) return "";
    return choices[i] ?? "";
  }
  if (q.tipo === "cerrada_multi") {
    const idx = Array.isArray(o?.correct_indices) ? (o!.correct_indices as unknown[]) : [];
    return idx
      .map((v) => choices[Number(v)] ?? "")
      .filter(Boolean)
      .join(" · ");
  }
  // Abierta, código, SQL, consola: no hay UNA respuesta guardada. Lo que existe
  // es el criterio de corrección, y ese es de uso docente.
  return "";
}

// ── Formato ─────────────────────────────────────────────────────────

/** Puntos: hasta 2 decimales, sin ceros de relleno. "13", "0,5", "2,95". */
function puntos(n: number | null | undefined): string {
  return formatNumber(n, { maximumFractionDigits: 2 }, "—");
}

/** Nota: SIEMPRE un decimal, como en el libro de notas. */
function nota1(n: number | null | undefined): string {
  return formatNumber(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 }, "—");
}

/**
 * Estado de la entrega, traducido y sin acusaciones.
 *
 * `sospechoso` y `requiere_revision` se derivan del detector de fraude por IA, y
 * ese detector NO va en un documento que se le entrega al estudiante (misma
 * razón por la que no se exponen `ai_reasons` ni `ai_likelihood`). Se muestra el
 * hecho verdadero —falta que el docente lo revise— en vez de la sospecha.
 */
export function estadoLegible(estado: string | null | undefined): string {
  if (!estado) return "";
  if (estado === "sospechoso" || estado === "requiere_revision") return "En revisión";
  return statusLabel(estado);
}

/** Clasifica una pregunta. Ver el docstring del módulo para el caso sin nota. */
export function clasificarResultado(
  respondida: boolean,
  obtenido: number | null,
  puntosMax: number,
): ResultadoPregunta {
  if (!respondida) return "Sin responder";
  // Respondida pero todavía sin puntaje (entrega sin calificar, o una pregunta
  // que la IA no alcanzó a evaluar). De los cuatro valores es el único que no
  // afirma nada falso: decir "Incorrecta" acusa de un error que nadie verificó y
  // "Sin responder" niega un trabajo que el estudiante sí hizo.
  if (obtenido == null) return "Parcial";
  if (obtenido >= puntosMax - 1e-6) return "Correcta";
  if (obtenido <= 1e-6) return "Incorrecta";
  return "Parcial";
}

// ── Constructor ─────────────────────────────────────────────────────

export function construirEvaluacion(a: ArgsConstruirEvaluacion): EvaluacionCtx {
  const {
    tipo,
    titulo,
    peso,
    nota,
    fechaEntrega,
    estado,
    comentarioDocente,
    preguntas,
    respuestas,
    respuestasCurso = [],
    notasCurso = [],
  } = a;

  // El predicado de "respondida" trabaja sobre un objeto tipo `answers`, así que
  // se le arma uno con los valores ya elegidos por fila. Reusarlo (en vez de
  // escribir un chequeo acá) es lo que evita que el informe cuente en blanco lo
  // que la pantalla de entrega contaba como respondido, y al revés.
  const valores: Record<string, unknown> = {};
  for (const q of preguntas) valores[q.id] = respuestas.get(q.id)?.valor;
  const respondida = (q: PreguntaFuente) =>
    isQuestionAnswered(
      {
        id: q.id,
        type: q.tipo,
        options: q.opciones,
        starter_code: q.starter_code,
        language: q.language,
      },
      valores,
    );

  /** Promedio del grupo en una pregunta, como % de sus puntos. */
  const porcentajeCurso = (q: PreguntaFuente): string => {
    if (q.puntos <= 0 || respuestasCurso.length === 0) return "—";
    const obtenidos = respuestasCurso
      .map((m) => m.get(q.id)?.obtenido)
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (obtenidos.length === 0) return "—";
    const media = obtenidos.reduce((s, v) => s + v, 0) / obtenidos.length;
    return `${Math.round((media / q.puntos) * 100)}%`;
  };

  let sumaObtenida = 0;
  let sumaTotal = 0;
  let algunObtenido = false;
  let nRespondidas = 0;
  const filas: PreguntaEvaluacion[] = preguntas.map((q, i) => {
    const r = respuestas.get(q.id);
    const resp = respondida(q);
    if (resp) nRespondidas += 1;
    sumaTotal += q.puntos;
    if (r?.obtenido != null) {
      sumaObtenida += r.obtenido;
      algunObtenido = true;
    }
    return {
      numero: String(i + 1),
      enunciado: q.enunciado,
      tipo: q.tipo,
      puntos: puntos(q.puntos),
      obtenido: r?.obtenido == null ? "—" : puntos(r.obtenido),
      respuesta: respuestaLegible(q, r?.valor),
      respuesta_correcta: respuestaCorrectaLegible(q),
      retroalimentacion: r?.retroalimentacion ?? "",
      resultado: clasificarResultado(resp, r?.obtenido ?? null, q.puntos),
      porcentaje_curso: porcentajeCurso(q),
      criterio_docente: q.criterio,
    };
  });

  const cuenta = (v: ResultadoPregunta) => filas.filter((f) => f.resultado === v).length;
  const notasValidas = notasCurso.filter((n): n is number => n != null && Number.isFinite(n));
  const promedioGrupo =
    notasValidas.length === 0
      ? "—"
      : nota1(notasValidas.reduce((s, v) => s + v, 0) / notasValidas.length);

  return {
    tipo: ETIQUETA_TIPO[tipo],
    titulo,
    fecha_entrega: fechaEntrega ? formatDateTime(fechaEntrega, "") : "",
    estado: estadoLegible(estado),
    // Sin ningún puntaje registrado se muestra "—" y no un 0: un 0 afirma que no
    // acertó nada, cuando lo que pasa es que todavía no está calificado.
    puntaje_obtenido: algunObtenido ? puntos(sumaObtenida) : "—",
    puntaje_total: puntos(sumaTotal),
    nota: nota1(nota),
    aporte_nota_final:
      peso > 0
        ? `Esta actividad aporta el ${formatNumber(peso, { maximumFractionDigits: 2 }, "0")}% de la nota final del curso.`
        : "Esta actividad no aporta a la nota final del curso.",
    respondidas: `${nRespondidas} de ${preguntas.length}`,
    comentario_docente: (comentarioDocente ?? "").trim(),
    total_preguntas: String(preguntas.length),
    correctas: String(cuenta("Correcta")),
    parciales: String(cuenta("Parcial")),
    incorrectas: String(cuenta("Incorrecta")),
    sin_responder: String(cuenta("Sin responder")),
    grupo: { promedio_curso: promedioGrupo },
    preguntas: filas,
    // Tres listas ya calculadas y no un filtro en la plantilla: el motor no
    // tiene comparaciones ni {{else}} a propósito. Y como un array vacío es
    // falsy, `{{#if evaluacion.preguntas_a_reforzar}}` hace desaparecer la
    // sección sola cuando no hay nada que reforzar.
    preguntas_a_reforzar: filas.filter((f) => f.resultado !== "Correcta"),
    preguntas_correctas: filas.filter((f) => f.resultado === "Correcta"),
  };
}
