/**
 * Revisión de una plantilla ANTES de generar: decide sobre la FUENTE, sin
 * renderizar nada.
 *
 * ── Por qué hace falta un revisor y no alcanza la vista previa ─────────
 * El motor de plantillas TOLERA EN SILENCIO cualquier variable que no resuelve:
 * devuelve cadena vacía, no lanza y no deja rastro. Eso está bien para que un
 * typo no rompa el preview, pero convierte un error grave en algo invisible:
 *
 *   · Una ranura de firma cuyo ancla no resuelve emite `data-firma-uid=""`. Se ve
 *     EXACTAMENTE igual que un recuadro para firmar a mano —que es un estado
 *     legítimo del diseño— y no se puede firmar nunca. La previa no lo delata
 *     porque no hay nada que delatar: el HTML es válido.
 *   · Una ranura escrita con doble llave imprime el marcado como TEXTO visible
 *     (`<span class="examlab-firma" …>`) en medio del documento.
 *
 * Así que la verificación no puede ser "se ve el recuadro": tiene que ser sobre
 * el texto de la plantilla, y aparecer en la pantalla donde el docente mira el
 * resultado.
 *
 * ── PURO ──────────────────────────────────────────────────────────────
 * Devuelve CÓDIGOS, no frases: los textos se traducen en la pantalla (es↔en) y
 * este módulo se puede probar sin i18n. Los mensajes hablan de la tarea del
 * docente —"una firma que no está anclada a nadie"— y nunca de columnas,
 * atributos ni nombres de tabla.
 */

export type NivelAviso = "error" | "aviso";

export type CodigoAviso =
  /** Hay una ranura de firma que no corresponde a ninguna persona. */
  | "anclaVacia"
  /** La firma de la fila se usó fuera del listado de estudiantes. */
  | "firmaFueraDelBucle"
  /** La firma del estudiante se usó en una plantilla de curso. */
  | "ranuraSoloPorEstudiante"
  /** La ranura se escribió con doble llave: se imprimiría como texto. */
  | "ranuraEscapada"
  /** La plantilla habla de una evaluación: al generar hay que elegir cuál. */
  | "pideEvaluacion";

export interface AvisoPlantilla {
  codigo: CodigoAviso;
  nivel: NivelAviso;
  /** Cuántas veces aparece. El docente necesita saber si es una o son doce. */
  cantidad: number;
}

export interface ArgsRevision {
  bodyHtml?: string | null;
  headerHtml?: string | null;
  footerHtml?: string | null;
  scope: "estudiante" | "curso";
}

/** Paths que valen como ranura de firma de la FILA (solo dentro del listado). */
const PATHS_DE_FILA = new Set(["user_id", "ranura"]);
/** Ranura del estudiante del informe. */
const PATH_ESTUDIANTE = "firmantes.estudiante.ranura";
/**
 * TODAS las ranuras de firma. Se usa para el aviso de "escapada": cualquiera de
 * ellas escrita con DOS llaves imprime la etiqueta en letras dentro del
 * documento, y eso hay que avisarlo igual para las cuatro.
 *
 * Al agregar una ranura nueva al catálogo de variables, agregarla acá: si no, el
 * docente que la escriba mal no recibe ningún aviso y el error aparece recién en
 * el papel.
 */
const PATHS_RANURA = new Set([
  PATH_ESTUDIANTE,
  "ranura",
  "firmantes.docente.ranura",
  "firmantes.vocero.ranura",
]);

interface Uso {
  path: string;
  /** Se escribió con triple llave (`{{{…}}}`), o sea sin escapar. */
  cruda: boolean;
  /** Está dentro de un `{{#each estudiantes}}`. */
  enListado: boolean;
}

/**
 * Recorre los tokens llevando la pila de bucles abiertos, para saber si un uso
 * cae DENTRO de `{{#each estudiantes}}`. Un `{{/each}}` huérfano no rompe la
 * pila (se ignora), igual que en el motor.
 */
function usosDeVariables(src: string): { usos: Uso[]; bucles: string[] } {
  const re = /\{\{\{[\s\S]+?\}\}\}|\{\{[\s\S]+?\}\}/g;
  const usos: Uso[] = [];
  const bucles: string[] = [];
  const pila: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const tag = m[0];
    if (tag.startsWith("{{{")) {
      usos.push({
        path: tag.slice(3, -3).trim(),
        cruda: true,
        enListado: pila.includes("estudiantes"),
      });
      continue;
    }
    const inner = tag.slice(2, -2).trim();
    if (inner.startsWith("#each ")) {
      const path = inner.slice(6).trim();
      bucles.push(path);
      pila.push(path);
    } else if (inner === "/each") {
      pila.pop();
    } else if (inner.startsWith("#if ") || inner === "/if") {
      // Un condicional no cambia el scope de nombres.
    } else {
      usos.push({ path: inner, cruda: false, enListado: pila.includes("estudiantes") });
    }
  }
  return { usos, bucles };
}

/** `data-firma-uid` escrito a mano y VACÍO en el HTML de la plantilla. */
const ANCLA_VACIA = /data-firma-uid\s*=\s*"\s*"/gi;

export function revisarPlantilla(args: ArgsRevision): AvisoPlantilla[] {
  const partes = [args.bodyHtml ?? "", args.headerHtml ?? "", args.footerHtml ?? ""];
  const conteo = new Map<CodigoAviso, number>();
  const sumar = (c: CodigoAviso, n = 1) => {
    if (n > 0) conteo.set(c, (conteo.get(c) ?? 0) + n);
  };

  for (const parte of partes) {
    if (!parte) continue;
    sumar("anclaVacia", (parte.match(ANCLA_VACIA) ?? []).length);
    const { usos, bucles } = usosDeVariables(parte);
    for (const u of usos) {
      if (PATHS_DE_FILA.has(u.path) && !u.enListado) sumar("firmaFueraDelBucle");
      if (u.path === PATH_ESTUDIANTE && args.scope !== "estudiante") {
        sumar("ranuraSoloPorEstudiante");
      }
      // La ranura ES marcado: con doble llave el motor la escapa y el documento
      // muestra la etiqueta escrita en letras.
      if (PATHS_RANURA.has(u.path) && !u.cruda) {
        sumar("ranuraEscapada");
      }
      if (u.path === "evaluacion" || u.path.startsWith("evaluacion.")) sumar("pideEvaluacion");
    }
    for (const b of bucles) {
      if (b === "evaluacion" || b.startsWith("evaluacion.")) sumar("pideEvaluacion");
    }
  }

  const nivel = (c: CodigoAviso): NivelAviso => (c === "pideEvaluacion" ? "aviso" : "error");
  // Errores primero: son los que dejan un documento imposible de firmar.
  const orden: CodigoAviso[] = [
    "anclaVacia",
    "firmaFueraDelBucle",
    "ranuraSoloPorEstudiante",
    "ranuraEscapada",
    "pideEvaluacion",
  ];
  return orden
    .filter((c) => (conteo.get(c) ?? 0) > 0)
    .map((c) => ({ codigo: c, nivel: nivel(c), cantidad: conteo.get(c) as number }));
}

/** ¿La revisión encontró algo que deja el documento roto? */
export function tieneErrores(avisos: ReadonlyArray<AvisoPlantilla>): boolean {
  return avisos.some((a) => a.nivel === "error");
}

/**
 * ¿La plantilla habla de una evaluación concreta? Es lo que hace que el
 * generador pida elegir un examen, taller o proyecto.
 *
 * Olfatea el cuerpo en vez de guardar una bandera en la tabla, que es el patrón
 * ya establecido en este módulo por `tieneRanuras`: la capacidad del documento se
 * deduce de su contenido, así no hay una columna que pueda quedar en desacuerdo
 * con la plantilla que el docente acaba de editar.
 */
export function pidePlantillaEvaluacion(
  ...partes: Array<string | null | undefined>
): boolean {
  return partes.some(
    (p) => !!p && /\{\{\{?\s*(?:#(?:each|if)\s+)?evaluacion[.}\s]/.test(p),
  );
}
