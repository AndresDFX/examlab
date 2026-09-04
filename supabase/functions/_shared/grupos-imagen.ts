/**
 * Contrato de la herramienta con la que el modelo devuelve lo que leyó en la captura,
 * y la normalización de esa salida.
 *
 * Vive en `_shared` y no dentro del edge porque el cliente lo IMPORTA en su test
 * (`plan-grupos-imagen.test.ts` / `ai-vision.test.ts` usan el mismo mecanismo): así
 * los topes que el cliente muestra y los que el servidor aplica son el mismo número.
 * Duplicarlos es la forma de que el diálogo diga "hasta 60" mientras el servidor
 * recorta en 40.
 */

export const TOOL_NAME = "leer_grupos";

/** Topes de la lectura. Una grilla de videollamada real no pasa de esto. */
export const MAX_GRUPOS = 12;
export const MAX_PARTICIPANTES = 60;

/** Largo máximo de un nombre leído: más que esto es una frase, no un nombre. */
const MAX_LARGO_NOMBRE = 80;
/** Largo máximo de una etiqueta de grupo ("Sala 1", "Equipo A"). */
const MAX_LARGO_ETIQUETA = 40;

export interface ParticipanteLeido {
  nombre: string;
  confianza: "alta" | "media" | "baja";
}

export interface GrupoLeido {
  etiqueta: string;
  participantes: ParticipanteLeido[];
}

export interface Lectura {
  grupos: GrupoLeido[];
  /** Personas visibles a las que no se les pudo atribuir un grupo. */
  sin_grupo: ParticipanteLeido[];
  /** Cuántos recuadros se vieron pero no se pudieron leer. */
  ilegibles: number;
  /** `true` si se recortó por los topes: el diálogo lo tiene que decir. */
  truncado: boolean;
}

/**
 * El esquema de la herramienta. Se usa con `tool_choice` forzado, que es lo que hace
 * que la salida sea estructurada y no prosa que después haya que parsear.
 *
 * `confianza` la reporta el MODELO, no se infiere acá: un nombre tapado por el ícono
 * del micrófono es el caso que el docente tiene que revisar primero, y solo quien vio
 * los píxeles puede decirlo.
 */
export function buildLeerGruposTool() {
  const participante = {
    type: "object",
    properties: {
      nombre: {
        type: "string",
        description:
          "El nombre tal como aparece en el recuadro, sin agregar ni corregir nada. Si dice 'Juan P.', poner 'Juan P.'.",
      },
      confianza: {
        type: "string",
        enum: ["alta", "media", "baja"],
        description:
          "alta = el nombre se lee completo y sin dudas; media = se lee pero está abreviado o parcialmente tapado; baja = se adivina.",
      },
    },
    required: ["nombre", "confianza"],
    additionalProperties: false,
  };

  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description:
        "Devuelve los grupos y los participantes que se ven en la captura de la videollamada.",
      parameters: {
        type: "object",
        properties: {
          grupos: {
            type: "array",
            description:
              "Un elemento por grupo/sala visible. Si la imagen no muestra separación en grupos, devolver este arreglo vacío y poner a todos en sin_grupo.",
            items: {
              type: "object",
              properties: {
                etiqueta: {
                  type: "string",
                  description:
                    "El rótulo del grupo tal como aparece ('Sala 1', 'Equipo A', 'Grupo 3'). Si no hay rótulo, usar 'Grupo N' según el orden de aparición.",
                },
                participantes: { type: "array", items: participante },
              },
              required: ["etiqueta", "participantes"],
              additionalProperties: false,
            },
          },
          sin_grupo: {
            type: "array",
            description: "Participantes visibles que no pertenecen a ningún grupo identificable.",
            items: participante,
          },
          ilegibles: {
            type: "integer",
            description:
              "Cuántos recuadros de participante se ven pero con el nombre ilegible. 0 si todos se leyeron.",
          },
        },
        required: ["grupos", "sin_grupo", "ilegibles"],
        additionalProperties: false,
      },
    },
  };
}

const texto = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const confianza = (v: unknown): "alta" | "media" | "baja" =>
  v === "alta" || v === "baja" ? v : "media";

/**
 * Limpia lo que devolvió el modelo.
 *
 * Descarta nombres de menos de 2 caracteres (ruido de segmentación), deduplica dentro
 * del MISMO grupo —el mismo recuadro leído dos veces— y aplica los topes. La dedup no
 * cruza grupos a propósito: un nombre en dos salas es información que el docente
 * necesita ver, no un duplicado que haya que resolver acá.
 */
export function normalizarLectura(args: unknown): Lectura {
  const a = (args ?? {}) as Record<string, unknown>;
  let truncado = false;

  const limpiarParticipantes = (v: unknown, vistos: Set<string>): ParticipanteLeido[] => {
    if (!Array.isArray(v)) return [];
    const salida: ParticipanteLeido[] = [];
    for (const p of v) {
      const o = (p ?? {}) as Record<string, unknown>;
      const nombre = texto(o.nombre, MAX_LARGO_NOMBRE);
      if (nombre.length < 2) continue;
      const k = nombre.toLowerCase();
      if (vistos.has(k)) continue;
      vistos.add(k);
      salida.push({ nombre, confianza: confianza(o.confianza) });
    }
    return salida;
  };

  const grupos: GrupoLeido[] = [];
  if (Array.isArray(a.grupos)) {
    for (const g of a.grupos) {
      if (grupos.length >= MAX_GRUPOS) {
        truncado = true;
        break;
      }
      const o = (g ?? {}) as Record<string, unknown>;
      const participantes = limpiarParticipantes(o.participantes, new Set());
      // Un grupo sin nadie legible no aporta: crearlo vacío ensucia la revisión.
      if (!participantes.length) continue;
      grupos.push({
        etiqueta: texto(o.etiqueta, MAX_LARGO_ETIQUETA) || `Grupo ${grupos.length + 1}`,
        participantes,
      });
    }
  }

  const sin_grupo = limpiarParticipantes(a.sin_grupo, new Set());

  // Tope global de personas, aplicado sobre el total.
  let total = 0;
  for (const g of grupos) {
    if (total + g.participantes.length > MAX_PARTICIPANTES) {
      g.participantes = g.participantes.slice(0, Math.max(0, MAX_PARTICIPANTES - total));
      truncado = true;
    }
    total += g.participantes.length;
  }
  const gruposConGente = grupos.filter((g) => g.participantes.length > 0);
  const espacio = Math.max(0, MAX_PARTICIPANTES - total);
  if (sin_grupo.length > espacio) truncado = true;

  const ilegibles = Number.isFinite(a.ilegibles) ? Math.max(0, Math.trunc(a.ilegibles as number)) : 0;

  return { grupos: gruposConGente, sin_grupo: sin_grupo.slice(0, espacio), ilegibles, truncado };
}
