/**
 * message-tags — formato de tags embebidos en el body de un mensaje.
 *
 * Por qué embebido en el texto en lugar de tabla aparte:
 *   - 0 cambios de schema (no migración). El tag viaja con el body de
 *     `messages.body`, junto al texto que el usuario escribió alrededor.
 *   - Backward compatible: clientes viejos ven el tag como literal
 *     `[[T:exam:abc:Parcial 1]]` — feo pero no rompe. Clientes nuevos
 *     parsean y rinden como Link.
 *   - Búsqueda full-text: el label del tag está en el body, así que
 *     filtros tipo "buscar mensajes que mencionan Parcial 1" funcionan.
 *
 * Formato: `[[T:<type>:<id>:<label>]]`
 *   - type ∈ TagType (workshop / exam / project / content / video)
 *   - id = UUID estricto (a-f0-9 + guiones)
 *   - label = lo que ve el usuario; no puede contener `]` (regex lo
 *     descarta). Si el nombre original tiene `]`, lo reemplazamos por
 *     `)` antes de empaquetar.
 *
 * Decisión: las rutas de cada tipo apuntan al LISTADO del módulo
 * correspondiente (no al detalle por id), porque las rutas del estudiante
 * no siempre tienen detail-by-id estable. Si la ruta cambia en el futuro,
 * solo este archivo se actualiza.
 */
export type TagType = "workshop" | "exam" | "project" | "content" | "video";

export interface ContentTag {
  type: TagType;
  id: string;
  label: string;
}

/** Etiqueta humana del tipo (es-CO). Usada en chips, picker, tooltips. */
export const TAG_TYPE_LABEL: Record<TagType, string> = {
  workshop: "Taller",
  exam: "Examen",
  project: "Proyecto",
  content: "Contenido",
  video: "Video",
};

/**
 * Rutas relativas para cada tipo. Estudiantes y docentes ven listas
 * distintas — calculamos via `role`. Si el receptor no tiene acceso al
 * módulo (RBAC), el Link mostrará "Sin acceso" al click. No hacemos
 * RBAC client-side para evitar mostrar links rotos: simplemente
 * navegamos y el guardia de ruta hace el rest.
 */
export function tagRoute(tag: ContentTag, role: "student" | "teacher"): string {
  const base = role === "teacher" ? "/app/teacher" : "/app/student";
  switch (tag.type) {
    case "workshop":
      return `${base}/workshops`;
    case "exam":
      return `${base}/exams`;
    case "project":
      return `${base}/projects`;
    case "content":
      return role === "teacher" ? "/app/teacher/content" : "/app/student/content";
    case "video":
      return role === "teacher" ? "/app/teacher/videos" : "/app/student/videos";
  }
}

/** Construye el token literal listo para concatenar al body del mensaje. */
export function buildTagToken(tag: ContentTag): string {
  // El label no puede contener `]` porque la regex de parsing lo corta.
  // Reemplazamos con `)` para preservar legibilidad sin romper formato.
  const safeLabel = tag.label.replace(/\]/g, ")");
  return `[[T:${tag.type}:${tag.id}:${safeLabel}]]`;
}

/** Regex global usada por el parser. Exportada por si algún test la
 *  necesita; el caller debe usar `parseMessageBody`. */
const TAG_RE = /\[\[T:(workshop|exam|project|content|video):([0-9a-f-]+):([^\]]+)\]\]/g;

export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "tag"; tag: ContentTag };

/**
 * Parsea un body de mensaje y devuelve segmentos alternados text/tag
 * listos para renderizar. Si el body no tiene tags, devuelve un único
 * segmento `text`. Idempotente y no-throw.
 */
export function parseMessageBody(body: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(body)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: body.slice(lastIndex, match.index) });
    }
    segments.push({
      kind: "tag",
      tag: {
        type: match[1] as TagType,
        id: match[2],
        label: match[3],
      },
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) {
    segments.push({ kind: "text", text: body.slice(lastIndex) });
  }
  return segments;
}
