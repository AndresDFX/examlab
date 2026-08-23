/**
 * Buscador global del ⌘K: busca ENTIDADES, no solo módulos.
 *
 * Antes la paleta solo ofrecía los destinos del sidebar (y una lista de
 * cursos precargada), así que escribir el nombre de un examen o de un taller no
 * encontraba nada: había que entrar al módulo y volver a buscar adentro. Acá
 * viven las consultas que resuelven "arrays" → el taller concreto.
 *
 * ── Las tres reglas que NO se pueden relajar ───────────────────────────────
 *
 * 1. **Papelera.** Toda entidad soft-delete se filtra por `deleted_at IS NULL`
 *    desde la consulta, y además se descarta la que cuelga de un CURSO en
 *    papelera (el soft-delete del curso no cascadea: sus exámenes/talleres
 *    quedan con `deleted_at = NULL`). Un ítem en la papelera no puede aparecer
 *    en un selector en NINGÚN flujo hasta restaurarse.
 *
 * 2. **Alcance del docente.** La policy de `courses` deja ver TODO el tenant a
 *    cualquier autenticado — a propósito —, así que "el docente ve solo lo
 *    suyo" NO lo da la base: lo decide el cliente por el ROL ACTIVO
 *    (`course-scope.ts`). Dos trampas: `[]` no es `null` (un docente sin cursos
 *    devuelve vacío SIN consultar, porque `.in(col, [])` en PostgREST devuelve
 *    TODAS las filas); y talleres/proyectos son M:N — filtrar por el `course_id`
 *    ancla le escondería al docente un taller compartido a su curso pero creado
 *    desde otro.
 *
 * 3. **Rol ACTIVO, no roles poseídos.** Un usuario multi-rol actuando como
 *    Estudiante no ve resultados de staff. Es UX (la RLS usa `has_role()`, que
 *    es el rol POSEÍDO), pero es la coherencia que el usuario espera.
 *
 * ── Qué ve cada rol ───────────────────────────────────────────────────────
 * Staff: cursos, exámenes, talleres, proyectos y contenidos de su alcance;
 * pizarras solo Docente/SuperAdmin y usuarios solo Admin/SuperAdmin — porque
 * son los únicos que pasan el RBAC de esas rutas (`rbac.ts`), y ofrecer un
 * destino que termina en `/app/unauthorized` es peor que no ofrecerlo.
 *
 * Estudiante: sus exámenes / talleres / proyectos ASIGNADOS y las pizarras
 * compartidas con los cursos donde está matriculado. No hay grupo "Cursos"
 * porque el alumno no tiene una ruta por curso (el curso es estado local de la
 * pantalla, no va en la URL), y un resultado que te deja en una lista sin
 * seleccionar nada es una acción a medias.
 */

import { supabase } from "@/integrations/supabase/client";
import { scopedCourseIds, visibleForScopedCourses } from "@/modules/courses/course-scope";
import { isStaffActive } from "@/shared/lib/roles";
import { MIN_QUERY_LENGTH, ilikePatternFor, matchesQuery, sortByRelevance } from "./search-text";

// Los tipos generados de Supabase no reflejan `deleted_at` ni la tabla
// `whiteboards`, así que el cliente tipado rechaza selects que el resto del
// repo ya usa. Mismo `db` suelto que las rutas de Pizarras y Contenidos.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type PaletteKind =
  | "course"
  | "exam"
  | "workshop"
  | "project"
  | "whiteboard"
  | "content"
  | "user";

/** Un resultado listo para navegar. `params`/`search` se pasan tal cual a TanStack. */
export type PaletteHit = {
  /** `kind:id` — key de React y `value` de cmdk (que exige unicidad). */
  key: string;
  kind: PaletteKind;
  title: string;
  /** Dato que DESAMBIGUA (curso, periodo, correo): dos talleres se llaman igual. */
  subtitle: string | null;
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
};

/** La parte navegable de un resultado (lo que se le pasa a `navigate`). */
type PaletteDest = Pick<PaletteHit, "to" | "params" | "search">;

/**
 * Cuánto se le pide al servidor por grupo. Es más que lo que se muestra porque
 * el patrón `ilike` es a propósito un SUPERCONJUNTO (ver `ilikePatternFor`) y
 * el filtro fino lo hace el cliente: sin margen, el `limit` se llenaría de
 * falsos positivos y escondería el acierto.
 */
const FETCH_LIMIT = 40;

/** Cuánto se MUESTRA por grupo. Es un buscador, no un listado. */
const GROUP_LIMIT = 6;

/**
 * Tope de asignaciones del estudiante que entran al filtro `.in(...)`.
 *
 * Los ids viajan en la URL de PostgREST (~37 chars c/u), así que una lista sin
 * tope termina en un 414 silencioso. 150 cubre de sobra un semestre; si alguien
 * los supera, la búsqueda cubre sus 150 asignaciones más recientes.
 */
const MAX_ASSIGNMENT_IDS = 150;

type CourseRef = { id: string; name: string; deleted_at: string | null } | null;

/**
 * Todo lo que NO depende del texto buscado: se resuelve una vez al abrir la
 * paleta (y de nuevo si cambia el rol activo), no en cada pulsación.
 */
export type SearchScope = {
  userId: string;
  staff: boolean;
  student: boolean;
  /** `/app/teacher/whiteboards` es Docente/SuperAdmin: el Admin NO pasa el RBAC. */
  canSearchWhiteboards: boolean;
  /** `/app/admin/users` es Admin/SuperAdmin. */
  canSearchUsers: boolean;
  /** Admin/SuperAdmin actuando como tal ven los contenidos de todos los docentes. */
  seesAllContents: boolean;
  /** `null` = sin acotar (Admin/SA). `[]` = docente sin cursos. */
  courseIds: string[] | null;
  /** Talleres/proyectos COMPARTIDOS a mis cursos aunque estén anclados en otro. */
  sharedWorkshopIds: string[];
  sharedProjectIds: string[];
  /** Estudiante: cursos matriculados (sin los que están en papelera). */
  studentCourseIds: string[];
  studentExamIds: string[];
  studentWorkshopIds: string[];
  studentProjectIds: string[];
};

/** Scope vacío: se usa mientras no hay usuario y como base de los branches. */
function emptyScope(userId: string): SearchScope {
  return {
    userId,
    staff: false,
    student: false,
    canSearchWhiteboards: false,
    canSearchUsers: false,
    seesAllContents: false,
    courseIds: [],
    sharedWorkshopIds: [],
    sharedProjectIds: [],
    studentCourseIds: [],
    studentExamIds: [],
    studentWorkshopIds: [],
    studentProjectIds: [],
  };
}

async function idsFrom(table: string, column: string, userId: string): Promise<string[]> {
  const { data } = await db
    .from(table)
    .select(column)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_ASSIGNMENT_IDS);
  return [
    ...new Set(
      ((data ?? []) as Array<Record<string, string>>).map((r) => r[column]).filter(Boolean),
    ),
  ];
}

/**
 * Resuelve el alcance del usuario. Nunca lanza: si una consulta falla, el grupo
 * afectado queda vacío y la paleta sigue sirviendo para los módulos.
 */
export async function loadSearchScope(
  userId: string,
  activeRole: string | null | undefined,
  roles: readonly string[],
): Promise<SearchScope> {
  const scope = emptyScope(userId);
  scope.staff = isStaffActive(activeRole, roles);
  scope.student = !scope.staff;

  if (!scope.staff) {
    // ── Estudiante ────────────────────────────────────────────────────────
    // Se scopea por ASIGNACIONES (no por "todo lo del curso"): eso es lo que
    // realmente le toca hacer, y coincide con lo que ya listan sus pantallas.
    try {
      const [enr, exams, workshops, projects] = await Promise.all([
        db
          .from("course_enrollments")
          .select("course_id, courses(id, deleted_at)")
          .eq("user_id", userId),
        idsFrom("exam_assignments", "exam_id", userId),
        idsFrom("workshop_assignments", "workshop_id", userId),
        idsFrom("project_assignments", "project_id", userId),
      ]);
      scope.studentCourseIds = [
        ...new Set(
          (
            (enr?.data ?? []) as Array<{
              course_id: string;
              courses: { id: string; deleted_at: string | null } | null;
            }>
          )
            // Curso en papelera: deja de existir para el alumno en todo flujo.
            .filter((r) => r.courses && !r.courses.deleted_at)
            .map((r) => r.course_id),
        ),
      ];
      scope.studentExamIds = exams;
      scope.studentWorkshopIds = workshops;
      scope.studentProjectIds = projects;
    } catch {
      // Scope vacío ⇒ sin resultados de entidades. Los módulos siguen.
    }
    return scope;
  }

  // ── Staff ───────────────────────────────────────────────────────────────
  const adminLike = activeRole === "Admin" || activeRole === "SuperAdmin";
  scope.canSearchUsers = adminLike;
  scope.seesAllContents = adminLike && (roles.includes("Admin") || roles.includes("SuperAdmin"));
  scope.canSearchWhiteboards = activeRole === "Docente" || activeRole === "SuperAdmin";

  try {
    scope.courseIds = await scopedCourseIds(activeRole, roles, userId);
  } catch {
    // Ante la duda, NO ampliar el alcance: `[]` corta sin consultar.
    scope.courseIds = [];
    return scope;
  }

  const ids = scope.courseIds;
  if (ids && ids.length > 0) {
    try {
      const [ws, ps] = await Promise.all([
        db.from("workshop_courses").select("workshop_id").in("course_id", ids),
        db.from("project_courses").select("project_id").in("course_id", ids),
      ]);
      scope.sharedWorkshopIds = [
        ...new Set(((ws?.data ?? []) as Array<{ workshop_id: string }>).map((r) => r.workshop_id)),
      ];
      scope.sharedProjectIds = [
        ...new Set(((ps?.data ?? []) as Array<{ project_id: string }>).map((r) => r.project_id)),
      ];
    } catch {
      // Sin la rama de compartidos solo se pierde el taller ajeno compartido.
    }
  }
  return scope;
}

/** ¿El curso del ítem está vivo? Un curso en papelera se lleva su contenido. */
function liveCourse(course: CourseRef): { id: string; name: string } | null {
  return course && !course.deleted_at ? { id: course.id, name: course.name } : null;
}

/**
 * Recorta al tope del grupo aplicando el filtro EXACTO del cliente.
 *
 * El servidor devolvió un superconjunto (patrón laxo por los acentos); acá se
 * descarta lo que no coincide de verdad y se ordena por relevancia.
 */
function finish<T>(
  rows: readonly T[],
  query: string,
  getTitle: (row: T) => string,
  toHit: (row: T) => PaletteHit,
): PaletteHit[] {
  return sortByRelevance(
    rows.filter((r) => matchesQuery(getTitle(r), query)),
    query,
    getTitle,
  )
    .slice(0, GROUP_LIMIT)
    .map(toHit);
}

/** Filtro `.or(...)` para talleres/proyectos M:N. `null` = no acotar. */
function scopeOrFilter(courseIds: string[] | null, sharedIds: string[]): string | null {
  if (!courseIds) return null;
  const anchor = `course_id.in.(${courseIds.join(",")})`;
  if (sharedIds.length === 0) return anchor;
  return `${anchor},id.in.(${sharedIds.join(",")})`;
}

// ── Grupos ────────────────────────────────────────────────────────────────

async function searchCourses(q: string, s: SearchScope): Promise<PaletteHit[]> {
  if (!s.staff) return [];
  if (s.courseIds && s.courseIds.length === 0) return [];
  let query = db
    .from("courses")
    .select("id, name, period")
    .is("deleted_at", null)
    .ilike("name", ilikePatternFor(q))
    .order("name")
    .limit(FETCH_LIMIT);
  if (s.courseIds) query = query.in("id", s.courseIds);
  const { data } = await query;
  type Row = { id: string; name: string; period: string | null };
  return finish<Row>(
    (data ?? []) as Row[],
    q,
    (r) => r.name,
    (r) => ({
      key: `course:${r.id}`,
      kind: "course",
      title: r.name,
      subtitle: r.period,
      to: "/app/teacher/board/$courseId",
      params: { courseId: r.id },
    }),
  );
}

async function searchExams(q: string, s: SearchScope): Promise<PaletteHit[]> {
  type Row = {
    id: string;
    title: string;
    status: string | null;
    is_external: boolean | null;
    course: CourseRef;
  };
  const select = "id, title, status, is_external, course:courses(id, name, deleted_at)";
  let query = db
    .from("exams")
    .select(select)
    .is("deleted_at", null)
    .ilike("title", ilikePatternFor(q))
    .limit(FETCH_LIMIT);

  if (s.staff) {
    if (s.courseIds && s.courseIds.length === 0) return [];
    if (s.courseIds) query = query.in("course_id", s.courseIds);
  } else {
    if (s.studentExamIds.length === 0) return [];
    query = query.in("id", s.studentExamIds);
  }

  const { data } = await query;
  let rows = ((data ?? []) as Row[]).filter((r) => liveCourse(r.course));
  if (!s.staff) {
    // Mismo filtro que ya aplican las ramas de talleres y proyectos de este
    // archivo, y que acá faltaba: `autoAssignExam` crea las filas de
    // `exam_assignments` al CREAR el examen, aunque quede en borrador, así que
    // filtrar por asignación no alcanza — el alumno encontraba en ⌘K un examen
    // que el docente no publicó, y los externos, que se rinden fuera de la
    // plataforma y no tienen a dónde llevarlo.
    rows = rows.filter((r) => !r.is_external && (r.status ?? "published") !== "draft");
  }
  return finish<Row>(
    rows,
    q,
    (r) => r.title,
    (r) => {
      // El estudiante va a la LISTA, nunca a `/app/student/take/$examId`:
      // empezar a rendir un examen no puede ser el resultado de una búsqueda.
      const dest: PaletteDest = s.staff
        ? { to: "/app/teacher/exams/$examId", params: { examId: r.id } }
        : { to: "/app/student/exams" };
      return {
        key: `exam:${r.id}`,
        kind: "exam",
        title: r.title,
        subtitle: liveCourse(r.course)?.name ?? null,
        ...dest,
      };
    },
  );
}

async function searchWorkshops(q: string, s: SearchScope): Promise<PaletteHit[]> {
  type Row = {
    id: string;
    title: string;
    course_id: string | null;
    is_external: boolean | null;
    status: string | null;
    course: CourseRef;
    shares: Array<{ course_id: string }> | null;
  };
  const select =
    "id, title, course_id, is_external, status, course:courses(id, name, deleted_at), shares:workshop_courses(course_id)";
  let query = db
    .from("workshops")
    .select(select)
    .is("deleted_at", null)
    .ilike("title", ilikePatternFor(q))
    .limit(FETCH_LIMIT);

  if (s.staff) {
    if (s.courseIds && s.courseIds.length === 0) return [];
    const or = scopeOrFilter(s.courseIds, s.sharedWorkshopIds);
    if (or) query = query.or(or);
  } else {
    if (s.studentWorkshopIds.length === 0) return [];
    query = query.in("id", s.studentWorkshopIds);
  }

  const { data } = await query;
  let rows = (data ?? []) as Row[];
  if (!s.staff) {
    // Paridad con la vista del alumno: lo externo solo registra notas y el
    // borrador todavía no se publicó.
    rows = rows.filter((r) => !r.is_external && (r.status ?? "published") !== "draft");
  }
  // M:N: el `course_id` es solo el ancla. `visibleForScopedCourses` mira
  // también las comparticiones para no esconder un taller de MI curso creado
  // desde otro.
  const sharedMap = new Map<string, string[]>(
    rows.map((r) => [r.id, (r.shares ?? []).map((x) => x.course_id)]),
  );
  rows = visibleForScopedCourses(rows, s.staff ? s.courseIds : null, sharedMap);
  rows = rows.filter(
    (r) =>
      liveCourse(r.course) !== null ||
      // Ancla en papelera pero compartido a un curso mío vivo: sigue siendo
      // trabajo del docente, esconderlo es el error caro.
      (s.courseIds ?? []).some((c) => sharedMap.get(r.id)?.includes(c)),
  );
  return finish<Row>(
    rows,
    q,
    (r) => r.title,
    (r) => {
      const dest: PaletteDest = s.staff
        ? { to: "/app/teacher/workshops", search: { workshop: r.id } }
        : { to: "/app/student/workshop/$workshopId", params: { workshopId: r.id } };
      return {
        key: `workshop:${r.id}`,
        kind: "workshop",
        title: r.title,
        subtitle: liveCourse(r.course)?.name ?? null,
        ...dest,
      };
    },
  );
}

async function searchProjects(q: string, s: SearchScope): Promise<PaletteHit[]> {
  type Row = {
    id: string;
    title: string;
    course_id: string | null;
    is_external: boolean | null;
    status: string | null;
    course: CourseRef;
    shares: Array<{ course_id: string }> | null;
  };
  const select =
    "id, title, course_id, is_external, status, course:courses(id, name, deleted_at), shares:project_courses(course_id)";
  let query = db
    .from("projects")
    .select(select)
    .is("deleted_at", null)
    .ilike("title", ilikePatternFor(q))
    .limit(FETCH_LIMIT);

  if (s.staff) {
    if (s.courseIds && s.courseIds.length === 0) return [];
    const or = scopeOrFilter(s.courseIds, s.sharedProjectIds);
    if (or) query = query.or(or);
  } else {
    if (s.studentProjectIds.length === 0) return [];
    query = query.in("id", s.studentProjectIds);
  }

  const { data } = await query;
  let rows = (data ?? []) as Row[];
  if (!s.staff) {
    rows = rows.filter((r) => !r.is_external && (r.status ?? "published") !== "draft");
  }
  const sharedMap = new Map<string, string[]>(
    rows.map((r) => [r.id, (r.shares ?? []).map((x) => x.course_id)]),
  );
  rows = visibleForScopedCourses(rows, s.staff ? s.courseIds : null, sharedMap);
  rows = rows.filter(
    (r) =>
      liveCourse(r.course) !== null ||
      (s.courseIds ?? []).some((c) => sharedMap.get(r.id)?.includes(c)),
  );
  return finish<Row>(
    rows,
    q,
    (r) => r.title,
    (r) => {
      const dest: PaletteDest = s.staff
        ? { to: "/app/teacher/projects", search: { project: r.id } }
        : { to: "/app/student/project/$projectId", params: { projectId: r.id } };
      return {
        key: `project:${r.id}`,
        kind: "project",
        title: r.title,
        subtitle: liveCourse(r.course)?.name ?? null,
        ...dest,
      };
    },
  );
}

async function searchWhiteboards(q: string, s: SearchScope): Promise<PaletteHit[]> {
  // El Admin NO pasa el RBAC de `/app/teacher/whiteboards`: ofrecerle el
  // resultado lo mandaría a `/app/unauthorized`.
  if (s.staff && !s.canSearchWhiteboards) return [];
  if (!s.staff && s.studentCourseIds.length === 0) return [];
  type Row = {
    id: string;
    name: string;
    course_id: string | null;
    status: string | null;
    course: CourseRef;
  };
  const select = "id, name, course_id, status, course:courses(id, name, deleted_at)";
  let query = db
    .from("whiteboards")
    .select(select)
    .is("deleted_at", null)
    .ilike("name", ilikePatternFor(q))
    .limit(FETCH_LIMIT);

  if (s.staff) {
    if (s.courseIds) {
      query =
        s.courseIds.length === 0
          ? // Sin cursos quedan solo las propias. NO `.in("course_id", [])`:
            // en PostgREST eso devuelve TODAS las filas.
            query.eq("owner_id", s.userId)
          : query.or(
              `owner_id.eq.${s.userId},and(is_shared_with_course.eq.true,course_id.in.(${s.courseIds.join(",")}))`,
            );
    }
  } else {
    query = query.eq("is_shared_with_course", true).in("course_id", s.studentCourseIds);
  }

  const { data } = await query;
  let rows = (data ?? []) as Row[];
  // Una pizarra CERRADA sale del listado activo del alumno.
  if (!s.staff) rows = rows.filter((r) => (r.status ?? "published") !== "closed");
  // Pizarra de un curso en papelera: el curso ya no existe. Las pizarras SIN
  // curso (personales del docente) se quedan.
  rows = rows.filter((r) => !r.course_id || liveCourse(r.course) !== null);
  return finish<Row>(
    rows,
    q,
    (r) => r.name,
    (r) => ({
      key: `whiteboard:${r.id}`,
      kind: "whiteboard",
      title: r.name,
      subtitle: liveCourse(r.course)?.name ?? null,
      to: s.staff ? "/app/teacher/whiteboards/$id" : "/app/student/whiteboards/$id",
      params: { id: r.id },
    }),
  );
}

async function searchContents(q: string, s: SearchScope): Promise<PaletteHit[]> {
  // El alumno consume el material desde el tablero de su curso, que no acepta
  // un contenido por URL: no hay destino que ofrecerle.
  if (!s.staff) return [];
  type Row = {
    id: string;
    display_name: string;
    topic: string | null;
    course: CourseRef;
  };
  const select = "id, display_name, topic, course:courses(id, name, deleted_at)";
  let query = db
    .from("generated_contents")
    .select(select)
    .is("deleted_at", null)
    .ilike("display_name", ilikePatternFor(q))
    .limit(FETCH_LIMIT);
  // Mismo criterio que el módulo Contenidos: el Docente ve los suyos
  // (`teacher_id`), el Admin/SuperAdmin actuando como tal ve los del tenant.
  if (!s.seesAllContents) query = query.eq("teacher_id", s.userId);

  const { data } = await query;
  const rows = (data ?? []) as Row[];
  return finish<Row>(
    rows,
    q,
    (r) => r.display_name,
    (r) => ({
      key: `content:${r.id}`,
      kind: "content",
      title: r.display_name,
      subtitle: liveCourse(r.course)?.name ?? r.topic ?? null,
      to: "/app/teacher/contents",
      search: { content: r.id },
    }),
  );
}

async function searchUsers(q: string, s: SearchScope): Promise<PaletteHit[]> {
  if (!s.canSearchUsers) return [];
  type Row = { id: string; full_name: string; institutional_email: string };
  const pattern = ilikePatternFor(q);
  const { data } = await db
    .from("profiles")
    .select("id, full_name, institutional_email")
    // El patrón viene saneado (sin comas ni paréntesis), así que es seguro
    // dentro de un `.or(...)`.
    .or(`full_name.ilike.${pattern},institutional_email.ilike.${pattern}`)
    .order("full_name")
    .limit(FETCH_LIMIT);
  const rows = ((data ?? []) as Row[]).filter(
    (r) => matchesQuery(r.full_name, q) || matchesQuery(r.institutional_email, q),
  );
  return finish<Row>(
    rows,
    q,
    (r) => r.full_name,
    (r) => ({
      key: `user:${r.id}`,
      kind: "user",
      title: r.full_name,
      subtitle: r.institutional_email,
      // No hay ruta de detalle por usuario: se abre el módulo con el filtro de
      // búsqueda ya escrito, que es donde están todas las acciones.
      to: "/app/admin/users",
      search: { q: r.full_name },
    }),
  );
}

/** Orden en que se pintan los grupos. */
export const PALETTE_KIND_ORDER: readonly PaletteKind[] = [
  "course",
  "exam",
  "workshop",
  "project",
  "content",
  "whiteboard",
  "user",
];

export type GlobalSearchResult = {
  hits: PaletteHit[];
  /** Alguna consulta falló: la paleta lo dice en vez de mentir con "sin resultados". */
  failed: boolean;
};

/**
 * Busca en todas las entidades habilitadas para el scope.
 *
 * Los grupos van en paralelo y con `allSettled`: si una tabla falla (red, RLS,
 * deploy a medias) los demás grupos igual se muestran.
 */
export async function searchGlobal(query: string, scope: SearchScope): Promise<GlobalSearchResult> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return { hits: [], failed: false };

  const settled = await Promise.allSettled([
    searchCourses(q, scope),
    searchExams(q, scope),
    searchWorkshops(q, scope),
    searchProjects(q, scope),
    searchContents(q, scope),
    searchWhiteboards(q, scope),
    searchUsers(q, scope),
  ]);

  const hits: PaletteHit[] = [];
  let failed = false;
  for (const r of settled) {
    if (r.status === "fulfilled") hits.push(...r.value);
    else failed = true;
  }
  return { hits, failed };
}
