# Plan de implementación — Desactivar usuarios + Reset de contraseña por el Docente

> Diseño producido por workflow multi-agente (5 investigadores + síntesis) sobre el código REAL.
> NO implementado todavía — es un plan para decidir las "decisiones abiertas" antes de codear.
> Base verificada: `tg_check_tenant_user_quota()` / `tenant_user_counts()` (mig `20260703000000`),
> `bulk-set-passwords` (autz por destinatario Docente ya correcta), `studentAccessLevel`
> (`src/modules/auth/access-control.ts`), AppLayout `accessLevel` + `ForceChangePasswordDialog`,
> grid Admin `app.admin.users.tsx`, grid Docente `app.teacher.students.tsx`.

---

## FEATURE 1 — Desactivar / reactivar usuarios (no consume licencia)

### Decisión de modelo (RESUELTA por los hallazgos)
NO reusar `profiles.estado` (es CHECK académico `activo/retirado/graduado/aplazado` y `studentAccessLevel`
**ignora a staff**). Se introduce un flag genérico que aplica a CUALQUIER rol. Unidad de "desactivado" =
`profiles.is_active = false` (espejo en DB) + ban nativo GoTrue (gate real de login).

### 1.1 DB (migración nueva `2026XXXX_user_deactivation.sql`)
Envolver TODO en el guard defensivo `DO $$ BEGIN IF to_regclass('public.profiles') IS NOT NULL THEN … END IF; END $$`.

- `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`.
- `ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ` y `deactivated_by UUID REFERENCES auth.users(id)`.
- Backfill implícito: `DEFAULT true` ya deja a todos activos.
- Índice parcial `CREATE INDEX IF NOT EXISTS idx_profiles_inactive ON profiles(tenant_id) WHERE is_active = false`.
- **Centralizar "licencia ocupada"** en UNA función (hoy duplicada entre trigger y RPC):
  ```sql
  CREATE FUNCTION tenant_role_count(_tenant UUID, _role app_role) RETURNS INT
    LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT COUNT(DISTINCT ur.user_id)::int
        FROM user_roles ur JOIN profiles p ON p.id = ur.user_id
       WHERE ur.role = _role AND p.tenant_id = _tenant
         AND p.is_active = true;            -- ← inactivos NO cuentan
    $$;
  ```
- Reescribir `tg_check_tenant_user_quota()` (mig 20260703000000 L96-100): el `COUNT` inline pasa a
  `tenant_role_count(v_tenant, NEW.role)`. Conserva exención SuperAdmin + rama tenant NULL.
- Reescribir `tenant_user_counts()` (L120-148) para usar `tenant_role_count` → el "X/Y" del card y el gate
  quedan byte-equivalentes.

### 1.2 Edge nueva `admin-set-user-active` (gate real de login + espejo en profiles)
RLS no alcanza `auth.users` → edge con `adminClient` (service_role) + revalidación manual (patrón `admin-delete-user`).
Body `{ userId, active }`. Autz:
- Caller via `userClientFromRequest` + `getUser`; permitidos Admin o SuperAdmin (403 si no).
- **Scope tenant:** Admin → solo si `tenant(target) === tenant(caller)`; SA → cualquiera (patrón de `bulk-set-passwords`).
- **Fail-closed (403):** no auto-desactivarse; no desactivar SuperAdmin; (decisión abierta) Admin no desactiva Admin.
- Desactivar: (1) `auth.admin.updateUserById(userId, { ban_duration: '876000h' })` — rechaza login en GoTrue;
  (2) `profiles.update({ is_active:false, deactivated_at:now(), deactivated_by:caller })`;
  (3) revocar sesiones (`auth.admin.signOut`) — el access token vivo expira solo (documentar latencia).
- Reactivar: `ban_duration:'none'` + `is_active:true` + limpiar `deactivated_*`. **Re-chequear cuota** por rol
  (la reactivación no pasa por el trigger de `user_roles`); si excede → 409 friendly.
- Auditar `user.deactivated`/`user.reactivated` con `auditFromEdge` pasando `tenantId` del **destino**.

### 1.3 Enforcement de login bloqueado
- **Real (ban GoTrue):** `signInWithPassword` falla en `auth.index.tsx`. Mensaje genérico, no enumerar.
- **UX (sesión residual):** en `AppLayout` agregar gate `if (profile?.is_active === false) → pantalla bloqueante
  + Cerrar sesión`, ANTES del check de `accessLevel`. Aplica a todos los roles.
- `use-auth.ts`: `is_active?: boolean` en `Profile`.

### 1.4 Enforcement de licencia
Resuelto en 1.1 (ambos puntos usan `tenant_role_count` que excluye inactivos). `TenantQuotaCard` no cambia.

### 1.5 UI (`app.admin.users.tsx`)
- Badge "Inactivo"; item RowActionsMenu Desactivar (`UserX`, destructive) / Reactivar (`UserCheck`); ocultar para
  SuperAdmin y para el propio caller. `useConfirm` destructive. Filtro Activos/Inactivos/Todos. `friendlyError`.

### 1.6 Casos borde
No auto-desactivar · no SuperAdmin · scope tenant · reactivar re-chequea cuota · **SSO: el ban frena OAuth también**
· logout forzado (token residual expira) · nuevos usuarios nacen activos.

---

## FEATURE 2 — Reset de contraseña por el Docente (solo estudiantes de SUS cursos)

> **Hallazgo central:** la capacidad YA EXISTE en bulk. `supabase/functions/bulk-set-passwords/index.ts`
> (L97-127) autoriza al Docente exactamente por `course_teachers(caller) ∩ course_enrollments` → salta no
> autorizados a `failed[]`, nunca toca al caller, no escribe `admin_visible_passwords`. El front del docente
> ya lo dispara desde `app.teacher.students.tsx` (MultiSelectToolbar → `BulkPasswordDialog`).
> **No hay que crear edge nueva.** El gap es el reset INDIVIDUAL por fila.

NO usar `admin-update-password` (Admin/SA-only + leak cross-tenant sin scope de tenant, L81-95 — deuda aparte).

### 2.1 DB
Ninguna estrictamente requerida. **Opcional (cleanup):** helper `is_student_in_my_courses(_student)` SECURITY
DEFINER (`course_teachers ∩ course_enrollments` con `auth.uid()`) para no dejar el predicado solo en TS.

### 2.2 Edge / autz
Reutilizar `bulk-set-passwords` con `userIds=[unId]` para el reset single. Su rama Docente ya es la autz correcta.

### 2.3 UI (`app.teacher.students.tsx`, ya tiene RowActionsMenu)
Item "Resetear contraseña" (`KeyRound`) → dialog (reusar `BulkPasswordDialog` con un `userId`) con generador +
Switch `requireChange` (default true → `must_change_password`). Feedback éxito/`failed`.

### 2.4 Casos borde
Predicado server-side (no confiar en UI) · nunca al caller · NO escribe `admin_visible_passwords` (el docente
elige y conoce la pass) · **SSO: reset es no-op** (login real por OAuth) — decisión abierta ocultar/dejar ·
auditoría ya cubierta · `must_change_password` preservado.

---

## Pasos de implementación

**Feature 1 (backend → frontend):**
1. Migración: `is_active` + `deactivated_*` + `tenant_role_count` + reescribir trigger y `tenant_user_counts`.
2. Edge `admin-set-user-active` (ban + espejo + revoke sesión + re-chequeo cuota + audit).
3. `use-auth.ts` (`is_active`) + `AppLayout` (gate bloqueante).
4. UI `app.admin.users.tsx` (badge, acciones, confirm, filtro).

**Feature 2 (casi solo frontend):**
5. (Opcional) helper `is_student_in_my_courses`.
6. UI `app.teacher.students.tsx`: item "Resetear contraseña" por fila → `BulkPasswordDialog` con `userIds=[id]`.
7. (Tarea separada) Fix leak cross-tenant de `admin-update-password`.

**Verificación (REST, sin browser):** cuota baja al desactivar / sube al reactivar (409 si lleno); login bloqueado
tras ban; reset docente OK para alumno de su curso, `failed` para alumno ajeno. `bun tsc --noEmit` + `bun test`.

---

## DECISIONES ABIERTAS (requieren tu input antes de implementar)

1. **Gate de login:** ban GoTrue (recomendado, rechaza credenciales server-side) **vs** solo flag + pantalla
   post-login. Plan asume ban.
2. **Staff:** ¿un Admin puede desactivar a otro Admin del tenant, o solo el SuperAdmin? Plan: solo SA.
3. **RLS de `is_active`:** ¿agregar policies RESTRICTIVE (no escribe / no ve) como defensa de la sesión residual,
   o confiar solo en el ban? Plan: no agrega RLS de SELECT (riesgo de romper históricos).
4. **Unidad de licencia:** se mantiene "cupo por rol" (multi-rol ocupa cupo en cada rol). ¿Migrar a "1 usuario =
   1 seat"? Cambio mayor, fuera de alcance salvo que lo pidas.
5. **Reset docente — visibilidad:** el docente elige y conoce la pass (no se persiste). ¿Autogenerar + re-ver
   (paridad `admin_visible_passwords`)? Amplía superficie de seguridad. Plan: no.
6. **SSO:** ¿deshabilitar reset/force-change para identidades SSO-only, o dejar como no-op documentado?
