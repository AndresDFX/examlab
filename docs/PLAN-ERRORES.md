# Plan vivo de errores — ExamLab

> Documento de seguimiento de la revisión sistemática de bugs. **Propósito**: registrar
> hallazgos verificados por módulo/rol, su estado (fixeado / pendiente / descartado) y
> cómo seguir. Se actualiza en cada ronda de revisión.
>
> **Metodología**: workflow `find→verify` adversarial por módulo (finders leen el código
> real; cada hallazgo se verifica contra el data-path completo, default = refutar, solo
> se confirma lo reproducible). Los fixes se aplican con `tsc` EXIT=0 + tests dirigidos +
> migraciones verificadas en tx rolled-back y aplicadas live a prod (`docker/restore.env`).
>
> **Última actualización**: 2026-07-04 (rondas 1-2 cerradas; ronda 3 en curso).

---

## Estado de `audit_logs` (prod) — 2026-07-04

Sin errores accionables nuevos en 48h. Lo registrado es stale o normal:

| acción | n | estado |
|---|---|---|
| `user.bulk_password_reset_failed` | 60 | **Stale** — lote FESNA pre-fix ("Database error loading user"). 0 tokens NULL restantes tras mig `20261049`; un reintento del docente funcionaría. |
| `user.bulk_import_row_failed` | 56 | **Stale** — import FESNA pre-fix (`personal_email=''`), resuelto por mig `20261040`. |
| `email.failed` (421) | 17 | **Infra transitoria** — Gmail "Temporary System Problem". No es bug de código. (Mejora futura: retry con backoff en 4xx/5xx transitorios.) |
| `course.deleted`, `user.password_changed` | 1 c/u | Operaciones normales auditadas. |

**Regla**: revisar `audit_logs WHERE severity IN ('error','warning')` en cada ronda para
detectar bugs que solo aparecen en runtime (no en lectura de código).

---

## Ronda 1 — ✅ CERRADA (22 bugs, 5 commits)

Workflow `w37inulmk` (13 módulos) + validación `w1ouuwc0j` (22/22 RESOLVED tras refix M6).

| commit | bugs |
|---|---|
| `f1369242` | edges: calendar-ics, student-calendar-ics, detect-plagiarism, ai-generate-report |
| `8e7bdc10` | certificados (tenant scope + matrícula), video_views, support_tickets (trigger anti-tamper) |
| `4b653c8d` | Papelera: OpenFeedbackModal oculta threads de entidades en papelera |
| `23223036` | RLS `has_role` sin scope: 7 tablas (leak REAL en `ai_override_activations`) |
| `1343d248` | RPCs SECURITY DEFINER: `system_*`/`tenant_role_count` REVOKE, `count_ai_errors_*` scope |
| `2c1f9c78`,`f8bcba62` | funcionales: FINAL_FOR_REGRADE, nota final estudiante, timer poll add_time, snippets multi-file, pizarra imágenes, mensajes dead-end, signOut scope, FraudPanel, override rol, reset error, papelera restore, fechas UTC |
| `8d13d298`,`9f1f45aa`,`6ef622b9` | edges (python `#`, tutor tenant, calendar guard, bulk import tenantId) + migraciones (cert link, voto atómico, tenant_user_counts, humanizar tags, code_executions) + refix M6 |

---

## Ronda 2 — ✅ CERRADA (3 HIGH + 14 pendientes, 3 commits)

Workflow `wq81qewnn` (10 módulos) → 18 confirmados (0 critical, 3 HIGH, 8 med, 7 low).
Validación `w7ybkai3e` (9/14 por workflow, 0 problemas; 3 migs por DB + M9/M7 self-verify).

| commit | bugs |
|---|---|
| `16363496` | **3 HIGH**: re-calificación async con respuestas viejas (enqueue refresh body) · branding de certificado de otro tenant (`resolve_certificate_settings` scope) · sync offline pisa respuestas nuevas (`__saved_at`) |
| `719cf64c` | cliente: tiempo extra en realtime del examen · bypass proctoring tras reload · `visibilitychange` · filtro periodo académico · estudiantes únicos dedup · `{{aprobado}}` informes · push cleanup logout · "0/max" async · PDF /verify · cierre manual foros programados · guard opciones Kahoot (cliente) |
| `cdfdbb0b` | migraciones: cascade cierra foros programados · gracia TOTP simétrica check-in · guard server-side opciones Kahoot |

**Descartado (L#13)**: comentario obsoleto sobre `last_activity_at` en migración inmutable
`20260520100000_forum.sql` — no es bug funcional (desajuste de doc); el "bump on edit" es
decisión de producto, no corrección.

---

## Ronda 3 — 🔄 EN CURSO (workflow `wyjc0fh78`)

Módulos transversales aún no cubiertos a fondo: cron/tareas programadas · pipeline de email ·
ciclo de vida de storage · suscripciones realtime · trabajo en grupo · actividades externas ·
duplicar/clonar · import/export · videos+gate · i18n/hydration.

_(Se completa al terminar el workflow: hallazgos confirmados + estado.)_

---

## Cómo seguir

1. **Cada ronda**: (a) revisar `audit_logs` de prod; (b) lanzar workflow `find→verify` sobre
   los módulos que falten o los recién tocados; (c) fixear críticos/altos de inmediato,
   presentar medios/bajos para aprobación; (d) validación de completitud adversarial; (e)
   actualizar este doc.
2. **Prioridad**: `critical`/`high` (pérdida de datos, nota/cert incorrecto, crash, seguridad)
   se solucionan sin esperar aprobación; `medium`/`low` se listan aquí y se resuelven por lote.
3. **Cierre a prod**: migraciones DB ya se aplican live; cliente/edge requieren **Publish** en Lovable.

## Backlog / mejoras (no bugs)
- Retry con backoff para `email.failed` transitorios (421/4xx/5xx) en `send-email`.
- Cleanup de archivos de Storage al purgar la Papelera (huérfanos — TODO v2 conocido).
