/**
 * Estado de las FIRMAS de un informe generado: cuántas hay puestas, cuántas
 * faltan, y a quién no se le pidió todavía.
 *
 * ── Por qué es un módulo puro y no un cálculo dentro del JSX ───────────
 * El MISMO número se muestra en dos lugares — la celda «Firmas» del historial de
 * `/app/teacher/reports` y la cabecera del diálogo de estado — y dos cuentas
 * escritas por separado divergen: la celda diría 18/33 y el diálogo 18/18. Acá
 * viven las dos, así que no pueden discrepar.
 *
 * ── El denominador lo dice el DOCUMENTO, no la matrícula ───────────────
 * `uidsDeRanuras(html)` es la única fuente que ya resolvió los dos casos que la
 * matrícula responde mal (estudiantes que el docente EXCLUYÓ del informe, y el
 * docente que firma sin estar matriculado). Está explicado en
 * `signature-slots.ts`; acá solo se consume.
 *
 * Cuando el documento no ancla ninguna ranura se cae a las solicitudes
 * existentes: es el caso de los informes de antes de que las ranuras existieran,
 * donde igual hay firmas que contar.
 *
 * ── Nunca «0 de 0» ────────────────────────────────────────────────────
 * La lista de firmas del historial llega por un embed de PostgREST, y ese embed
 * vuelve VACÍO SIN ERROR cuando la policy de `report_signatures` no deja ver las
 * filas (su `INNER JOIN courses` es más estricto que la rama
 * `created_by = auth.uid()` por la que el informe sí aparece en la lista). Lo
 * mismo hace `report_signatures_of`, que devuelve un arreglo vacío cuando su
 * propio gate falla. O sea: «no vino nada» y «no hay nada» se ven idénticos.
 *
 * Por eso `resumirFirmas` nunca devuelve `total === 0` con una clase distinta de
 * `sin-ranuras`: con el denominador en cero se cae a lo que dice el HTML, que es
 * local y no depende de ninguna policy. Pintar «0 firmadas» sobre un documento
 * que tiene 33 firmas es peor que no mostrar nada.
 */

import { dibujoValido, tieneRanuras, uidsDeRanuras } from "./signature-slots";

/**
 * En qué situación está el informe.
 *
 *   sin-ranuras → el documento no tiene casillas de firma (se imprime y se firma
 *                 a mano). También es la salida defensiva cuando el denominador
 *                 no se pudo establecer.
 *   sin-pedir   → tiene casillas y todavía no se le pidió la firma a nadie.
 *   parcial     → falta al menos una.
 *   completo    → están todas.
 */
export type ClaseResumen = "sin-ranuras" | "sin-pedir" | "parcial" | "completo";

export interface ResumenFirmas {
  clase: ClaseResumen;
  firmadas: number;
  /** Denominador VISIBLE. Ranuras del documento; si no hay, las solicitudes. */
  total: number;
  /** Ranuras ancladas sin ninguna solicitud: a esas personas no se les pidió. */
  sinSolicitar: number;
}

/** Solo lo que hace falta para contar. Es lo que el embed del historial trae. */
type FilaConteo = { signed_at: string | null };

/**
 * El resumen que alimenta la celda del grid y la cabecera del diálogo.
 *
 * `filas` puede venir `null`/`undefined`: es lo que devuelve el embed cuando la
 * consulta no lo pidió o la policy no dejó ver nada. Se trata igual que vacío,
 * y el guard de arriba evita que eso se lea como «nadie firmó».
 */
export function resumirFirmas(
  filas: ReadonlyArray<FilaConteo> | null | undefined,
  html: string | null | undefined,
): ResumenFirmas {
  const solicitudes = filas ?? [];
  const solicitadas = solicitudes.length;
  const firmadas = solicitudes.reduce((n, f) => n + (f.signed_at ? 1 : 0), 0);
  const anclados = uidsDeRanuras(html).length;
  const total = anclados > 0 ? anclados : solicitadas;
  const sinSolicitar = anclados > 0 ? Math.max(0, anclados - solicitadas) : 0;

  let clase: ClaseResumen;
  if (total === 0 || (!tieneRanuras(html) && solicitadas === 0)) {
    // Sin denominador no hay nada que afirmar. Incluye el caso de un documento
    // cuyas ranuras existen pero ninguna quedó anclada (renglones para firmar a
    // mano): no hay a quién pedírsela.
    clase = "sin-ranuras";
  } else if (solicitadas === 0) {
    clase = "sin-pedir";
  } else if (firmadas >= total) {
    clase = "completo";
  } else {
    clase = "parcial";
  }

  return { clase, firmadas, total, sinSolicitar };
}

/**
 * Estado de UNA persona.
 *
 * `sin_solicitar` es el tercer estado, y es el que hace que esto sirva: hoy no
 * aparece en ninguna pantalla. Un documento con 33 casillas y 30 solicitudes se
 * ve «completo» al firmar las 30, y las 3 personas a las que nunca se les pidió
 * no salen en ningún lado.
 */
export type EstadoFila = "firmada" | "pendiente" | "sin_solicitar";

export interface FilaFirmante {
  userId: string;
  nombre: string;
  email: string | null;
  esDocente: boolean;
  /**
   * El documento ancla su ranura. Si es `false` la fila NO es puerta al
   * documento: no hay renglón al que llevar la vista.
   */
  anclada: boolean;
  estado: EstadoFila;
  /** `report_signatures.id`. Alimenta el código de verificación. */
  firmaId: string | null;
  signedAt: string | null;
  requestedAt: string | null;
  /** Cómo firmó. `null` mientras no haya firmado. */
  via: "app" | "link" | null;
  conDibujo: boolean;
}

interface SolicitudCruda {
  user_id: string;
  signed_at: string | null;
  requested_at: string | null;
  signed_via: string | null;
  signed_hash: string | null;
}

interface FirmaCruda {
  id: string;
  user_id: string;
  nombre?: string | null;
  signed_at?: string | null;
  dibujo?: string | null;
}

interface PerfilCrudo {
  id: string;
  full_name: string | null;
  institutional_email: string | null;
}

const ORDEN_ESTADO: Record<EstadoFila, number> = {
  sin_solicitar: 0,
  pendiente: 1,
  firmada: 2,
};

/**
 * Arma y ORDENA la lista del diálogo.
 *
 * ── Por qué se puede ordenar por estado, y en el otro diálogo no ───────
 * `SendToSignDialog` ordena por nombre porque sus filas tienen casillas: si una
 * fila salta de lugar al firmar alguien, el clic siguiente cae sobre otra
 * persona. Esta lista es de SOLO LECTURA, así que se puede poner adelante lo que
 * el docente vino a buscar: primero a quién no se le pidió, después quién falta,
 * y al final quién ya firmó (lo más reciente arriba).
 *
 * ── Nunca omite una fila ──────────────────────────────────────────────
 * Un ancla sin perfil (alguien que salió del curso) entra igual con el nombre en
 * `—`. Un pendiente invisible es justo el que falta, y esconderlo hace que la
 * pantalla mienta por omisión.
 */
export function filasDeFirmantes(e: {
  anclados: readonly string[];
  solicitudes: ReadonlyArray<SolicitudCruda>;
  firmadas: ReadonlyArray<FirmaCruda>;
  perfiles: ReadonlyArray<PerfilCrudo>;
  idsDocentes: ReadonlySet<string>;
}): FilaFirmante[] {
  const anclados = new Set(e.anclados);
  const porSolicitud = new Map<string, SolicitudCruda>();
  for (const s of e.solicitudes) porSolicitud.set(s.user_id, s);
  const porFirma = new Map<string, FirmaCruda>();
  for (const f of e.firmadas) porFirma.set(f.user_id, f);
  const porPerfil = new Map<string, PerfilCrudo>();
  for (const p of e.perfiles) porPerfil.set(p.id, p);

  // El universo es la unión: las ranuras del documento (incluidas las que nadie
  // pidió) más todo lo que ya se pidió (incluido lo que el documento no ancla,
  // que se pidió alguna vez y no se puede esconder).
  const ids: string[] = [];
  const vistos = new Set<string>();
  for (const id of [...e.anclados, ...porSolicitud.keys(), ...porFirma.keys()]) {
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
  }

  const filas = ids.map<FilaFirmante>((userId) => {
    const sol = porSolicitud.get(userId);
    const firma = porFirma.get(userId);
    const perfil = porPerfil.get(userId);
    const firmoYa = !!(sol?.signed_at ?? firma?.signed_at);
    const estado: EstadoFila = firmoYa ? "firmada" : sol ? "pendiente" : "sin_solicitar";
    const via = sol?.signed_via;
    return {
      userId,
      nombre:
        firma?.nombre?.trim() ||
        perfil?.full_name?.trim() ||
        perfil?.institutional_email?.trim() ||
        "—",
      email: perfil?.institutional_email ?? null,
      esDocente: e.idsDocentes.has(userId),
      anclada: anclados.has(userId),
      estado,
      firmaId: firma?.id ?? null,
      signedAt: sol?.signed_at ?? firma?.signed_at ?? null,
      requestedAt: sol?.requested_at ?? null,
      via: via === "app" || via === "link" ? via : null,
      conDibujo: dibujoValido(firma?.dibujo),
    };
  });

  return filas.sort(
    (a, b) =>
      ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado] ||
      // Dentro de las firmadas, la más reciente primero.
      (a.estado === "firmada" ? (b.signedAt ?? "").localeCompare(a.signedAt ?? "") : 0) ||
      Number(b.esDocente) - Number(a.esDocente) ||
      a.nombre.localeCompare(b.nombre, "es-CO"),
  );
}

/**
 * Si TODAS las solicitudes comparten `requested_at`, fue un envío en lote y la
 * fecha se dice UNA vez arriba en vez de repetirla en 33 filas.
 *
 * Cualquier diferencia (o un `requested_at` sin valor) devuelve `null`: ahí las
 * fechas son información real por fila y hay que mostrarlas donde están.
 */
export function loteDeSolicitud(
  solicitudes: ReadonlyArray<{ requested_at: string | null }>,
): string | null {
  if (solicitudes.length === 0) return null;
  const primero = solicitudes[0].requested_at;
  if (!primero) return null;
  return solicitudes.every((s) => s.requested_at === primero) ? primero : null;
}

/**
 * ¿Hay firmas puestas sobre versiones DISTINTAS del documento?
 *
 * `signed_hash` se calcula sobre el snapshot al momento de firmar. Dos hashes
 * distintos entre las firmadas significan que el documento cambió en el medio, y
 * eso es exactamente lo que el docente tiene que ver antes de dar el documento
 * por cerrado.
 *
 * Solo cuentan las FIRMADAS: una solicitud pendiente no tiene hash de nada, y
 * mirar su columna daría un falso positivo.
 */
export function hashDivergente(
  solicitudes: ReadonlyArray<{ signed_at: string | null; signed_hash: string | null }>,
): boolean {
  const hashes = new Set<string>();
  for (const s of solicitudes) {
    if (!s.signed_at || !s.signed_hash) continue;
    hashes.add(s.signed_hash);
  }
  return hashes.size > 1;
}
