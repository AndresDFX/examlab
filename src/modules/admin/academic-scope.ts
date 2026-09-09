/**
 * Alcance por institución de la estructura académica (programas/carreras,
 * periodos, asignaturas).
 *
 * Por qué existe: las tres policies de lectura (mig 20260622000000) son
 *   tenant_id = current_tenant_id() OR public.is_super_admin()
 * Para un Admin la base ya acota y este módulo es un no-op. Para quien POSEE el
 * rol SuperAdmin la base deja pasar TODAS las instituciones a propósito, así que
 * el filtro solo puede vivir en el cliente.
 *
 * Diferencia con `course-scope.ts` que conviene NO "corregir": allá el gate es el
 * rol ACTIVO (la RLS no acota a nadie y la regla es de intención de rol). Acá es
 * el rol POSEÍDO, porque `is_super_admin()` mira los roles poseídos: un
 * SuperAdmin actuando como Admin sigue viendo las 7 instituciones.
 */

export type AcademicScope =
  | { modo: "sin-acotar" } // Admin: la RLS ya acota.
  | { modo: "institucion"; tenantId: string } // SA con institución elegida.
  | { modo: "sin-institucion" }; // SA que todavía no eligió.

/** Centinelas de los Select de institución que NO son un id. */
const NO_ES_ID = new Set(["all", "none", "__none__", ""]);

export function necesitaAcotarPorInstitucion(roles: readonly string[]): boolean {
  return roles.includes("SuperAdmin");
}

export function academicScope(input: {
  /** Roles POSEÍDOS: deciden SI hay que acotar (la RLS no acota a quien posee SuperAdmin). */
  roles: readonly string[];
  /** La institución del contexto de la pantalla (el Select de institución, `editing.tenant_id`…). */
  institucionElegida: string | null | undefined;
  /**
   * `activeRole === "SuperAdmin"`. Decide CON QUÉ acotar, y hay que pasarlo en
   * toda pantalla cuyo Select de institución solo se renderice para el rol
   * ACTIVO SuperAdmin. Un usuario con [SuperAdmin, Admin] que se pasa a Admin
   * no ve ese Select, así que `institucionElegida` llega vacía y la pantalla le
   * quedaba vacía y sin salida — mostrándole encima «No hay cursos disponibles
   * en esta institución», el mismo mensaje que este arreglo vino a eliminar.
   * Omitirlo mantiene el camino de «la institución elegida es la llave».
   */
  actuandoComoSuperAdmin?: boolean;
  /** `profiles.tenant_id` del caller: la llave cuando POSEE SuperAdmin pero actúa como Admin. */
  tenantPropio?: string | null;
}): AcademicScope {
  if (!necesitaAcotarPorInstitucion(input.roles)) return { modo: "sin-acotar" };
  if (input.actuandoComoSuperAdmin === false) {
    const propio = (input.tenantPropio ?? "").trim();
    return propio && !NO_ES_ID.has(propio)
      ? { modo: "institucion", tenantId: propio }
      : { modo: "sin-institucion" };
  }
  const id = (input.institucionElegida ?? "").trim();
  if (!id || NO_ES_ID.has(id)) return { modo: "sin-institucion" };
  return { modo: "institucion", tenantId: id };
}

/** `false` ⇒ devolver lista vacía SIN pegarle a la tabla. */
export function debeConsultar(scope: AcademicScope): boolean {
  return scope.modo !== "sin-institucion";
}

/**
 * Aplica el `.eq(tenant_id)` cuando corresponde. LANZA si no hay institución
 * elegida: olvidarse del corte tiene que fallar fuerte y temprano, porque la
 * alternativa silenciosa es justo el bug (listar todas las instituciones).
 */
export function conTenant<Q extends { eq: (col: string, val: string) => Q }>(
  q: Q,
  scope: AcademicScope,
  columna = "tenant_id",
): Q {
  if (scope.modo === "sin-institucion") {
    throw new Error(
      "academic-scope: no hay institución elegida — cortá con debeConsultar() antes de consultar.",
    );
  }
  return scope.modo === "institucion" ? q.eq(columna, scope.tenantId) : q;
}
