# Plan — Módulo financiero + desactivación de tenants por suscripción

> Estado: **propuesta de diseño** (aún no implementado). Documento para revisar y
> aprobar antes de escribir migraciones. Snapshot del modelo actual: 2026-06-13.

## 1. Objetivo

Que el **SuperAdmin** gestione la suscripción mensual de cada institución (tenant) y
que la plataforma **desactive automáticamente** las cuentas de un tenant cuando su
suscripción venza, con un período de gracia parametrizable. El módulo debe mostrar,
por institución:

- **Fecha de inicio** de la suscripción.
- **Fecha de fin** (vencimiento) de la suscripción.
- **Estado** de la suscripción (al día, por vencer, vencida, suspendida, prueba…).
- **Tiempo que lleva suscrita** la institución (antigüedad).
- Plan contratado, cupos, valor mensual y demás info comercial.

La desactivación debe ser **reversible** (extender la fecha de fin reactiva), no un
borrado. El borrado definitivo ya existe (Papelera + `hard_delete_tenant`) y queda
fuera de este flujo.

## 2. Qué ya existe hoy (no reinventar)

| Pieza | Dónde | Sirve para |
|---|---|---|
| `tenants.is_active BOOLEAN` | `20260621000000_tenants_foundation.sql` | Pausar/reactivar manual (ya hay botón "Pausar" en `/app/superadmin/tenants`). |
| `tenants.deleted_at` (soft-delete) | `20260818000000_trash_tenants.sql` | Papelera + purge a 30 días. **Distinto** de desactivar por impago. |
| `soft_delete_tenant()` / `restore_tenant()` | idem | Borrado reversible (Papelera), no suspensión. |
| `hard_delete_tenant()` | `20260905000000` | Borrado físico definitivo (irreversible). |
| Cuotas `max_admins / max_teachers / max_students` | `20260703000000_tenant_user_quotas.sql` | Límites de usuarios por rol; trigger en `user_roles`. |
| `list_active_tenants_public()` | `20260818000000` | El **login** solo lista tenants con `is_active = true AND deleted_at IS NULL`. |
| pg_cron + `cron_job_descriptions` | `20260603104200` + patrón en `20260603080000` | Infra de jobs programados; panel SuperAdmin → "Supabase". |
| RPCs `admin_*_cron_job_*` (SuperAdmin) | `20260825000000` | Pausar/reagendar jobs desde UI. |

**Gap crítico de seguridad actual:** `is_active`/`deleted_at` solo filtran el **dropdown
de login**. Un usuario ya logueado **NO** pierde el acceso cuando su tenant se desactiva
(no hay gate en sesión ni en RLS). Este plan lo cierra.

## 3. Modelo de datos propuesto

### 3.1 Columnas nuevas en `tenants`

```sql
-- Suscripción / facturación
subscription_status      TEXT NOT NULL DEFAULT 'trial'
  CHECK (subscription_status IN
    ('trial','active','past_due','suspended','cancelled','expired')),
plan_tier                TEXT            -- 'esencial' | 'profesional' | 'institucional' | 'custom'
subscription_start_date  DATE            -- inicio del ciclo de vida de la suscripción
subscription_end_date    DATE            -- vencimiento del período pagado (gatillo de desactivación)
billing_cycle            TEXT NOT NULL DEFAULT 'monthly'
  CHECK (billing_cycle IN ('monthly','quarterly','yearly')),
monthly_amount           NUMERIC(12,2)   -- valor mensual acordado (en la moneda del contrato)
currency                 TEXT NOT NULL DEFAULT 'USD'
grace_days               SMALLINT NOT NULL DEFAULT 5
  CHECK (grace_days >= 0 AND grace_days <= 90), -- días de gracia tras el vencimiento
auto_suspend             BOOLEAN NOT NULL DEFAULT TRUE,  -- ¿desactivar al vencer?
suspended_at             TIMESTAMPTZ,    -- cuándo el sistema/SA suspendió
suspended_reason         TEXT,           -- 'subscription_expired' | 'manual' | 'payment_failed' | ...
billing_notes            TEXT,           -- notas internas del SA (no visible al tenant)
billing_contact_email    TEXT            -- a quién avisar de vencimientos
```

**`subscription_status` — semántica de cada estado:**

| Estado | Significado | Acceso de usuarios |
|---|---|---|
| `trial` | Período de prueba (sin pago aún). | Activo. |
| `active` | Al día (pagada, dentro del período). | Activo. |
| `past_due` | Venció pero dentro de la **gracia** (`subscription_end_date < hoy <= +grace_days`). | Activo + **banner de aviso** al Admin. |
| `suspended` | Vencida y pasada la gracia → desactivada por el sistema o por el SA. | **Bloqueado** (no login, no sesión). |
| `cancelled` | El cliente canceló (no renueva). | Activo hasta `subscription_end_date`, luego `expired`. |
| `expired` | Cancelada y ya pasó la fecha de fin. | **Bloqueado.** |

> `is_active` se mantiene como **interruptor manual** del SA (pausa inmediata
> independiente de fechas). El gate de acceso (§5) considera **ambos**: bloquea si
> `is_active = false` **o** `subscription_status IN ('suspended','expired')`.

### 3.2 Campos derivados (no se persisten — se calculan)

- **Antigüedad / tiempo suscrito** = `age(now(), subscription_start_date)` → "1 año 3 meses".
  En UI: `formatDuration`-style en es-CO.
- **Días restantes** = `subscription_end_date - current_date` (negativo = vencida).
- **Estado efectivo**: una función `tenant_subscription_state(tenant)` que recalcula
  `active/past_due/expired` a partir de fechas + gracia, por si el cron no ha corrido aún.

### 3.3 Historial (opcional, fase 2)

Tabla `tenant_subscription_events(id, tenant_id, event_type, from_status, to_status, amount, effective_date, created_by, created_at)` para auditar renovaciones, pagos, suspensiones y reactivaciones. Útil para reportes financieros y para calcular MRR. **No bloqueante para el MVP.**

## 4. Cron de desactivación (SA-parametrizable)

Job diario `tenant-subscription-check-daily` (mismo patrón que `20260603080000`).

- **Cuándo**: `0 6 * * *` (06:00 UTC ≈ 01:00 Colombia, fuera de horas pico).
- **Qué hace** (en SQL, vía función `process_tenant_subscriptions()` SECURITY DEFINER):
  1. **Avisos previos**: tenants con `subscription_end_date` en {7, 3, 1} días → notif
     `kind='system'` + correo al `billing_contact_email` y a los Admins del tenant
     ("tu suscripción vence en N días").
  2. **A gracia**: `subscription_end_date < hoy` y dentro de gracia → `status='past_due'`
     (no bloquea aún; banner de aviso).
  3. **Suspender**: `hoy > subscription_end_date + grace_days` y `auto_suspend=true` →
     `status='suspended'`, `suspended_at=now()`, `suspended_reason='subscription_expired'`.
     Notif/correo de corte de servicio.
  4. **Reactivar**: si el SA extendió `subscription_end_date` a futuro y el estado era
     `suspended/past_due/expired`, el job (o el propio update) lo vuelve a `active`.
- **"Cada X tiempo parametrizable"**: el "X" no es el intervalo del cron (corre a diario),
  sino los parámetros por tenant: `billing_cycle`, `grace_days`, `auto_suspend`, y la
  `subscription_end_date`. El SA define cuánto dura cada ciclo y cuánta gracia hay. El
  SuperAdmin puede además pausar/reagendar el job desde el panel Supabase Cron existente.
- Descripción sembrada en `cron_job_descriptions` para que aparezca en el panel.

## 5. Gate de acceso (cierra el gap de seguridad)

Hoy un usuario logueado no pierde acceso al suspender. Tres capas:

1. **Login** (ya existe, ampliar): `list_active_tenants_public()` ya esconde tenants no
   activos del dropdown. Ampliar el filtro a `subscription_status NOT IN ('suspended','expired')`.
2. **Post-login** (`auth.index.tsx`, validación de tenant): tras `signInWithPassword`,
   si el tenant del usuario está suspendido/expirado → `signOut` + mensaje claro
   ("La suscripción de tu institución está suspendida. Contacta a tu administrador").
3. **En sesión / RLS** (la capa dura): una función `current_tenant_is_active()` SECURITY
   DEFINER (`is_active = true AND subscription_status NOT IN ('suspended','expired') AND deleted_at IS NULL`).
   Opciones de enforcement, de menor a mayor esfuerzo:
   - **Mínimo viable**: un guard en `AppLayout` que, al cargar el perfil, llama un RPC
     `my_tenant_access()` y si está bloqueado muestra una pantalla "Suscripción suspendida"
     + logout. Cubre la UX al instante.
   - **Robusto (recomendado fase 2)**: incluir `current_tenant_is_active()` en las policies
     RLS de las tablas núcleo (o en `current_tenant_id()` haciendo que devuelva NULL si el
     tenant está suspendido → toda query del tenant queda vacía). **Cuidado**: afecta a
     TODAS las tablas; probar bien. El SuperAdmin (`is_super_admin()`) siempre bypassa.

> Recomendación: fase 1 = login + post-login + guard de AppLayout (rápido y suficiente
> para el caso de negocio). Fase 2 = enforcement por RLS si se requiere garantía dura.

## 6. UI SuperAdmin

En `/app/superadmin/tenants`:

- **Grid**: nueva columna **Suscripción** = badge de estado (`StatusBadge`-style:
  active=verde, trial=azul, past_due=ámbar, suspended/expired=rojo) + "vence en N días" /
  "vencida hace N días". Columna **Antigüedad** (tiempo suscrito).
- **Form crear/editar**: sección "Suscripción y facturación" con `plan_tier` (Select),
  `subscription_start_date` + `subscription_end_date` (date pickers), `billing_cycle`,
  `monthly_amount` + `currency`, `grace_days`, `auto_suspend` (switch), `billing_contact_email`,
  `billing_notes`. Botón rápido **"Renovar +1 ciclo"** que suma el `billing_cycle` a la
  fecha de fin y pone `status='active'`.
- **Acción de fila**: "Suspender ahora" / "Reactivar" (además del "Pausar" manual existente).
- **Panel resumen / dashboard SA**: stat "Suscripciones por vencer (≤7 días)" + "Vencidas" +
  (fase 2) MRR estimado = Σ `monthly_amount` de tenants `active`.

## 7. UI Admin del tenant

- **Banner** (cuando `past_due` o faltan ≤7 días): "Tu suscripción vence el DD/MM. Contacta
  a tu proveedor para renovar." (reusar patrón de `TenantOverrideBanner`).
- En su panel: ver estado + fecha de fin (solo lectura). No edita facturación.

## 8. RLS / multi-tenant

- Las columnas nuevas viven en `tenants`. SELECT de `tenants`: el Admin ve su propio tenant
  (puede leer fechas/estado, **no** `billing_notes`/`monthly_amount` → exponer vía una vista
  o RPC que omita campos sensibles para no-SA). UPDATE de facturación: **solo SuperAdmin**.
- Funciona en **todos los tenants** y **cross-tenant**: el SA gestiona cualquier tenant; el
  Admin solo ve el suyo; la lógica de fechas es por-tenant. Nada es global.

## 9. Plan de implementación por fases

1. **Fase 1 — datos + visibilidad (no rompe nada)**
   - Migración: columnas nuevas en `tenants` (todas nullable / con default → backfill
     `subscription_start_date = created_at::date`, `status='active'` para los existentes).
   - UI SA: form + grid (estado, antigüedad, días restantes). Solo lectura/edición manual.
   - **Sin** desactivación automática aún → cero riesgo de cortar a un cliente por error.
2. **Fase 2 — avisos**
   - Cron diario que solo **avisa** (notif + correo) de próximos vencimientos. Validar que
     los avisos llegan bien antes de activar cortes.
3. **Fase 3 — desactivación + gate**
   - Cron pasa a `past_due`/`suspended`. Gate de login + post-login + guard AppLayout.
   - `auto_suspend` por tenant permite activarlo gradualmente (encenderlo tenant por tenant).
4. **Fase 4 (opcional) — historial + MRR + enforcement RLS duro.**

## 10. Defensivas / convenciones del repo

- Toda migración con `ALTER TABLE` envuelta en `DO $$ ... IF to_regclass('public.tenants') IS NOT NULL ...`.
- Fechas visibles → helpers `src/lib/format.ts` (es-CO).
- `CREATE OR REPLACE FUNCTION` que cambie `RETURNS` → `DROP FUNCTION` primero.
- Cron en `extensions.cron.*`; sembrar `cron_job_descriptions`.
- Mensajes de `RAISE EXCEPTION` en español (los muestra `friendlyError`).
- Cualquier RPC nueva: validar `is_super_admin()` para escritura de facturación + audit log.
- Antes de cortar a un tenant: **siempre** reversible vía extender `subscription_end_date`.
