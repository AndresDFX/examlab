# Multitenant — Plan de implementación

Este documento traza el roadmap completo del cambio a multitenant.
Las decisiones de diseño quedaron grabadas en los headers de cada
migración. Acá vas a encontrar el ESTADO actual + el plan que sigue.

## Garantías de seguridad de los datos actuales

Antes de aplicar las migraciones, validamos lo siguiente para que la
data existente NO se rompa:

| Garantía | Cómo se cumple |
|---|---|
| **Idempotencia** | Cada migración usa `IF NOT EXISTS` en columnas/índices y `ON CONFLICT DO NOTHING` en inserts. Re-correrla NO duplica ni rompe. |
| **Backfill exhaustivo** | Para cada tabla: 1) JOIN al parent (cuando aplica); 2) fallback al tenant inicial para filas huérfanas; 3) `ALTER COLUMN SET NOT NULL` solo después de eso. |
| **Sanity check** | Al final de B y C: conteo de filas con `tenant_id IS NULL` en TODAS las tablas NOT NULL. Si encuentra > 0, `RAISE EXCEPTION` y rollback automático. |
| **Validación del tenant inicial** | Fase A verifica que el tenant `examlab` quedó creado antes de continuar. Si falla, las fases B/C/D/E/I rechazan con mensaje claro y rollback. |
| **RLS sin riesgo** | Fase D usa policies RESTRICTIVE adicionales — NO toca las policies existentes. Si rompe algo, basta `DROP POLICY tenant_isolation` para rollback. |
| **Triggers sin breaking change** | Los triggers BEFORE INSERT solo populan `tenant_id` si viene NULL — no interfieren con código existente que ya pasa el valor (caso futuro). |

## Decisiones confirmadas

| Decisión | Valor |
|---|---|
| Modelo de aislamiento | `tenant_id` column en cada tabla (no schema-per-tenant) |
| Relación user ↔ tenant | 1:1 (Superadmin es la excepción global) |
| Identificación del tenant | Subdomain → query param `?tenant=slug` → localStorage |
| Signup | Solo por invitación del Admin del tenant |
| Superadmin scope | Acceso completo a todos los tenants (auditado) |
| Tenant inicial | `slug='examlab'`, `name='ExamLab'` (editable después) |
| Cuotas | Enforcement básico desde día 1 |
| Storage paths | RLS only, sin mover archivos existentes |
| Audit logs | Aislados por tenant |
| Borrar tenant | Solo SUSPEND (status='suspended'), no DELETE |

## Roadmap (fases)

### ✅ Fase A — Fundación (aplicada)
[20260522100000_multitenant_foundation.sql](20260522100000_multitenant_foundation.sql)

- Tabla `tenants` con cuotas + branding + status
- Rol `Superadmin` en enum `app_role`
- Helpers SQL: `current_tenant_id_safe()`, `has_tenant_access()`, `resolve_tenant_by_slug()`
- Tenant inicial "examlab"
- Auditoría automática de mutaciones en `tenants`

### ✅ Fase B — Tablas core con tenant_id (aplicada)
[20260522110000_multitenant_core_tables.sql](20260522110000_multitenant_core_tables.sql)

- `tenant_id` en: profiles, user_roles, courses, exams, workshops, projects
- `user_roles` con CHECK que enforza: Superadmin → tenant_id NULL; resto → NOT NULL
- Trigger BEFORE INSERT que rellena tenant_id desde el actor si no se pasó

### ✅ Fase C — Resto de tablas (aplicada)
[20260522120000_multitenant_remaining_tables.sql](20260522120000_multitenant_remaining_tables.sql)

- DO block iterativo que aplica patrón estándar a ~35 tablas
- Backfill via JOIN al parent cuando aplica (questions←exams, etc.)
- Triggers BEFORE INSERT en las tablas con writes frecuentes del cliente

### ⏳ Fase D — Reescribir RLS (PRÓXIMA SESIÓN)

Por cada tabla con `tenant_id`:
- Agregar `has_tenant_access(tenant_id)` al check existente
- Mantener todas las reglas previas (rol, ownership, etc.) AND-eadas con el check de tenant

Pseudocódigo:
```sql
DROP POLICY xxx_select ON public.tabla;
CREATE POLICY xxx_select ON public.tabla FOR SELECT TO authenticated
  USING (
    has_tenant_access(tabla.tenant_id)
    AND (regla_previa_de_rol_y_ownership)
  );
```

**Riesgo**: alto. Cualquier policy mal escrita bloquea acceso legítimo.
**Estrategia**: por bloque de tabla (auth/courses, exams, workshops, etc.),
con tests manuales tras cada bloque.

### ⏳ Fase E — Singletons → per-tenant

Tablas hoy singleton (UNIQUE INDEX `WHERE true`) pasan a:
- Cambiar UNIQUE INDEX a parcial sobre `(tenant_id)`
- Insertar fila default para cada tenant (al crear tenant + backfill)
- RLS filtra por `has_tenant_access(tenant_id)`

Afectadas:
- `email_settings`
- `code_execution_settings`
- `audit_retention_settings`
- `app_settings`
- `content_brand_config`
- `ai_model_settings`
- `push_config`

### ⏳ Fase F — Cliente

1. Helper `src/lib/tenant.ts`:
   - Detectar subdomain (`uni.examlab.com` → `uni`)
   - Fallback a query param `?tenant=uni`
   - Persistir en localStorage `examlab.active_tenant_slug`
   - RPC `resolve_tenant_by_slug` para validar y traer branding

2. JWT custom claims:
   - Auth Hook (Supabase) que enriquece JWT con `app_metadata.tenant_id`
   - Si no se puede instalar el hook, `current_tenant_id_safe()` ya cae al profile

3. Login flow:
   - Pre-login: aplicar branding del tenant resuelto
   - Validar que el email pertenezca al tenant antes de Supabase login

### ⏳ Fase G — Ruta `/app/superadmin/tenants`

- Listar tenants con filtros (active/suspended/trial)
- Crear tenant (dialog: name, slug, contact_email)
- Editar (cuotas, branding)
- Suspender / reactivar
- "Impersonate" controlado: el Superadmin se mete a un tenant como Admin durante X minutos, todo auditado

### ⏳ Fase H — UI tenant admin

- Reusar AdminUsers pero scoped al tenant del admin
- Envío de invitaciones por email (edge function `invite-tenant-user`)
- Panel de branding (en Settings → Generales) que escribe a `tenants.{logo_url,primary_color,...}`

### ⏳ Fase I — Triggers de cuotas

Triggers BEFORE INSERT en:
- `profiles` → contar users del tenant; rechazar si excede `max_users`
- `courses` → contar courses del tenant; rechazar si excede `max_courses`
- ai_credits: decrementar al usar IA, rechazar si llega a 0

### ⏳ Fase J — Tests y auditoría

- Tests de aislamiento: dos tenants con datos similares, RLS no fuga
- Test del helper `current_tenant_id_safe()` con/sin JWT
- Test de Superadmin viendo todos vs Admin viendo solo el suyo
- Auditoría: revisar todos los `logEvent` para incluir tenant_id implícito

---

## Checklist de validación post-Fases A+B+C

Cuando apliques estas 3 migraciones en QA:

- [ ] **Aplicar las 3 migraciones**: el pipeline las ejecuta automáticamente.
- [ ] **Verificar tenant inicial existe**:
  ```sql
  SELECT id, slug, name, status FROM public.tenants;
  -- Esperado: 1 fila con slug='examlab'
  ```
- [ ] **Verificar tenant_id poblado**:
  ```sql
  SELECT COUNT(*) FILTER (WHERE tenant_id IS NULL) AS sin_tenant,
         COUNT(*) AS total
    FROM public.courses;
  -- sin_tenant debe ser 0
  ```
  Repetir para: profiles, user_roles, exams, workshops, projects, submissions.

- [ ] **Verificar helpers funcionan**:
  ```sql
  SELECT public.current_tenant_id_safe();
  -- Como logueado: tu tenant
  -- Como anon: NULL
  ```

- [ ] **Smoke test funcional**: probar como Admin/Docente/Estudiante
  - Ver tu lista de cursos (RLS antigua sigue activa, tenant_id no se usa para filtrar todavía)
  - Crear un curso nuevo (el trigger debe rellenar tenant_id automáticamente)
  - Aplicar a examen y entregar
  - Asistencia + calificaciones
  - Foro + tutor IA + certificados

- [ ] **Smoke test del INSERT trigger**:
  ```sql
  INSERT INTO public.courses (name, period) VALUES ('Test trigger', '2026-1') RETURNING tenant_id;
  -- tenant_id debe quedar poblado con el tenant del actor
  ```

- [ ] **Verificar audit log de tenant**:
  - El INSERT del tenant inicial DEBE haber dejado un audit_logs (action='tenant.insert')
  - Editar el tenant desde SQL debe registrar `tenant.update`

- [ ] **Promover tu user a Superadmin** (manual desde SQL Editor):
  ```sql
  INSERT INTO public.user_roles (user_id, role, tenant_id)
  VALUES ('<TU_USER_ID>', 'Superadmin', NULL);
  ```
  Verifica que tu user tenga ambos roles (Admin del tenant + Superadmin global).

Si todo OK, vamos con Fase D en la próxima sesión.
