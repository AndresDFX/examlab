/**
 * Qué tipos acepta cada destino, y cómo se arma la fila que se INSERTA,
 * para el paso «Identificar preguntas desde un texto».
 *
 * ── Por qué este módulo existe ────────────────────────────────────────
 * El armado de `options` / `language` / `starter_code` está copiado casi
 * verbatim en tres pantallas (examen, taller, proyecto) y con matices
 * distintos entre ellas: el examen NO filtra las opciones vacías y los otros
 * dos SÍ. Esta es la cuarta copia, pero encapsulada, pura y con tests: filtra
 * las vacías siempre y decide por tipo en UN solo lugar.
 *
 * Y sobre todo: el mapeo de columnas NO es el mismo por destino. `project_files`
 * guarda el enunciado en `title` (no en `content`), `question_bank` usa
 * `suggested_points` y no tiene `position`, y `workshop_questions`/`project_files`
 * tienen `zip_single` mientras `questions` no. Escribir la columna equivocada
 * no falla: guarda la fila con el enunciado invisible.
 *
 * ── INVARIANTE CROSS-FILE (ver CLAUDE.md) ─────────────────────────────
 * `TIPOS_PROPONIBLES_POR_DESTINO` de
 * `supabase/functions/_shared/identify-questions.ts` (lo que el edge le OFRECE
 * al modelo) debe ser un SUBCONJUNTO de `TIPOS_ACEPTADOS_POR_DESTINO` de acá
 * (lo que el cliente deja elegir y sabe insertar). Si divergen: el edge
 * propone un tipo que el cliente bloquea (fila que el docente no puede
 * insertar y no entiende), o el cliente ofrece uno que el CHECK del destino
 * rechaza → 23514 DESPUÉS de revisar 30 preguntas. Lo fija
 * `identify-types.test.ts`, que importa la constante del edge de verdad.
 */
import {
  JAVAFX_STARTER,
  JAVA_GUI_STARTER,
  PYTHON_GUI_STARTER,
  getStarterCode,
} from "@/modules/code/starters";

/** Las cuatro superficies de autoría donde se puede identificar desde texto. */
export type DestinoIdentificacion = "exam" | "workshop" | "project" | "bank";

/**
 * Tipos que el docente puede ELEGIR en la revisión y que este módulo sabe
 * insertar. Es un SUPERSET de lo que el edge propone: `java_gui` y
 * `python_gui` están acá para que el docente los promueva a mano, pero el
 * modelo no los propone desde prosa genérica (sería alucinación con
 * dependencia de runner).
 *
 * Fuera de los cuatro destinos, siempre:
 *   · `red_consola` / `red_gui` — el escenario (topología + aserciones) ES la
 *     rúbrica, y el repo los genera deterministamente con
 *     `generateNetworkQuestions`, sin modelo.
 *   · `codigo_zip` — prohibido en `questions` por CHECK, y es un entregable de
 *     proyecto entero, no una pregunta de tres líneas.
 *   · `so_consola` — ninguna superficie de autoría lo crea hoy; el examen lo
 *     tira al textarea genérico y depende de que el operador hostee la imagen.
 *
 * `project` NO lleva `bd_sql`: el taker de proyectos es una cadena de
 * `{q.type === "X" && …}` SIN fallback y sin rama `bd_sql` (no importa
 * `SqlRunner`). Un `bd_sql` en un proyecto es insertable pero el alumno ve el
 * enunciado y NADA con qué responder.
 */
export const TIPOS_ACEPTADOS_POR_DESTINO = {
  exam: [
    "abierta",
    "cerrada",
    "cerrada_multi",
    "codigo",
    "diagrama",
    "java_gui",
    "python_gui",
    "bd_sql",
  ],
  workshop: [
    "abierta",
    "cerrada",
    "cerrada_multi",
    "codigo",
    "diagrama",
    "java_gui",
    "python_gui",
    "bd_sql",
  ],
  project: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama", "java_gui", "python_gui"],
  bank: [
    "abierta",
    "cerrada",
    "cerrada_multi",
    "codigo",
    "diagrama",
    "java_gui",
    "python_gui",
    "bd_sql",
  ],
} as const;

/**
 * Copia CONGELADA del set proponible del edge. No se usa en runtime: existe
 * para que el test compare lo que el edge exporta contra lo que este lado
 * espera, y falle si alguien cambia uno de los dos solo.
 */
export const PROPONIBLES_ESPERADO = {
  exam: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama", "bd_sql"],
  workshop: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama", "bd_sql"],
  project: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama"],
  bank: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama", "bd_sql"],
} as const;

/**
 * Un tipo aceptado por al menos un destino. Se deriva de `exam` porque su
 * lista es la más amplia y los demás destinos son subconjuntos de ella.
 */
export type TipoAceptado = (typeof TIPOS_ACEPTADOS_POR_DESTINO)["exam"][number];

export type Confianza = "alta" | "media" | "baja";
export type LenguajeCodigo = "java" | "python" | "javascript";
export type JavaFramework = "swing" | "javafx";

/**
 * Una fila del borrador que el docente revisa. Vive SOLO en el cliente hasta
 * que confirma: nada tocó la base todavía.
 *
 * Los campos por tipo (`opciones`, `setupSql`, `lenguaje`…) se conservan
 * aunque el tipo actual no los use — así cambiar el tipo y volver atrás no
 * pierde lo que la IA propuso ni lo que el docente editó.
 */
export interface BorradorPregunta {
  /** Id local para las keys de React. No es un id de base. */
  id: string;
  tipo: TipoAceptado;
  /** Lo que propuso la IA, para medir cuántos tipos corrigió el docente. */
  tipoPropuesto: string;
  enunciado: string;
  rubrica: string;
  puntos: number;
  incluida: boolean;
  confianza: Confianza;
  /** Una frase: por qué la IA eligió ese tipo. */
  motivo: string;
  /** El trozo del texto pegado del que salió. */
  fragmento: string;
  /** Tipo crudo que el edge degradó, si hubo degradación. */
  degradadoDe: string | null;
  opciones: string[];
  correcta: number | null;
  correctas: number[];
  minSelecciones: number | null;
  maxSelecciones: number | null;
  setupSql: string;
  lenguaje: LenguajeCodigo;
  javaFramework: JavaFramework;
}

/** Clave i18n del motivo por el que una fila no se puede insertar. */
export type MotivoInvalido =
  | "identifyQuestions.invalid.tipoNoAceptado"
  | "identifyQuestions.invalid.enunciadoCorto"
  | "identifyQuestions.invalid.faltanOpciones"
  | "identifyQuestions.invalid.faltanCorrectas"
  | "identifyQuestions.invalid.faltaEsquema"
  | "identifyQuestions.invalid.faltaLenguaje"
  | "identifyQuestions.invalid.puntos"
  | "identifyQuestions.invalid.selecciones";

export type ResultadoValidacion = { ok: true } | { ok: false; motivo: MotivoInvalido };

/** Enunciado mínimo aceptable. Menos que esto es artefacto de segmentación. */
export const MIN_ENUNCIADO_CHARS = 10;

/** `true` si el destino acepta ese tipo. */
export function tipoAceptado(destino: DestinoIdentificacion, tipo: string): boolean {
  return (TIPOS_ACEPTADOS_POR_DESTINO[destino] as readonly string[]).includes(tipo);
}

/**
 * Tipos para los que el formulario manual de EXAMEN aborta si falta la rúbrica
 * ([app.teacher.exams.$examId.tsx](../../routes/app.teacher.exams.$examId.tsx),
 * `submitQuestion`). Es exactamente ese set y no «todo lo que califica la IA»
 * para no inventar una segunda regla que se contradiga con la primera: `bd_sql`
 * queda afuera porque el formulario lo deja pasar y porque ya tiene su propio
 * campo obligatorio (`setupSql`, que `validarBorrador` sí exige).
 *
 * Este paso entra por la ventana a la MISMA tabla que ese formulario, así que
 * sin esto una `abierta` con rúbrica vacía llega al grader de IA con la sección
 * «RÚBRICA ESPERADA:» en blanco y el modelo improvisa los criterios. Río abajo
 * es invisible: `grade-submission.ts` manda `rubric: expected_rubric ?? ""`.
 *
 * NO es motivo de rechazo (ver `validarBorrador`): un docente puede querer una
 * abierta para calificar a mano. Solo empuja la fila al filtro «Solo las que
 * requieren tu revisión» y le pone el asterisco al campo.
 */
const TIPOS_CON_RUBRICA_OBLIGATORIA: readonly string[] = [
  "abierta",
  "codigo",
  "diagrama",
  "java_gui",
  "python_gui",
];

/** `true` si el tipo espera rúbrica y la fila no la tiene. */
export function rubricaFaltante(fila: BorradorPregunta): boolean {
  return (
    TIPOS_CON_RUBRICA_OBLIGATORIA.includes(fila.tipo) &&
    String(fila.rubrica ?? "").trim().length === 0
  );
}

/** Opciones no vacías de la fila, ya recortadas. */
/**
 * Opciones sin las vacias Y la traduccion de indices que ese filtro obliga.
 *
 * Filtrar los textos vacios y copiar los indices tal cual CORRE LA CLAVE DE
 * RESPUESTA. Reproducido con el codigo real: opciones [IaaS, PaaS, SaaS, FaaS]
 * con la correcta en PaaS; el docente borra el TEXTO de "IaaS" (el gesto obvio:
 * hay un Input por opcion) y lo que se insertaba era
 * {choices:[PaaS,SaaS,FaaS], correct_index:1} — o sea SaaS. Un examen
 * calificado con la respuesta equivocada y sin ningun aviso.
 *
 * Por eso el filtro y el remapeo viven juntos y en un solo lugar: quien use uno
 * sin el otro reintroduce el bug.
 */
function opcionesConIndices(fila: BorradorPregunta): {
  choices: string[];
  /** indice original -> indice despues del filtro. Si no esta, esa opcion se fue. */
  mapa: Map<number, number>;
} {
  const pares: { texto: string; original: number }[] = [];
  (fila.opciones ?? []).forEach((o, original) => {
    const texto = String(o ?? "").trim();
    if (texto.length > 0) pares.push({ texto, original });
  });
  const mapa = new Map<number, number>();
  pares.forEach((par, nuevo) => mapa.set(par.original, nuevo));
  return { choices: pares.map((par) => par.texto), mapa };
}

function opcionesLimpias(fila: BorradorPregunta): string[] {
  return opcionesConIndices(fila).choices;
}

/** `correctas` traducidas al indice nuevo, sin duplicados y ordenadas. */
function correctasRemapeadas(fila: BorradorPregunta, mapa: Map<number, number>): number[] {
  const vistas = new Set<number>();
  for (const i of fila.correctas ?? []) {
    if (!Number.isInteger(i)) continue;
    const nuevo = mapa.get(i);
    if (nuevo === undefined) continue;
    vistas.add(nuevo);
  }
  return [...vistas].sort((a, b) => a - b);
}

/**
 * Valida una fila del borrador ANTES de insertarla.
 *
 * Es lo que evita el peor modo de falla del producto: una `cerrada` sin
 * `options` no se pinta como opciones, cae al textarea genérico y el scoring
 * determinista la puntúa 0 SIEMPRE — sin error, sin constraint, en el momento
 * de la entrega. Igual un `bd_sql` sin `setupSql`: la base PGlite arranca
 * vacía y el ejercicio es inútil.
 */
export function validarBorrador(
  destino: DestinoIdentificacion,
  fila: BorradorPregunta,
): ResultadoValidacion {
  if (!tipoAceptado(destino, fila.tipo)) {
    return { ok: false, motivo: "identifyQuestions.invalid.tipoNoAceptado" };
  }
  if (String(fila.enunciado ?? "").trim().length < MIN_ENUNCIADO_CHARS) {
    return { ok: false, motivo: "identifyQuestions.invalid.enunciadoCorto" };
  }
  if (!Number.isInteger(fila.puntos) || fila.puntos < 1 || fila.puntos > 100) {
    return { ok: false, motivo: "identifyQuestions.invalid.puntos" };
  }

  if (fila.tipo === "cerrada") {
    const { choices, mapa } = opcionesConIndices(fila);
    if (choices.length < 2 || choices.length > 6) {
      return { ok: false, motivo: "identifyQuestions.invalid.faltanOpciones" };
    }
    // Se valida contra el MAPA y no contra la longitud: si la opcion marcada es
    // justo la que quedo en blanco, no hay respuesta correcta que insertar.
    if (
      fila.correcta == null ||
      !Number.isInteger(fila.correcta) ||
      !mapa.has(fila.correcta)
    ) {
      return { ok: false, motivo: "identifyQuestions.invalid.faltanOpciones" };
    }
  }

  if (fila.tipo === "cerrada_multi") {
    const { choices, mapa } = opcionesConIndices(fila);
    if (choices.length < 3 || choices.length > 8) {
      return { ok: false, motivo: "identifyQuestions.invalid.faltanOpciones" };
    }
    const correctas = correctasRemapeadas(fila, mapa);
    if (correctas.length < 1 || correctas.length >= choices.length) {
      return { ok: false, motivo: "identifyQuestions.invalid.faltanCorrectas" };
    }
    // Espejo de la regla de `cerrada`: si el docente blanqueó el TEXTO de una
    // opción que estaba marcada, la fila se rechaza. Sin esto había una
    // asimetría silenciosa frente al mismo gesto — `correctasRemapeadas`
    // descartaba el índice huérfano y la fila quedaba válida con la clave
    // RECORTADA (la IA propuso dos correctas y se guardaba una). No es un
    // índice que apunte al texto equivocado, pero con el scoring proporcional
    // (matched / totalCorrect) cambia la nota de todo el curso y nada avisa.
    const marcadasEnBlanco = (fila.correctas ?? []).some(
      (i) => Number.isInteger(i) && i >= 0 && i < (fila.opciones ?? []).length && !mapa.has(i),
    );
    if (marcadasEnBlanco) {
      return { ok: false, motivo: "identifyQuestions.invalid.faltanCorrectas" };
    }
    // Coherencia de min/max. Sin esto se podia insertar min=5 y max=1 sobre 3
    // opciones: la calificacion deterministica (belowMin / exceededMax del
    // taller) le da CERO a todo el mundo, marque lo que marque. El edge ya
    // aplica esta regla a lo que devuelve el modelo; faltaba para lo que edita
    // el docente.
    const min = fila.minSelecciones;
    const max = fila.maxSelecciones;
    const hayMin = typeof min === "number";
    const hayMax = typeof max === "number";
    if (hayMin || hayMax) {
      const piso = hayMin ? min : 1;
      const techo = hayMax ? max : choices.length;
      if (
        !Number.isInteger(piso) ||
        !Number.isInteger(techo) ||
        piso < 1 ||
        techo > choices.length ||
        piso > techo ||
        // `piso <= correctas.length` no es redundante con lo de arriba: sin él
        // entra un mínimo POR ENCIMA de la cantidad de correctas, y con el
        // scoring proporcional sin penalización el incentivo se invierte —
        // quien marca solo la correcta queda en 0 por no llegar al mínimo, y
        // quien rellena con incorrectas se lleva el 100%. No es una clave
        // equivocada: es una pregunta que premia adivinar.
        piso > correctas.length
      ) {
        return { ok: false, motivo: "identifyQuestions.invalid.selecciones" };
      }
    }
  }

  if (fila.tipo === "bd_sql") {
    const sql = String(fila.setupSql ?? "").trim();
    if (!sql || !/create\s+table/i.test(sql)) {
      return { ok: false, motivo: "identifyQuestions.invalid.faltaEsquema" };
    }
  }

  if (fila.tipo === "codigo") {
    if (!["java", "python", "javascript"].includes(fila.lenguaje)) {
      return { ok: false, motivo: "identifyQuestions.invalid.faltaLenguaje" };
    }
  }

  return { ok: true };
}

/**
 * `options` con la forma EXACTA de la columna, reproduciendo el builder del
 * formulario manual de examen — con una diferencia deliberada: acá las
 * opciones vacías se filtran siempre (el examen no lo hacía y el taller sí).
 */
export function optionsDeFila(fila: BorradorPregunta): Record<string, unknown> | null {
  if (fila.tipo === "cerrada") {
    const { choices, mapa } = opcionesConIndices(fila);
    // El indice viaja por el mapa. Si NO esta —la marcada era la que quedo en
    // blanco— se devuelve null en vez de rellenar con 0: el `?? 0` que habia
    // INVENTABA una respuesta correcta (la primera opcion) en vez de fallar.
    // Hoy es inalcanzable porque `construirFilaPregunta` valida primero, pero
    // la funcion es exportada y su firma no obliga a validar antes: el proximo
    // call site que la use sin validar insertaria la opcion 0 como correcta sin
    // ningun sintoma.
    const nuevo = fila.correcta == null ? undefined : mapa.get(fila.correcta);
    if (nuevo === undefined) return null;
    return { choices, correct_index: nuevo };
  }
  if (fila.tipo === "cerrada_multi") {
    const { choices, mapa } = opcionesConIndices(fila);
    const correctas = correctasRemapeadas(fila, mapa);
    return {
      choices,
      correct_indices: correctas,
      ...(typeof fila.minSelecciones === "number" ? { min_selections: fila.minSelecciones } : {}),
      ...(typeof fila.maxSelecciones === "number" ? { max_selections: fila.maxSelecciones } : {}),
    };
  }
  if (fila.tipo === "java_gui") {
    return { java_framework: fila.javaFramework };
  }
  if (fila.tipo === "bd_sql") {
    return { db: { setupSql: String(fila.setupSql ?? "").trim() } };
  }
  return null;
}

/** `language` implícito por tipo. Los tipos sin código van en `null`. */
export function languageDeFila(fila: BorradorPregunta): string | null {
  if (fila.tipo === "codigo") return fila.lenguaje;
  if (fila.tipo === "java_gui") return "java";
  if (fila.tipo === "python_gui") return "python";
  return null;
}

/**
 * Plantilla inicial del editor. Sale de `src/modules/code/starters.ts`, que es
 * la fuente única — el edge NO devuelve `starter_code` a propósito (el que
 * tiene hardcodeado inline es el anti-precedente).
 */
export function starterDeFila(fila: BorradorPregunta): string | null {
  if (fila.tipo === "java_gui") {
    return fila.javaFramework === "javafx" ? JAVAFX_STARTER : JAVA_GUI_STARTER;
  }
  if (fila.tipo === "python_gui") return PYTHON_GUI_STARTER;
  if (fila.tipo === "codigo") return getStarterCode(fila.lenguaje) || null;
  return null;
}

/** Tabla destino de cada superficie. */
export const TABLA_POR_DESTINO: Record<DestinoIdentificacion, string> = {
  exam: "questions",
  workshop: "workshop_questions",
  project: "project_files",
  bank: "question_bank",
};

export interface ExtrasInsercion {
  /** examId | workshopId | projectId | courseId, según el destino. */
  targetId: string;
  /** Solo lo usa `bank` (`question_bank.created_by`). */
  createdBy?: string | null;
}

/**
 * Arma la fila lista para el `.insert(...)` del destino.
 *
 * Ojo con `project`: el enunciado va a `title` porque `project_files` no tiene
 * una columna `content` que alguien LEA (los 6 call sites leen `q.title`), y
 * NO se trunca a 200 caracteres. El formulario manual sí trunca; el RPC de
 * importación del banco no. Cortar el texto del docente en silencio es peor
 * que guardarlo entero, así que acá se guarda entero.
 */
export function construirFilaPregunta(
  destino: DestinoIdentificacion,
  fila: BorradorPregunta,
  posicion: number,
  extras: ExtrasInsercion,
): Record<string, unknown> {
  // La precondicion se HACE CUMPLIR, no se documenta: `optionsDeFila` y
  // `starterDeFila` asumen una fila ya validada, y el unico call site actual
  // (el dialogo) filtra por `validarBorrador` antes de llamar. Sin este guard
  // no existe nada que impida que un call site futuro —una importacion masiva,
  // un reintento, un test usandola de fixture— inserte una `cerrada` sin
  // respuesta correcta o un `bd_sql` con la base vacia.
  const validacion = validarBorrador(destino, fila);
  if (!validacion.ok) {
    throw new Error(
      `No se puede construir la pregunta: la fila no pasa la validación (${validacion.motivo}).`,
    );
  }

  const enunciado = String(fila.enunciado ?? "").trim();
  const rubrica = String(fila.rubrica ?? "").trim() || null;
  const options = optionsDeFila(fila);
  const language = languageDeFila(fila);
  const starter = starterDeFila(fila);

  if (destino === "exam") {
    return {
      exam_id: extras.targetId,
      type: fila.tipo,
      content: enunciado,
      expected_rubric: rubrica,
      options,
      points: fila.puntos,
      position: posicion,
      language,
      starter_code: starter,
    };
  }
  if (destino === "workshop") {
    return {
      workshop_id: extras.targetId,
      type: fila.tipo,
      content: enunciado,
      expected_rubric: rubrica,
      options,
      points: fila.puntos,
      position: posicion,
      language,
      zip_single: false,
      starter_code: starter,
    };
  }
  if (destino === "project") {
    return {
      project_id: extras.targetId,
      type: fila.tipo,
      title: enunciado,
      description: null,
      expected_rubric: rubrica,
      options,
      points: fila.puntos,
      position: posicion,
      language,
      // Los proyectos no son un IDE inline: el ZIP trae los archivos del
      // estudiante sin plantilla del docente.
      starter_code: null,
      zip_single: false,
    };
  }
  return {
    course_id: extras.targetId,
    type: fila.tipo,
    content: enunciado,
    options,
    expected_rubric: rubrica,
    language,
    starter_code: starter,
    suggested_points: fila.puntos,
    topic: null,
    difficulty: null,
    tags: [],
    shared_org: false,
    ...(extras.createdBy ? { created_by: extras.createdBy } : {}),
  };
}
