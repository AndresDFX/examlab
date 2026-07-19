# Plan de migración — Correos administrados por nosotros

> Estado: borrador. **No ejecutar sin aprobación**. Cada fase es independiente y se puede pausar entre fases sin romper el sistema.

## Por qué este plan

Hoy el envío de correos tiene tres problemas:

1. **Dependencia de Supabase Auth**: cambio de email (`auth.updateUser({ email })`) dispara un correo que sale del SMTP configurado en el dashboard de Supabase Auth, que es opaco para nosotros (no hay logs ni audit).
2. **Bug de renderizado**: el subject con caracteres no-ASCII se codifica con RFC 2047 encoded-word y `denomailer 1.6.0` lo parte de forma incorrecta cuando supera 75 bytes — algunos clientes muestran headers crudos y el cuerpo MIME sin decodificar (caso real reportado 2026-05-19).
3. **Proveedor frágil**: Gmail SMTP tope 500/día por cuenta, sin webhooks de bounce, sin DKIM propio, deliverability impredecible en Outlook corporativo (`reply-to` apunta a Gmail personal).

## Inventario actual de flujos (8 caminos)

| # | Evento                                                | Disparador                            | Sale por                                  | Recipiente                                |
| - | ----------------------------------------------------- | ------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| 1 | Password reset (solicitar)                            | edge `request-password-reset`         | trigger SQL → `send-email` (denomailer)   | `profiles.institutional_email`            |
| 2 | Cambio de email (perfil)                              | front `auth.updateUser({email})`      | **Supabase Auth SMTP** (sin control)      | nuevo email                               |
| 3 | Cambio de contraseña (logged-in)                      | front `auth.updateUser({password})`   | **Supabase Auth SMTP** (opcional)         | `auth.users.email`                        |
| 4 | Notificación de nota / feedback                       | trigger `notify_send_email`           | `send-email` via pg_net                   | `profiles.institutional_email + personal` |
| 5 | Notificación de examen publicado / ventana abierta    | trigger `notify_send_email`           | `send-email`                              | mismo que 4                               |
| 6 | Recordatorios taller/proyecto due-soon                | pg_cron → función SQL                 | `send-email`                              | mismo que 4                               |
| 7 | Broadcast a curso                                     | edge `broadcast-course-message`       | **SMTPClient directo** (denomailer)       | BCC a todos los inscritos                 |
| 8 | Mensaje directo 1-a-1                                 | trigger `notify_send_email` (con rate limit) | `send-email`                       | destinatario del mensaje                  |

**Helpers compartidos**: `send-email/index.ts` (núcleo) + `_shared/audit.ts` (audit logs categoría `email`).

**Lo que ya controlamos**: 6 de 8 flujos pasan por `SMTP_*` env vars que apuntan al Gmail del admin. Solo (2) y (3) escapan del control.

---

## Fase 0 — Decisión de proveedor

Tres candidatos serios. Decisión bloqueante para Fase 1.

| Proveedor      | Costo aprox.                    | Ventajas                                         | Desventajas                                |
| -------------- | ------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| **AWS SES**    | $0.10 / 1 000 emails            | barato, escalable, IAM, webhooks SNS de bounce   | requiere DNS (SPF+DKIM+DMARC), 24h sandbox |
| **Resend**     | $20/mes hasta 50 000            | API limpia, dashboard moderno, React Email       | más caro a volumen, lock-in del template   |
| **Brevo (ex SendinBlue)** | gratis hasta 300/día | UI, segmentación, fácil onboarding               | límite diario, ventana de soporte limitada |

**Recomendación**: **AWS SES**. Ya tenemos cuenta AWS para el Lambda runner, mismo IAM, sin nueva factura. La pega del DNS se paga una vez.

**Si se prefiere zero-DNS**: Resend (al precio).

## Fase 1 — Reemplazar Gmail SMTP por el nuevo provider (1 día)

Estrategia: **mantener la interfaz SMTP** del lado del código y solo cambiar las env vars + DNS. Cero refactor de aplicación.

**Pasos:**
1. Crear identidad en SES (dominio o email). Verificar via DNS records (TXT _amazonses).
2. Configurar **SPF**: agregar `v=spf1 include:amazonses.com -all` al TXT del dominio.
3. Configurar **DKIM**: copiar los 3 CNAMEs que da SES y publicarlos.
4. Configurar **DMARC**: TXT `_dmarc.dominio` con `v=DMARC1; p=none; rua=mailto:dmarc@dominio` (modo report-only al principio).
5. Solicitar **salir del sandbox de SES** (formulario ~24h): permite mandar a cualquier address, no solo a verificados.
6. Crear credenciales SMTP de SES (IAM user con permisos `ses:SendEmail`).
7. Actualizar Edge Function Secrets:
   - `SMTP_HOST` → `email-smtp.us-east-1.amazonaws.com`
   - `SMTP_PORT` → `587`
   - `SMTP_USER` → IAM SMTP username
   - `SMTP_PASSWORD` → IAM SMTP password
   - `EMAIL_FROM` → email del dominio verificado (NO el correo personal del admin)
   - `EMAIL_FROM_NAME` → `ExamLab`
8. Mandar 5 correos de prueba a Gmail, Outlook, correo institucional, etc. Verificar headers `Received-SPF: pass`, `Authentication-Results: dkim=pass`.
9. Warm-up: enviar lentamente las primeras 1 000 unidades durante 3–5 días para construir reputación del dominio (evita caer en spam en Outlook).

**Riesgo si se omite el warm-up**: deliverability < 50% la primera semana mientras los filtros de spam aprenden el dominio.

**Reversible**: si algo falla, revertir los Edge Function Secrets a Gmail vía la consola.

## Fase 2 — Migrar el cambio de email fuera de Supabase Auth (½ día)

Quitar la dependencia del SMTP opaco de Supabase Auth para el flujo (2) "cambiar mi correo".

**Diseño:**
1. Nueva tabla `email_change_tokens(user_id, new_email, token, expires_at, used_at)` con TTL 1h, RLS solo owner.
2. Edge function nueva `request-email-change`:
   - Recibe `{ newEmail }`, autenticada por JWT del usuario.
   - Valida formato + dominio permitido.
   - Genera token (32 bytes random).
   - Inserta fila en `email_change_tokens`.
   - **Inserta `notifications(kind='system', link='/auth/confirm-email-change?token=...')`** → el trigger ya existente `notify_send_email` la pasa por `send-email`. Cero código de SMTP nuevo.
3. Ruta front nueva `/auth/confirm-email-change`: lee token de la URL, llama edge `confirm-email-change` que valida y ejecuta `auth.admin.updateUserById({ email: newEmail })`.
4. Cambiar `EditProfileDialog` para llamar `request-email-change` en vez de `supabase.auth.updateUser({email})`.

**Beneficio:** el correo de confirmación sale por nuestro pipeline (con audit, con DKIM propio, con observabilidad). Patrón ya probado con `request-password-reset`.

**Lo mismo aplica a (3) "cambiar contraseña"** si queremos quitar el correo opcional de Supabase Auth — pero es bajo prioridad porque (3) **no manda correo por default** (solo si está activado en el dashboard).

## Fase 3 — Centralizar el SMTP en un único helper (½ día)

Hoy `broadcast-course-message` duplica el `SMTPClient` y reimplementa render HTML. Refactor:

1. Crear `supabase/functions/_shared/email-provider.ts` con:
   - `sendEmail({ to, subject, html, text, headers, replyTo })` → encapsula `SMTPClient`.
   - Sanitización de subject (RFC 2047 compliance) — fix del bug de renderizado a fondo.
   - Switch interno por env `EMAIL_PROVIDER` (`smtp` | `ses-api` | `resend`) para que un día podamos mover a HTTP API sin tocar callers.
2. `send-email/index.ts` reemplaza su bloque de `new SMTPClient(...)` por una llamada al helper.
3. `broadcast-course-message/index.ts` igual.

**Ganancia adicional**: arregla el bug del subject (Fase 0 del bug) de forma centralizada en lugar de un parche solo en `send-email`.

## Fase 4 — Observabilidad y bounce handling (opcional, ½ día)

Cuando SES rebota un correo (mailbox lleno, dominio inexistente, spam-flag), avisa por SNS topic. Sin esto, seguimos mandando a un email muerto.

1. Crear SNS topic `examlab-email-bounces`.
2. Configurar SES configuration set que publica bounces/complaints al topic.
3. Edge function `handle-email-bounce` suscrita al topic (HTTPS endpoint) que:
   - Marca `profiles.email_bounced_at` con la razón.
   - El siguiente `send-email` ve el flag y skip-ea con razón `recipient_bounced`.
4. UI admin: card en Configuración listando emails rebotados para que el admin contacte al usuario por otra vía.

**Métricas que se desbloquean**: deliverability rate por kind, top bounced domains, complaint rate (clave para no perder reputación con Microsoft).

---

## Orden recomendado y tiempo total

```
Fase 0 (decisión)         → 15 min de conversación
Fase 1 (provider + DNS)   → 1 día con espera de propagación DNS
                            + 5 días de warm-up en background
Fase 2 (email change)     → ½ día
Fase 3 (centralización)   → ½ día (puede ir antes o después de Fase 2)
Fase 4 (bounces)          → ½ día (opcional, hacerlo cuando tengamos
                            volumen real)
─────────────────────────
Total: ~2.5 días de trabajo activo + 5 días de warm-up.
```

## Lo que NO cambia

- El modelo de `notifications` sigue siendo la fuente de verdad: insertar fila ⇒ correo (si aplica).
- El audit log `category='email'` sigue igual.
- Los triggers SQL y pg_cron jobs no se tocan.
- La preferencia "no quiero recibir correos" del usuario sigue funcionando idéntico.

## Lo que SÍ cambia visible al usuario final

- El "From" deja de ser `castano.julian@correounivalle.edu.co` y pasa a `notifications@examlab.tudominio.com` (o el dominio que se elija).
- El "Reply-To" deja de apuntar a Gmail personal — se decide entre: (a) `no-reply@dominio` con respuesta auto-cerrada, o (b) un buzón monitoreado por admin.
- La deliverability mejora visiblemente en Outlook corporativo (clientes universitarios).
- El subject deja de romper con caracteres especiales (fix de Fase 3, anticipado en parche actual de Fase 0).

## Decisiones pendientes que necesito de ti

1. **Proveedor**: ¿AWS SES (recomendado) o Resend (sin DNS)?
2. **Dominio remitente**: ¿hay un dominio propio para ExamLab (`examlab.com`, `examlab.edu.co`, etc.) o usamos un subdominio del dominio actual?
3. **Reply-To**: ¿no-reply estricto o buzón monitoreado por admin?
4. **Orden**: ¿Fase 2 (email change) antes o después de Fase 1 (provider)? Recomiendo después — el flujo de email change se beneficia de tener ya el provider robusto.
