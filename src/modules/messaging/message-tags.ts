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
 * Descriptor de navegación TanStack para un tag: `to` + `params`/`search`.
 * NO devolvemos un string interpolado — TanStack exige `params`/`search`
 * separados o el enlace no matchea la ruta (ver CLAUDE.md, regla de
 * navegación). El consumidor lo esparce en `<Link {...} />`.
 */
export type TagNav = {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
};

/**
 * Enlace a un ÍTEM específico según su tipo y el rol del receptor.
 * Estudiantes y docentes ven vistas distintas — calculamos via `role`.
 * El id SIEMPRE viaja: por ruta de detalle (`$id`) cuando existe, o por
 * query-param que la grilla destino resalta (patrón `?poll=<id>` de encuestas).
 * Si el receptor no tiene acceso al módulo (RBAC), el guardia de ruta redirige;
 * no hacemos RBAC client-side.
 */
export function tagRoute(tag: ContentTag, role: "student" | "teacher"): TagNav {
  switch (tag.type) {
    case "workshop":
      return role === "teacher"
        ? { to: "/app/teacher/workshops", search: { workshop: tag.id } }
        : { to: "/app/student/workshop/$workshopId", params: { workshopId: tag.id } };
    case "exam":
      return role === "teacher"
        ? { to: "/app/teacher/exams/$examId", params: { examId: tag.id } }
        : { to: "/app/student/exams", search: { exam: tag.id } };
    case "project":
      return role === "teacher"
        ? { to: "/app/teacher/projects", search: { project: tag.id } }
        : { to: "/app/student/project/$projectId", params: { projectId: tag.id } };
    case "content":
      // No hay ruta de contenidos para el estudiante (el contenido vive dentro
      // del tablero del curso); el docente tiene su grilla `/app/teacher/contents`.
      return role === "teacher"
        ? { to: "/app/teacher/contents", search: { content: tag.id } }
        : { to: "/app/student/courses", search: { content: tag.id } };
    case "video":
      // Biblioteca de videos: ruta compartida (sin prefijo de rol).
      return { to: "/app/videos", search: { video: tag.id } };
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

export type MessageSegment = { kind: "text"; text: string } | { kind: "tag"; tag: ContentTag };

/**
 * Detecta una "mención" activa de tag en el composer: un `#` seguido de
 * texto SIN espacios, con el caret justo después. Es el trigger del
 * autocomplete inline (estilo Slack/Discord) para etiquetar contenido
 * escribiendo `#`.
 *
 * Reglas:
 *   - El `#` debe estar al inicio del texto o precedido por whitespace.
 *     Así "C#" o "x#y" NO disparan (el `#` está pegado a una palabra),
 *     pero "mira #parc" sí.
 *   - Si entre el `#` y el caret hay un espacio, no hay mención activa
 *     (el usuario ya cerró el token — ej. nombres como "Taller #1" que
 *     siguen con espacio quedan como literal si no se selecciona nada).
 *
 * Devuelve `{ query, start }` donde `start` es el índice del `#`, o null
 * si no hay mención activa en esa posición de caret.
 */
export function findActiveTagQuery(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "#") {
      const prev = i > 0 ? text[i - 1] : " ";
      if (i === 0 || /\s/.test(prev)) {
        return { query: text.slice(i + 1, caret), start: i };
      }
      return null;
    }
    // Cualquier whitespace entre el caret y un posible '#' cierra la mención.
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

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
