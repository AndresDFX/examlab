# Plan — Envío de correo por cuenta propia (institución / usuario)

> Estado: **DISEÑO aprobado como plan** (no implementado aún, decisión del usuario 2026-07-14).
> Único cambio ya aplicado: endurecimiento de seguridad (ver §5). Deriva del workflow de
> investigación `email-sender-per-user-refactor`.
>
> **Revisado 2026-07-20**: la sesión de esta fecha NO tocó la arquitectura de envío de
> correo (pipeline `notifications → notify_send_email → send-email → SMTP` intacto; la
> resolución de remitente por institución vía `tenant_email_settings` sigue dormida como se
> describe abajo). El plan continúa **vigente y pendiente de implementación**. Sí se ajustó
> texto de correo/notif indirectamente: "Broadcast"→"Difusión" en la UI de difusión (el
> correo BCC del broadcast usa ese label). Sin otros ajustes de correo requeridos.

## 1. Problema

Todos los correos salen desde **una sola cuenta Gmail compartida**
(`castano.julian@correounivalle.edu.co`, env `SMTP_USER`). Se quiere que cada
**institución** —y opcionalmente cada **usuario/docente**— envíe desde su propia cuenta.

## 2. Cómo funciona hoy (verificado en código + PROD)

- Pipeline: `INSERT public.notifications` → trigger `notify_send_email` (SECURITY DEFINER,
  lee `private.app_settings` global) → `net.http_post` a la edge **`send-email`** → SMTP
  (denomailer). Retry con backoff (3 intentos, solo transitorios 4xx) + cron
  `retry_failed_email_notifications` cada 5 min + `email_suppressions` (rebotes 5.x.x).
- **Resolución del remitente** en `send-email` (`index.ts:481-518`): parte de los env vars
  `SMTP_*`/`EMAIL_FROM` (= la Gmail compartida). Si el **destinatario** tiene `tenant_id` y
  su institución tiene `tenant_email_settings.use_custom_smtp=true` con credenciales
  completas → usa ese SMTP. Se resuelve **por la institución del DESTINATARIO**, no del emisor.
- **Ya existe config por institución**: tabla `tenant_email_settings` (mig `20260959000000`,
  columnas `use_custom_smtp`, `smtp_host/port/user/password`, `email_from`, `email_from_name`)
  + rama cableada en la edge + UI `TenantEmailSettingsDialog` (solo en `/app/superadmin/tenants`).
  **PERO está dormida**: las 4 instituciones en PROD tienen `use_custom_smtp=false` → todo cae
  al env global.
- **NO existe** ninguna config por usuario.
- Los edges `request-email-change` / `confirm-email-change` **ignoran** la config por
  institución: siempre usan el env global.

## 3. Factibilidad / veredicto

- **Por institución**: viable y de alto ROI — la infra ya existe, solo hay que activarla y
  darle UI al Admin. La institución es dueña de su dominio (puede publicar SPF/DKIM/DMARC o
  usar un ESP), así que su `From` propio no cae en spam.
- **Por usuario**: técnicamente posible pero **de nicho**. Enviar "como" el correo del usuario
  por un relay ajeno **rompe SPF/DKIM/DMARC → spam/rechazo** y quema la reputación del dominio.
  Solo seguro si el usuario usa el SMTP de **su propio proveedor** con `From` = su cuenta
  autenticada (ej. Gmail + **App Password**), con verificación previa y anti-spoof.

## 4. Diseño recomendado (2 fases)

**Resolver central** `supabase/functions/_shared/smtp-resolver.ts`: `resolveSmtp({ senderId,
recipientTenantId })` → jerarquía **usuario → institución → plataforma**, evaluada por el
**ACTOR** (no el destinatario), con **degradación** al nivel superior si el nivel elegido
falla auth (para no perder la notificación). Todos los edges de correo lo usan.

### Fase 1 — por institución (bajo riesgo, ~2-4 días)
- Panel **Admin** en `/app/admin` para editar el SMTP de SU institución (la RLS ya lo permite;
  hoy solo el SuperAdmin tiene UI). Reutilizar/refactorizar `TenantEmailSettingsDialog`.
- Botón **"enviar correo de prueba"** que autentica contra el SMTP antes de permitir activar
  (`verified_at`). Nueva edge/modo `send-test-email`.
- **Secreto write-only**: dejar de hacer `SELECT smtp_password` + precargarlo en el form
  (hoy la contraseña vuelve al cliente). Servir config por RPC `SECURITY DEFINER` que excluye
  la contraseña (+ `has_password`); escribir por RPC que solo toca la contraseña si se manda una nueva.
- Migrar `send-email` + `request/confirm-email-change` al resolver central.
- Columnas nuevas en `tenant_email_settings`: `verified_at`, `last_verify_error`.

### Fase 2 — por usuario (opt-in, ~1-2 semanas)
- Tabla `user_email_settings` (PK `user_id`, RLS **owner-only** `auth.uid()=user_id`, secreto
  write-only, `verified_at`). Columna `notifications.sender_id` + backfill + poblarla en los
  flujos con actor (grade/feedback/broadcast; exam/attendance/course_welcome quedan "sistema").
- **Anti-spoof**: validar server-side que `email_from` = `smtp_user` (o mismo dominio verificado).
- Alternativa si una institución no quiere N cuentas: `From` institucional + **Reply-To del
  docente** + nombre "Docente vía Institución" (identidad sin romper alineación DMARC).

## 5. Seguridad (aplica rls-self-tamper-class)

- ✅ **Aplicado** (mig `20261140000000`): `REVOKE anon` sobre `tenant_email_settings` (tenía
  GRANTs completos a `anon`; solo la RLS lo tapaba). `authenticated` reducido a lo mínimo.
- Pendiente en la implementación: secreto **write-only** (no devolver `smtp_password` al cliente),
  cifrado en reposo (Vault/pgcrypto — deuda documentada), RLS owner-only en `user_email_settings`,
  edges leen credenciales solo por `service_role`, anti-spoof del `From`.

## 6. Riesgos a tener presentes

- **Entregabilidad (el mayor)**: `From` de un dominio sin SPF/DKIM alineado al relay → spam.
- **Cuota Gmail personal** (~500 dest/día) + throttling 421/454 — repartir por cuenta mitiga
  el 421 compartido que ya sufrimos, pero un docente con cursos grandes puede agotar su cuenta.
- **Fallback obligatorio**: si el nivel usuario/institución falla auth, degradar a plataforma.
- **Verificación previa** (`verified_at`): sin "enviar prueba", un SMTP mal configurado deja
  a la institución/usuario sin correos silenciosamente.
- **Consistencia entre edges**: sin el resolver central, los correos de cambio de email
  seguirían saliendo de la Gmail global.

## 7. Prerrequisito operativo

Antes de prometer "From institucional", confirmar con el IT de cada institución que puede
publicar **SPF/DKIM/DMARC** en su dominio (o usar el SMTP de su propio proveedor / un ESP).

## 8. Aclaración técnica — ¿una cuenta puede enviar "como" otro dominio?

**Pregunta**: con la app de Google creada bajo `@correounivalle.edu.co`, ¿se puede hacer que
salgan correos con el dominio de otra institución (ej. `@lanuevaamerica.edu.co`)?

**Respuesta: NO** (no por sí sola). Dos muros independientes:

1. **Autenticación/propiedad**: una "app" de Google (proyecto Cloud / cliente OAuth) es solo
   credenciales de API — **no define el remitente**. El remitente = la **cuenta que autentica**
   (App Password u OAuth token), no el dueño de la app. Google solo deja enviar como una
   dirección que la cuenta autenticada **posee** (o un alias "enviar como" ya verificado). Las
   credenciales de correounivalle autentican como correounivalle. Enviar como `@lanuevaamerica`
   requiere autorización **del lado de lanuevaamerica**: sus propias credenciales SMTP/App
   Password, o consentimiento OAuth de un usuario suyo, o domain-wide delegation de su admin de
   Workspace. Que la app sea tuya es irrelevante.
2. **Entregabilidad (SPF/DKIM/DMARC)**: aunque forzaras el `From`, el receptor valida contra el
   **DNS de lanuevaamerica**. Enviando por correounivalle/Google: SPF no lista ese emisor, DKIM
   firma con `d=correounivalle` (no alinea), DMARC de lanuevaamerica → cuarentena/rechazo. Solo
   el DNS de lanuevaamerica puede autorizar el emisor; desde correounivalle no se arregla =
   spoofing → spam.

**Corolario para el diseño**: el dominio del remitente lo determina **quién autentica + qué DNS
lo respalda**, no quién creó la app. Por eso la Fase 1 es que **cada institución cargue SU PROPIA
cuenta** (`tenant_email_settings`), no reutilizar la cuenta de la plataforma. Alternativa sin
credenciales de cada institución: `From` verificado propio + `Reply-To` = correo de la
institución/docente (sin spoofear). El modelo "app OAuth multi-dominio" existe (cada usuario/
dominio consiente), pero requiere revisión de la app OAuth por Google (scopes sensibles).
