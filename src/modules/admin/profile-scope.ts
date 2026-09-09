/**
 * Alcance por ESTADO DE CUENTA: a quién se le puede OFRECER algo.
 *
 * ── El bug que ataja ──────────────────────────────────────────────────
 * Un usuario eliminado o desactivado desde el panel de administración seguía
 * apareciendo como opción para matricular en un curso. Medido el 2026-09-09:
 * el diálogo de matrícula cargaba `from("profiles").select(...)` sin ningún
 * filtro, y **ninguna** de las ~65 consultas a `profiles` de `src/` filtraba por
 * estado de cuenta. El encabezado de la edge `admin-delete-user` afirma que «los
 * listados de usuarios ya filtran deleted_at IS NULL» y eso no era cierto de
 * ninguno: los tres `is("deleted_at", null)` del panel de usuarios son sobre
 * `tenants` y `courses`.
 *
 * ── Por qué el filtro vive en el cliente y no en la RLS ───────────────
 * Porque un perfil eliminado TIENE que seguir siendo legible. La entrega de un
 * estudiante que se retiró después de entregar necesita mostrar su nombre en el
 * monitor, en el gradebook y en el acta; cortarlo en la RLS dejaría notas sin
 * dueño y actas con un UUID. O sea que la base no puede distinguir «ofrecer» de
 * «resolver un nombre»: solo el llamador sabe para qué está preguntando.
 *
 * Es la misma forma que `src/modules/courses/course-scope.ts` — una regla
 * transversal que estaba repetida y omitida en muchas pantallas y se resuelve
 * con UN módulo. Y la diferencia con ese: acá el eje no es el rol de quien mira,
 * es el estado de la cuenta que se muestra.
 *
 * ── Las dos familias, y la que NO se toca ─────────────────────────────
 *   (A) OFRECER  — matrícula, asignar una actividad, armar grupos, designar
 *       vocero, pedir una firma, mover de institución, el buscador. Acá una
 *       cuenta eliminada o desactivada NO puede aparecer. Es lo que este módulo
 *       filtra.
 *   (B) RESOLVER un nombre de algo que YA existe — monitor, gradebook,
 *       entregas, hilos de retroalimentación, informes, asistencia tomada.
 *       **Acá NO se usa este módulo.** Filtrar ahí sería peor que el bug.
 *
 * ── El nulo es ACTIVO, y equivocarse en eso vacía la plataforma ───────
 * `is_active` es NULLABLE y en producción 325 de 566 perfiles lo tienen en NULL
 * (filas anteriores a la migración que agregó la columna). Un predicado que
 * exija `is_active = true` deja fuera a más de la mitad de la gente, así que el
 * nulo cuenta como activa — el mismo criterio que ya usa el grid del panel de
 * usuarios (`r.is_active !== false`).
 *
 * `estado` NO entra en el predicado a propósito: es OTRO eje (matrícula
 * académica: `activo` / `retirado` / `aplazado` / `graduado`, con su propio
 * enforcement en la RLS vía `is_student_blocked`), lo escribe el Admin a mano, y
 * ni eliminar ni desactivar lo tocan. Mezclarlos haría que borrar una cuenta
 * pareciera cambiarle la situación académica.
 */

/** Las columnas de estado que hay que traer en el `select` para poder filtrar. */
export const PROFILE_STATE_COLUMNS = "deleted_at, is_active";

export interface ProfileState {
  deleted_at?: string | null;
  is_active?: boolean | null;
}

/**
 * ¿Se le puede OFRECER algo a esta cuenta? `false` si está eliminada
 * (`deleted_at`) o desactivada (`is_active === false`).
 *
 * El nulo de `is_active` es ACTIVO (ver el encabezado). Y un objeto al que le
 * falten las columnas cuenta como activo a propósito: si un llamador se olvidó
 * de pedirlas en el `select`, es mejor que ofrezca de más —el comportamiento de
 * hoy— que vaciarle la lista sin decir nada.
 */
export function seLePuedeOfrecer(p: ProfileState | null | undefined): boolean {
  if (!p) return false;
  if (p.deleted_at != null) return false;
  if (p.is_active === false) return false;
  return true;
}

/** Deja solo las cuentas a las que se les puede ofrecer algo. */
export function soloOfrecibles<T extends ProfileState>(filas: readonly T[]): T[] {
  return filas.filter((f) => seLePuedeOfrecer(f));
}

/**
 * Aplica el filtro EN LA CONSULTA, que es donde va cuando se puede: así los
 * conteos y las cascadas que cuelgan de la lista no mienten sobre filas que
 * después se esconden en el render.
 *
 * Produce `deleted_at IS NULL AND is_active IS NOT FALSE`.
 *
 * `IS NOT FALSE` y no `= true`: así el nulo cuenta como activa sin gastar el
 * `or(...)` de la consulta — PostgREST admite UNO solo de primer nivel, y hay
 * consultas que ya lo usan para lo suyo (el buscador global lo usa para buscar
 * por nombre o por correo). Con la versión de `or` este helper no se podía
 * encadenar ahí.
 */
export function conPerfilOfrecible<
  Q extends {
    is: (col: string, val: null) => Q;
    not: (col: string, op: string, val: boolean) => Q;
  },
>(q: Q): Q {
  return q.is("deleted_at", null).not("is_active", "is", false);
}
