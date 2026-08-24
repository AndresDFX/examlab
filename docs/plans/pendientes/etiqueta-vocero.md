# Etiqueta informativa Vocero — plan de diseño

> Producido por el workflow `etiqueta-vocero` (mapeo + frente de ataque + síntesis).
> **NO implementado todavía.** Las afirmaciones están verificadas por los agentes contra
> el código; las que sostienen decisiones grandes conviene re-verificarlas antes de
> ejecutar.

Verified everything against the repo and the RLS dump. One load-bearing correction to the inputs first: **`.rls-audit/` is del 2026-07-20 y está desactualizado** — no incluye `enrollments_super_admin_manage` (mig `20261550000000`, que sí existe en el repo). Esa policy cambia la decisión clave: `USING (is_super_admin())` FOR ALL ya está en prod, así que **una RPC `SECURITY INVOKER` alcanza a los tres actores** sin re-implementar autorización.

---

# Vocero del curso — plan de ejecución

## 1. Decisiones

| # | Decisión | Por qué (una línea) |
|---|---|---|
| D1 | La marca vive en **`public.course_enrollments`** | Es el único lugar donde "esta persona, en este curso" ES una fila; hace verdadera por construcción la invariante *vocero ⇒ matriculado* y hereda el scope de curso+tenant ya correcto. |
| D2 | **NO** en `user_roles` / `app_role` / `profiles` / tabla nueva | `has_role()` es global y es el predicado de ~370 policies: un `Vocero` en `user_roles` queda a un `OR has_role(uid,'Vocero')` de ser permiso, y entra al role-switcher y a `ALL_ROLES` (`app.admin.users.tsx:134`). `profiles` no puede expresar "por curso". |
| D3 | Dos columnas: **`vocero_marcado_at TIMESTAMPTZ`** + **`vocero_marcado_por UUID`** — no `is_vocero BOOLEAN` | Un booleano llamado `is_vocero` invita a `if (is_vocero) puedeX`; `vocero_marcado_at` se lee como un registro de designación, y la procedencia (quién/cuándo) sale gratis — que es lo único que después permite auditar. |
| D4 | **UNO por curso**, con índice único parcial | El Acuerdo Pedagógico tiene UNA fila "Nombre del vocero" y UNA celda de firma (`20260611010000:68,96`) y el generador de UNIAJ un solo `[PENDIENTE — vocero]` (`generar_semestre_2026_2.py:480`). Con N, el acta elegiría uno arbitrariamente. `suplente`: 0 hits en el repo → no se modela. |
| D5 | Marcan: **Docente del curso, Admin del tenant, SuperAdmin** — con las 3 policies de escritura que YA existen, sin tocarlas | `_teaches_course(course_id) AND has_role('Docente')` · `course_in_my_tenant(course_id) AND has_role('Admin')` · `is_super_admin()`. Son exactamente los actores del pedido y ya tienen scope de curso/tenant: no hay antipatrón que evitar, hay uno que reusar. |
| D6 | Escritura por **RPC `SECURITY INVOKER`** + **guard trigger** que congela la columna | INVOKER hace que esas 3 policies *sean* la autorización (nada que re-derivar, ni el hueco de tenant ni el de SA que tiene `mark_forum_reply_official`, `20260520100000:405`); el trigger es lo que sobrevive a que alguien agregue mañana una rama owner-writable (los GRANT de `authenticated` **y `anon`** sobre la tabla son totales y una columna nueva los hereda). |
| D7 | Ven la etiqueta **solo Docente / Admin / SuperAdmin**. Los compañeros, **fuera de v1** | El pedido es "yo pueda marcar… y ayúdame a filtrar": el consumidor es el staff. Publicarlo al curso exige una rama nueva en `enrollments_select_in_tenant` (hoy el alumno ve solo su fila) — decisión de privacidad, y UNIAJ tiene escrito lo contrario ("vocero / firmas … **No** se transcriben"). Receta lista en §6. |
| D8 | Ícono **`Mic`** (0 usos en `src/`), el mismo en badge, acción y filtro | `Megaphone` ya es "difundir" (`app.messages.tsx:1580`), `Crown` es "respuesta oficial"/podio, `UserRoundCheck` colisiona visualmente con `UserCheck` = "activar usuario". "Vocero" = la voz del curso. |
| D9 | Cero cambios en `ModuleKey`, `MODULE_CATALOG`, `NAV_PATH_TO_MODULE`, `PREFIX_TO_MODULE`, `rbac.ts`, `module_visibility`, `app_role` | No es un módulo ni un rol — y que esa lista quede intacta es la señal de que el diseño está en el nivel correcto. |

---

## 2. La migración

`supabase/migrations/20261740000000_course_vocero_label.sql` (el más alto hoy es `20261730000000`).

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- Vocero del curso — ETIQUETA INFORMATIVA. NO es un rol y NO da permisos.
--
-- Pedido: el docente o el Admin marca al representante del curso, se ve como
-- etiqueta y se puede filtrar. Nada más: no habilita acciones, no cambia notas.
--
-- POR QUÉ ACÁ y no en user_roles: `has_role()` es GLOBAL (no tiene course_id ni
-- tenant_id) y es el predicado con el que branchean cientos de policies. Un
-- 'Vocero' en user_roles quedaría a un solo `OR has_role(uid,'Vocero')` de ser
-- permiso, además de aparecer en el role-switcher. La designación es de UNA
-- matrícula (este alumno, en este curso, en este periodo), así que la fila de
-- course_enrollments es el lugar exacto.
--
-- POR QUÉ `vocero_marcado_at` y no `is_vocero`: un booleano con ese nombre
-- invita a `if (is_vocero) puedeX`. Un timestamp de designación se lee como el
-- registro que es, y da la procedencia (quién/cuándo) gratis.
--
-- POR QUÉ la RPC es SECURITY INVOKER: las 3 policies de escritura de
-- course_enrollments (Docente por `_teaches_course`, Admin por
-- `course_in_my_tenant`, SuperAdmin por `is_super_admin` — mig 20261550000000)
-- YA son exactamente los actores autorizados y YA tienen scope de curso/tenant.
-- Con DEFINER habría que re-implementarlas, que es de donde salió el bug de
-- `mark_forum_reply_official` (has_role('Admin') sin tenant y sin rama SA).
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'public.course_enrollments no existe — se omite la migración.';
    RETURN;
  END IF;

  -- Dos columnas nullable: ADD COLUMN sin DEFAULT no reescribe la tabla.
  ALTER TABLE public.course_enrollments
    ADD COLUMN IF NOT EXISTS vocero_marcado_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS vocero_marcado_por UUID
      REFERENCES auth.users(id) ON DELETE SET NULL;

  -- ON DELETE SET NULL (misma convención que `deleted_by` en 20260816000000):
  -- así esta FK NO bloquea el `DELETE FROM auth.users` de `hard_delete_tenant`
  -- y no hay que actualizar esa RPC.

  COMMENT ON COLUMN public.course_enrollments.vocero_marcado_at IS
    'Etiqueta INFORMATIVA: designación del vocero (representante) del curso. '
    'NO otorga permisos. PROHIBIDO usarla en policies RLS, en RPCs de '
    'autorización o en gates de UI/ruta: el vocero se MUESTRA, no habilita '
    'nada. Escritura exclusiva del docente del curso / Admin del tenant / '
    'SuperAdmin (RLS + tg_course_enrollments_guard_vocero).';
  COMMENT ON COLUMN public.course_enrollments.vocero_marcado_por IS
    'Quién designó. La fija el trigger con auth.uid(); lo que manda el cliente '
    'se ignora.';

  -- UNO por curso. Índice PARCIAL (mismo patrón que idx_courses_name_per_tenant
  -- y ai_model_settings.is_active): un UNIQUE duro sobre (course_id) sería
  -- absurdo, y sin constraint nada impide 30 "voceros" — con lo que la etiqueta
  -- deja de informar y el filtro pedido se vuelve ruido.
  -- Sirve además como índice de lookup "¿quién es el vocero del curso X?".
  CREATE UNIQUE INDEX IF NOT EXISTS course_enrollments_one_vocero_uidx
    ON public.course_enrollments (course_id)
    WHERE vocero_marcado_at IS NOT NULL;
END $$;

-- ─── Guard de columna ───────────────────────────────────────────────────
-- La RLS de hoy no tiene rama escribible por el dueño, así que un estudiante NO
-- puede auto-marcarse. Pero esa es la ÚNICA barrera: `authenticated` y `anon`
-- tienen INSERT/UPDATE sobre toda la tabla y una columna nueva hereda ese GRANT.
-- Y el roadmap la abre solo: el día que exista `self_signup` (auto-matrícula),
-- course_enrollments gana una rama owner-writable y este flag se vuelve
-- auto-asignable en esa misma migración, sin que nadie relacione las dos cosas.
-- El trigger hace que la autorización de ESTA columna no dependa de la forma de
-- la policy. Congelamos a OLD (no RAISE) — patrón de
-- tg_support_tickets_guard_admin_columns (20261046000000:97).
CREATE OR REPLACE FUNCTION public.tg_course_enrollments_guard_vocero()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_autorizado boolean;
BEGIN
  -- Sin sesión = service_role (que bypassa RLS de todos modos) o anon (al que
  -- ninguna policy de escritura deja pasar). Congelar acá solo crearía un fallo
  -- MUDO en un edge legítimo.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- `is_admin_of_course_tenant` = is_super_admin() OR (Admin AND mismo tenant):
  -- cubre Admin y SuperAdmin en un solo helper.
  v_autorizado := public._teaches_course(NEW.course_id)
               OR public.is_admin_of_course_tenant(NEW.course_id);

  IF TG_OP = 'INSERT' THEN
    IF NEW.vocero_marcado_at IS NOT NULL AND NOT v_autorizado THEN
      NEW.vocero_marcado_at  := NULL;
      NEW.vocero_marcado_por := NULL;
    ELSIF NEW.vocero_marcado_at IS NOT NULL THEN
      NEW.vocero_marcado_por := auth.uid();   -- procedencia no falsificable
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_autorizado THEN
    NEW.vocero_marcado_at  := OLD.vocero_marcado_at;
    NEW.vocero_marcado_por := OLD.vocero_marcado_por;
    RETURN NEW;
  END IF;

  -- `por` es DERIVADO de `at`: no se acepta del payload.
  IF NEW.vocero_marcado_at IS DISTINCT FROM OLD.vocero_marcado_at THEN
    NEW.vocero_marcado_por :=
      CASE WHEN NEW.vocero_marcado_at IS NULL THEN NULL ELSE auth.uid() END;
  ELSE
    NEW.vocero_marcado_por := OLD.vocero_marcado_por;
  END IF;
  RETURN NEW;
END
$function$;

DO $$
BEGIN
  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_course_enrollments_guard_vocero
      ON public.course_enrollments;
    -- No choca con los dos triggers vivos: `trg_course_enrollments_tenant_check`
    -- es BEFORE INSERT OR UPDATE **OF user_id, course_id** (un UPDATE de solo
    -- estas columnas no lo dispara) y `trg_course_enrollment_welcome` es AFTER
    -- **INSERT** (marcar vocero NO re-manda el correo de bienvenida).
    CREATE TRIGGER tg_course_enrollments_guard_vocero
      BEFORE INSERT OR UPDATE ON public.course_enrollments
      FOR EACH ROW EXECUTE FUNCTION public.tg_course_enrollments_guard_vocero();
  END IF;
END $$;

-- ─── RPC: el swap atómico ───────────────────────────────────────────────
-- Existe por el índice parcial: "cambiar de vocero" tiene que ser UNA
-- operación. Si el cliente hiciera el UPDATE crudo para marcar a B mientras A
-- sigue marcado, PostgREST devuelve 23505.
-- `_user_id => NULL` = dejar el curso sin vocero.
CREATE OR REPLACE FUNCTION public.set_course_vocero(
  _course_id uuid,
  _user_id   uuid DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY INVOKER          -- ← A PROPÓSITO. No convertir a DEFINER: la RLS del
 SET search_path TO 'public'  --   caller ES la autorización (ver cabecera).
AS $function$
DECLARE
  v_filas int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Debes iniciar sesión para designar al vocero.';
  END IF;
  IF _course_id IS NULL THEN
    RAISE EXCEPTION 'Falta el curso.';
  END IF;
  -- REGLA UNIVERSAL de papelera: un curso eliminado no es usable en NINGÚN
  -- flujo. course_enrollments no tiene deleted_at ni mira courses.deleted_at,
  -- así que el guard va acá.
  IF public._course_in_papelera(_course_id) THEN
    RAISE EXCEPTION 'Ese curso está en la papelera. Restauralo antes de designar al vocero.';
  END IF;

  -- 1) Liberar la marca vigente (deja el índice parcial libre para el paso 2).
  UPDATE public.course_enrollments
     SET vocero_marcado_at = NULL, vocero_marcado_por = NULL
   WHERE course_id = _course_id
     AND vocero_marcado_at IS NOT NULL
     AND (_user_id IS NULL OR user_id <> _user_id);

  IF _user_id IS NULL THEN
    RETURN;
  END IF;

  -- 2) Marcar al nuevo. Con SECURITY INVOKER, un caller no autorizado no ve la
  --    fila (RLS) → 0 filas → el RAISE de abajo. La autorización es gratis.
  UPDATE public.course_enrollments
     SET vocero_marcado_at = now(), vocero_marcado_por = auth.uid()
   WHERE course_id = _course_id AND user_id = _user_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas = 0 THEN
    -- Mensaje que cubre honestamente los dos casos posibles (no matriculado /
    -- sin permiso) sin filtrar cuál fue.
    RAISE EXCEPTION 'No pudimos designar al vocero: verificá que el estudiante esté matriculado en el curso y que tengas permiso para gestionarlo.';
  END IF;
END
$function$;

-- El `REVOKE ... FROM PUBLIC` NO saca a `anon` en este proyecto (Supabase
-- otorga EXECUTE por ALTER DEFAULT PRIVILEGES, así que la entrada de anon queda
-- en el ACL). Hay que nombrarlo.
REVOKE ALL ON FUNCTION public.set_course_vocero(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_course_vocero(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.set_course_vocero(uuid, uuid) IS
  'Designa (o quita, con _user_id NULL) al vocero de un curso — ETIQUETA '
  'INFORMATIVA, no otorga permisos. Swap atómico: libera la marca vigente y '
  'marca al nuevo. SECURITY INVOKER: autoriza la RLS de course_enrollments '
  '(docente del curso / Admin del tenant / SuperAdmin).';

NOTIFY pgrst, 'reload schema';
```

**Mensaje del índice único** — `src/shared/lib/db-errors.ts`, dentro de `UNIQUE_INDEX_MESSAGES` (sin esto un 23505 cae en el genérico inaccionable "Ya existe un registro con esos datos.", línea 69):

```ts
  // Vocero: uno por curso (índice parcial). Solo alcanzable por PATCH directo o
  // por dos docentes marcando a la vez — la RPC hace el swap.
  course_enrollments_one_vocero_uidx:
    "Ese curso ya tiene un vocero marcado. Quitá el actual o usá la opción “Vocero del curso”.",
```

**`types.ts` no se regenera** (ya está desactualizado: 0 hits de `theme_preference`, `content_file_progress`, `public_token`, y no hay script). Patrón vigente del repo: `(supabase as any)` — precedente en el mismo archivo que vamos a tocar, `app.teacher.students.tsx:152`.

---

## 3. La UI

### 3.1 Marcar / desmarcar — dialogo dedicado, no `AssignSelector`

**Dónde**: nuevo item en el `RowActionsMenu` del grid de cursos, `src/routes/app.admin.courses.tsx` (~línea 2270, inmediatamente **después** de `t("course.students")` y antes de `t("course.teachers")` — grupo "gestión de relaciones" de la convención de orden). Ese componente lo **re-exporta** `src/routes/app.teacher.courses.tsx`, así que un solo cambio cubre **Docente + Admin + SuperAdmin** con contexto de curso inequívoco — y resuelve el bloqueante de que el Admin no puede entrar a `/app/teacher/students` (`rbac.ts:70` no tiene excepción).

```tsx
{
  label: t("vocero.action"),          // "Vocero del curso"
  icon: Mic,
  onClick: () => setVoceroForCourse(c),
},
```

**Nuevo componente**: `src/modules/courses/SetCourseVoceroDialog.tsx`

```tsx
export function SetCourseVoceroDialog({
  course,                                  // { id, name } | null → null = cerrado
  onOpenChange,
  onSaved,                                 // opcional, para refrescar el caller
}: {
  course: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}): JSX.Element
```

**Por qué un diálogo nuevo y NO un slot por fila en `AssignSelector`**: ese componente lo comparten 4 flujos (`app.admin.courses.tsx:3061` y `:3083`, `app.teacher.exams.$examId.tsx:2151`, `app.teacher.projects.tsx:3417`), sus `items` son **todos** los perfiles del tenant (no los matriculados — se ofrecería designar a alguien sin fila que actualizar), y su fila es un `<label>` que envuelve el `Checkbox`: un botón adentro dispararía la activación del label y toggle­aría la matrícula. Tres trampas para ahorrar 120 líneas.

Contenido, con componentes del design system:

- **`<Alert>`** arriba (no `HelpHint`: el punto es que se lea sin hover), con `<Mic className="h-4 w-4" />` + `t("vocero.disclaimer")`.
- **`<Input>`** de búsqueda con ícono `Search` (mismo patrón que `AssignSelector`).
- **`<RadioGroup>`** (`@/components/ui/radio-group`) — la semántica de radio *es* el invariante "uno solo". Primer item `value="__none__"` = `t("vocero.dialogNone")`; después un `<RadioGroupItem>` por **matriculado** con nombre + correo; en el vocero vigente, `<Badge variant="secondary" className="text-3xs">` con `Mic` + `t("vocero.label")` y, debajo, `t("vocero.markedOn", { date: formatDateTime(vocero_marcado_at) })` (`formatDateTime` de `@/shared/lib/format` — nunca `toLocaleString`).
- Lista en `max-h-72 overflow-y-auto rounded-md border p-1`; `<Spinner size="xs">` mientras carga; texto `t("vocero.emptyEnrolled")` con 0 matriculados; `friendlyError` en el `errorText`.
- **`<DialogFooter>`**: `<Button variant="outline">` Cancelar + **un solo** `<Button>` primario Guardar (P4). Se guarda explícito, no al seleccionar: designar al representante es deliberado y el swap borra la designación anterior.
- `<DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">` (igual que el diálogo de matrículas).

Carga (embed permitido acá — la FK es `course_enrollments_user_profile_fk → profiles`, la excepción a la regla de `*.user_id → auth.users`; se nombra la FK para que no haya ambigüedad):

```ts
const { data, error } = await (supabase as any)
  .from("course_enrollments")
  .select(
    "user_id, vocero_marcado_at, " +
      "profiles!course_enrollments_user_profile_fk(full_name, institutional_email)",
  )
  .eq("course_id", course.id)
  .order("vocero_marcado_at", { ascending: false });
```

Con `let cancelled = false` + cleanup en el effect. Si el entorno devolviera `PGRST200`, caer al patrón 2-query (`user_id`s → `profiles.in("id", ids)`).

Guardar:

```ts
const next = sel === "__none__" ? null : sel;
if (actual && next && next !== actual) {
  const ok = await confirm({
    title: t("vocero.replaceConfirmTitle", { course: course.name }),
    description: t("vocero.replaceConfirmBody", { current: nombreActual, next: nombreNuevo }),
    confirmLabel: t("vocero.replaceConfirmLabel"),
    tone: "warning",                       // reversible pero pisa una designación
  });
  if (!ok) return;
}
const { error } = await (supabase as any).rpc("set_course_vocero", {
  _course_id: course.id,
  _user_id: next,
});
if (error) return toast.error(friendlyError(error));
toast.success(next ? t("vocero.saved") : t("vocero.cleared"));
onSaved?.();
onOpenChange(false);
```

**Sin gate de rol activo acá ni en 3.2**: las dos rutas están gateadas por `checkAccess`, que compara contra `activeRole` (`rbac.ts:~104`). `isStaffActive` haría falta solo si la etiqueta apareciera en una ruta compartida con `roles: null` (foros, mensajes) — no en v1.

### 3.2 La etiqueta y el filtro — `src/routes/app.teacher.students.tsx`

**Ojo con el modelo de fila**: `Student` es **una por estudiante agregando todos los cursos del docente**, y guarda **nombres** de curso (`courses: string[]`, líneas 43-49 y 164-172). Entonces "Vocero" acá significa *vocero en alguno de los cursos del alcance activo*, y el badge tiene que nombrar de cuál.

**(a) Datos** — el `select` de matrículas (línea 133) pasa a traer la marca; el resto de la consulta no cambia. La papelera ya está cubierta: `courseIds` sale de `myCourses`, que descarta `deleted_at` en JS (líneas 111-113).

```ts
const { data: enrollments, error: enrErr } = await (supabase as any)
  .from("course_enrollments")
  .select("user_id, course_id, vocero_marcado_at")
  .in("course_id", courseIds);
```

`Student` gana `voceroDe: string[]` (nombres de curso donde está marcado), poblado en el paso 4 junto a `coursesByStudent`.

**(b) Badge** — dentro de la celda de **Nombre** (línea 375), en una **segunda línea** bajo el nombre. No al lado: P7 prohíbe un adorno `shrink-0` compitiendo por ancho con el identificador que trunca. No en la celda "Cursos": es `hidden md:table-cell` y la etiqueta desaparecería en móvil.

```tsx
{voceroEnAlcance.length > 0 && (
  <div className="pt-0.5">
    <Badge variant="secondary" className="text-3xs gap-1"
           title={t("vocero.badgeTitle", { courses: s.voceroDe.join(", ") })}>
      <Mic className="h-3 w-3" />
      {courseFilter !== "all"
        ? t("vocero.label")                                             // el curso ya es el filtro
        : voceroEnAlcance.length === 1
          ? t("vocero.badgeIn", { course: voceroEnAlcance[0] })
          : t("vocero.badgeCount", { count: voceroEnAlcance.length })}
    </Badge>
  </div>
)}
```

**(c) Filtro** — slot `extra` de `ListFilters` (`list-filters.tsx:96-103`, se pinta en `:290` y `onClearExtra` se invoca en el botón Limpiar `:301`). **No** una prop nueva de `ListFilters`: sus 3 selects son una cascada derivada de `courses`, y "vocero" no se deriva de nada de eso. **No** en `course-filter-scope.ts`: ese módulo responde "qué CURSOS entran en el alcance" con el contrato `null ≠ ∅` (líneas 21-31), y vocero es atributo de la FILA.

```tsx
<ListFilters
  …
  extra={<VoceroFilterSelect value={voceroFilter} onChange={setVoceroFilter} />}
  onClearExtra={() => setVoceroFilter(DEFAULT_VOCERO_FILTER)}
/>
```

Dentro del `useMemo` de `filtered` (línea 196) hay que **hoistear el conjunto de nombres visibles** (hoy el alcance y el curso se aplican en dos bloques separados) y filtrar contra él — respetando el flujo obligatorio **filtrar → ordenar → paginar**:

```ts
// Nombres de curso "en juego": el curso elegido si hay uno, si no el alcance
// periodo/asignatura, si no null (= sin acotar).
const nombresVisibles: Set<string> | null =
  courseFilter !== "all"
    ? new Set([courses.find((c) => c.id === courseFilter)?.name ?? ""])
    : scope !== null
      ? nombresEnAlcance
      : null;

if (voceroFilter !== "todos") {
  result = result.filter((s) =>
    matchesVoceroFilter(voceroCoursesInScope(s.voceroDe, nombresVisibles).length > 0, voceroFilter),
  );
}
```

Y **`voceroFilter` va al `resetKey`** de `usePagination` (línea 250), o cambiar el filtro deja al docente en una página que ya no existe:

```ts
resetKey: `${search}|${courseFilter}|${periodFilter ?? ""}|${subjectFilter ?? ""}|${voceroFilter}|${sort.resetKey}`,
```

*Sin `SortableHead` para vocero*: ordenar un booleano solo agrupa, y eso el filtro ya lo hace mejor.

*Limitación precedente y aceptada*: `hasFilters` de `ListFilters` no mira el slot `extra`, así que si el único filtro activo es el de vocero, el botón "Limpiar" no aparece. Es exactamente lo que ya pasa en los 4 grids con `ActivityStatusSelect`, y nada queda inalcanzable (el propio select tiene "Todos"). Si se quiere cerrar: una prop `extraActive?: boolean` OR-eada a `hasFilters` en `list-filters.tsx:180`.

**(d) Acción de fila** — item del `RowActionsMenu` existente (línea 421), **solo con un curso elegido**. `RowActionsMenu` ya filtra items nullish, así que el `&&` es el idioma del repo:

```tsx
courseFilter !== "all" && {
  label: esVoceroDelCurso
    ? t("vocero.actionUnmark", { course: nombreCursoSel })
    : t("vocero.actionMark",   { course: nombreCursoSel }),
  icon: Mic,
  hint: t("vocero.disclaimerShort"),        // "Solo informativo: no cambia permisos ni notas."
  onClick: () => void toggleVocero(s),
  disabled: voceroBusy,
},
```

Con `courseFilter === "all"` el item **no se renderiza**: "marcar vocero" no tiene semántica sobre una fila que agrega 5 cursos, y ofrecerlo dejaría al docente sin saber en qué curso quedó.

`toggleVocero` llama la misma RPC, pide `confirm({ tone: "warning" })` cuando hay que reemplazar (el vocero actual del curso sale de `students[].voceroDe` — **sin consulta extra**), y **actualiza el estado local** en vez de bumpear `retryNonce`: un `load()` completo pone `loading=true` y hace parpadear el skeleton por un toggle de etiqueta.

### 3.3 El texto que deja claro que no da permisos

Va en dos lugares visibles, no escondido en un tooltip (`es.json`):

- **`vocero.disclaimer`** (Alert del diálogo, donde se designa):
  > "Es una **etiqueta informativa**: sirve para saber a quién contactar como representante del curso. No otorga permisos, no da acceso a nada y no afecta notas ni entregas."
- **`vocero.disclaimerShort`** (hint de la acción de fila, y del ítem del menú de cursos):
  > "Solo informativo: no cambia permisos ni notas."

---

## 4. i18n

`src/i18n/locales/es.json` y `en.json` — dos namespaces nuevos de primer nivel. La paridera es↔en la vigilan `locale-parity.test.ts` y `keys-registered.test.ts` (rompen el build).

```jsonc
// es.json
"vocero": {
  "label": "Vocero",
  "action": "Vocero del curso",
  "actionMark": "Marcar como vocero de {{course}}",
  "actionUnmark": "Quitar como vocero de {{course}}",
  "badgeIn": "Vocero · {{course}}",
  "badgeCount_one": "Vocero en {{count}} curso",
  "badgeCount_other": "Vocero en {{count}} cursos",
  "badgeTitle": "Vocero de: {{courses}}",
  "dialogTitle": "Vocero de {{course}}",
  "dialogNone": "Sin vocero",
  "searchPlaceholder": "Buscar estudiante…",
  "markedOn": "Marcado el {{date}}",
  "emptyEnrolled": "Este curso todavía no tiene estudiantes matriculados. Matriculá al grupo antes de designar al vocero.",
  "disclaimer": "Es una etiqueta informativa: sirve para saber a quién contactar como representante del curso. No otorga permisos, no da acceso a nada y no afecta notas ni entregas.",
  "disclaimerShort": "Solo informativo: no cambia permisos ni notas.",
  "replaceConfirmTitle": "¿Reemplazar al vocero de {{course}}?",
  "replaceConfirmBody": "{{current}} deja de estar marcado como vocero y queda {{next}}. Es solo una etiqueta: no cambia permisos ni notas.",
  "replaceConfirmLabel": "Reemplazar",
  "saved": "Vocero actualizado",
  "cleared": "El curso quedó sin vocero"
},
"voceroFilter": {
  "todos": "Todos (vocero o no)",
  "solo": "Solo voceros",
  "sin": "Sin marca de vocero"
}
```

```jsonc
// en.json — "vocero" → "class representative" (consistente en todas las claves)
"vocero": {
  "label": "Representative",
  "action": "Course representative",
  "actionMark": "Mark as representative of {{course}}",
  "actionUnmark": "Remove as representative of {{course}}",
  "badgeIn": "Representative · {{course}}",
  "badgeCount_one": "Representative in {{count}} course",
  "badgeCount_other": "Representative in {{count}} courses",
  "badgeTitle": "Representative of: {{courses}}",
  "dialogTitle": "Representative of {{course}}",
  "dialogNone": "No representative",
  "searchPlaceholder": "Search student…",
  "markedOn": "Marked on {{date}}",
  "emptyEnrolled": "This course has no enrolled students yet. Enroll the group before designating a representative.",
  "disclaimer": "This is an informational label: it tells you who to contact as the course representative. It grants no permissions, gives access to nothing, and does not affect grades or submissions.",
  "disclaimerShort": "Informational only: changes no permissions and no grades.",
  "replaceConfirmTitle": "Replace the representative of {{course}}?",
  "replaceConfirmBody": "{{current}} stops being marked as representative and {{next}} takes over. It is only a label: it changes no permissions and no grades.",
  "replaceConfirmLabel": "Replace",
  "saved": "Representative updated",
  "cleared": "The course now has no representative"
},
"voceroFilter": {
  "todos": "All (representative or not)",
  "solo": "Representatives only",
  "sin": "Not marked as representative"
}
```

Nota de copy: esa pantalla se titula **"Usuarios"** (`teacherStudents.title`, `es.json:2548`), no "Estudiantes" — evitar "el estudiante vocero" ahí.

---

## 5. Tests

### 5.1 Helper puro a extraer — `src/shared/lib/vocero-filter.ts`

Espeja `status-filter.ts` (tipo + array de opciones + default + predicado), y su componente `src/shared/components/VoceroFilterSelect.tsx` espeja `ActivityStatusSelect.tsx` (genera los `SelectItem` desde el array, `SelectTrigger className="w-full sm:w-52"`).

```ts
export type VoceroFilter = "todos" | "solo" | "sin";
export const VOCERO_FILTER_OPTIONS: readonly VoceroFilter[] = ["todos", "solo", "sin"] as const;
export const DEFAULT_VOCERO_FILTER: VoceroFilter = "todos";

/** `esVocero` ya viene resuelto CONTRA EL ALCANCE (ver voceroCoursesInScope). */
export function matchesVoceroFilter(esVocero: boolean, filter: VoceroFilter): boolean;

/**
 * Cursos (por NOMBRE) donde la persona está marcada Y que están en el alcance
 * activo. `scopeNames === null` = sin acotar → devuelve todo `voceroDe`.
 * Existe porque la fila del grid docente agrega TODOS los cursos del docente:
 * sin intersectar, "Solo voceros" con el curso X filtrado mostraría a un alumno
 * que es vocero del curso Y.
 */
export function voceroCoursesInScope(
  voceroDe: readonly string[],
  scopeNames: ReadonlySet<string> | null,
): string[];
```

`src/shared/lib/vocero-filter.test.ts`:
- `matchesVoceroFilter`: 3 filtros × 2 booleanos (`todos` pasa ambos; `solo` solo true; `sin` solo false).
- `voceroCoursesInScope`: `null` → identidad · intersección parcial · intersección vacía → `[]` · `voceroDe` vacío → `[]` · preserva el orden de `voceroDe` · scope vacío (`new Set()`) → `[]` (distinto de `null`, que es el bug clásico).
- `VOCERO_FILTER_OPTIONS` exhaustivo vs el tipo (`satisfies` + assert de longitud), como `ACTIVITY_STATUS_OPTIONS`.

### 5.2 El guardrail que hace durar la decisión — `src/shared/lib/vocero-not-a-permission.test.ts`

Es lo único que sobrevive a los próximos seis meses: `RoleName` es `string` (`roles.ts:31`), así que `isStaffRole(["Vocero"])` **compila** y ningún tipo rompe si alguien mete la etiqueta en el set de staff. Espeja la técnica de `src/shared/lib/date-columns.test.ts` (camina el árbol y grepea call sites) y su docstring debe decir **"si este test falla, el arreglo NO es editar el test"**.

Tres aserciones:

1. **Ningún archivo de la superficie de autorización menciona `vocero`** — lista cerrada, cero falsos positivos:
   `src/shared/lib/rbac.ts`, `src/shared/lib/roles.ts`, `src/shared/lib/module-catalog.ts`, `src/hooks/use-module-visibility.ts`, `src/shared/components/ModuleRouteGuard.tsx`.
2. **En `supabase/migrations/*.sql`**, ninguna línea que diga `vocero` dice también `has_role(`, `USING (`, `WITH CHECK (`, `app_role` o `user_roles` (ignorando comentarios `--`). Con **allowlist vacía a propósito**: si mañana se decide que los compañeros vean al vocero (§6.1), esa policy hace fallar el test y obliga a agregar la entrada con su motivo escrito — que es exactamente la fricción que se quiere.
3. **`vocero.disclaimer` existe en `es.json` y en `en.json`**: el texto de contención es parte del feature, no decoración borrable.

Además: `bun test` cubre solo — sin cambios — `locale-parity` y `keys-registered`. Al cerrar: `bun tsc --noEmit` (EXIT 0; el error de `vite.config.ts` es preexistente) y el agente **`consistencia`** (verifica que `Mic` sea el mismo ícono en badge + acción + filtro, la paridad es↔en y que no se colara "tenant" en texto visible).

---

## 6. Fuera de v1

| Qué | Por qué queda afuera | Camino exacto cuando lo pidan |
|---|---|---|
| **6.1 Que los COMPAÑEROS vean al vocero** | Hoy `enrollments_select_in_tenant` le da al alumno **solo su fila**, y esa migración (`20261071000000`) cerró el roster a propósito. Publicarlo es una decisión de privacidad, no una consecuencia técnica — y UNIAJ tiene escrito lo contrario. | Rama **quirúrgica** en el SELECT: `OR (vocero_marcado_at IS NOT NULL AND public._is_enrolled_in_course(course_id) AND NOT public._course_in_papelera(course_id))`. Ese helper **existe** y es `STABLE SECURITY DEFINER`, así que no re-entra a la RLS de la tabla → **sin la recursión de policy** que ya quemó al proyecto (`20260915000000`). **Jamás** una rama amplia tipo "todo matriculado ve las matrículas de su curso": eso filtra el roster completo. |
| **6.2 Que el propio vocero se vea marcado** | Es gratis en RLS (`user_id = auth.uid()` ya lo deja leer su fila) pero es una superficie más que hay que filtrar por papelera y por `estado`. | Un `<Badge>` en el header del card de curso de `app.student.courses.tsx` (~línea 915, junto a `course.grupo`). Cero cambios de policy. |
| **6.3 Pre-llenar el Acuerdo / actas con el vocero** | Es el pago real del dato (hoy el acta deja nombre/teléfono/email en blanco), pero los 4 cursos UNIAJ 2026-2 dicen textualmente que vocero y firmas **no se transcriben a ningún documento generado: es información privada**. Requiere el OK del dueño. | Exponer `vocero` en `buildReportContext` (`report-context.ts:255-275`, que ya lee `course_enrollments` → `profiles`). **No** modelar el teléfono: sería el dato más sensible del feature y hoy no existe la columna. |
| **6.4 Suplente / N voceros** | 0 hits de "suplente" en `universidades/`, `supabase/` y `src/`: no hay dominio que lo pida, y el acta tiene una sola firma. | Un **segundo** booleano/timestamp con su propio índice parcial (`is_vocero_suplente`). **Nunca** relajar la unicidad del vocero: rompe el acta y vuelve ambiguo el filtro. |
| **6.5 Notificar "fuiste designado vocero"** | Un `kind` nuevo obliga a tocar los TRES lados del invariante (`_notification_kind_emails` SQL + `CRITICAL_KINDS` del edge `send-email` + `notification-email.ts`) más un toggle en `email_settings`. Coste alto para una etiqueta. | — |
| **6.6 Historial de designaciones** | `vocero_marcado_at/por` ya da el "quién y cuándo" del estado actual, que es el 90% del valor. Y **ningún** flujo de contenido del proyecto tiene historial de versiones: sería el primero. | — |
| **6.7 Degradar la etiqueta con `estado ∈ {retirado, aplazado}`** | `studentAccessLevel` bloquea el acceso pero **no desmatricula** (`access-control.ts:35`), así que un vocero que ya no puede entrar sigue figurando. Es una regla de **presentación**, sin migración. | Agregar `estado` al `select` de perfiles (`app.teacher.students.tsx:154`) y pintar el badge `variant="outline"` con un `title` que lo advierta. |
| **6.8 Copiar el vocero al duplicar un curso** | Hoy **no se copia**, por construcción: `doDuplicate` hace `select("user_id")` y `upsert({course_id, user_id})` (`app.admin.courses.tsx:1644-1656`). Y así debe quedarse: el vocero es un cargo de UNA cohorte en UN periodo, elegido por ese grupo — copiarlo designaría en silencio a alguien que nadie eligió. | Dejar un comentario en esa rama para que nadie lo "complete". Si se pidiera: flag opt-in propio, default OFF. |
| **6.9 Ordenar por columna vocero** | Ordenar un booleano solo agrupa, y el filtro ya lo hace mejor y más explícito. | — |
| **6.10 CUALQUIER permiso colgado de la etiqueta** | El día que el vocero necesite *hacer* algo (moderar el foro, subir la entrega del grupo, ver notas del curso), eso es una **capacidad nueva con su propia autorización** — no un `if` sobre este dato. El guardrail de §5.2 es lo que fuerza esa conversación en vez de dejarla pasar en un diff. | — |

---

## Orden de ejecución

1. `supabase/migrations/20261740000000_course_vocero_label.sql` + la entrada en `src/shared/lib/db-errors.ts`.
2. `src/shared/lib/vocero-filter.ts` + `src/shared/lib/vocero-filter.test.ts` + `src/shared/components/VoceroFilterSelect.tsx`.
3. `src/modules/courses/SetCourseVoceroDialog.tsx` + item `Mic` en el `RowActionsMenu` de `src/routes/app.admin.courses.tsx` → cubre Docente, Admin y SuperAdmin.
4. `src/routes/app.teacher.students.tsx`: fetch + badge + filtro en `extra` + acción de fila.
5. Claves en `src/i18n/locales/{es,en}.json`.
6. `src/shared/lib/vocero-not-a-permission.test.ts`.
7. `bun tsc --noEmit` · `bun test` · agente `consistencia`.

**Lo no negociable antes de mergear**: (1) el guardrail de §5.2 en verde, (2) el guard trigger presente — los GRANT de `authenticated` **y `anon`** sobre `course_enrollments` son totales y la RLS es la única barrera, a una migración distraída de volverse owner-writable, (3) la copia de `vocero.disclaimer` visible donde se designa.
