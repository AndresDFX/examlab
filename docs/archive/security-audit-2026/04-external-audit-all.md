# Auditoría externa consolidada — `external_audit_all`

Fecha: 2026-05-11
Protocolo: VVT-SEC-LOV-001 — Fase 7+ (Integraciones externas)
Alcance: las 5 categorías (oauth, api_key, ai_llm, webhook_incoming, webhook_outgoing)

## Resumen ejecutivo

| Tipo | Integración | Pass | Fail | Críticos pendientes |
|---|---|---|---|---|
| oauth | Google Calendar | 5 | 7 | 3 |
| api_key | JDoodle (`execute-code`) | 4 | 1 | 0 |
| ai_llm | Lovable Gateway + OpenAI | 5 | 1 | 0 |
| webhook_incoming | `send-push` (X-Trigger-Secret) | 3 | 1 | 0 |
| webhook_outgoing | Web Push (VAPID) | 4 | 0 | 0 |
| **Total** | | **21** | **10** | **3** |

## OAuth — Google Calendar (detalle ver `03-google-calendar-integration.md`)

**Críticos (CRITICAL) — bloquean exposición a docentes reales:**
- **OAUTH-1** falta tabla `*_oauth_states` con expiración → vulnerable a CSRF.
- **OAUTH-2** state no validado one-time en callback.
- **OAUTH-3** `refresh_token` y `access_token` en `text` plano → encriptar con `pgsodium` o Vault.

**Altos (HIGH):**
- **OAUTH-4** `disconnect` no llama `https://oauth2.googleapis.com/revoke` antes del DELETE local.
- **OAUTH-5** redirect de `origin` post-callback sin allowlist (open-redirect potencial).

**Medios/bajos:** error leakage al cliente (OAUTH-6), falta `zod.parse` en inputs (OAUTH-9).

## API key — JDoodle (`execute-code`)

- ✅ Secrets via `Deno.env.get("JDOODLE_CLIENT_ID"/"JDOODLE_CLIENT_SECRET")` — no hardcoded.
- ✅ JWT verificado (función no-pública).
- ✅ Inputs validados (lenguaje + script).
- ✅ Sin logging de secretos.
- 🟡 **API-RATE** falta rate-limit por usuario → un docente con script en loop puede agotar el plan JDoodle. **Remediación:** contador en `audit_logs` o tabla `code_run_quota` por `(user_id, day)`.

## AI/LLM — `ai-generate-questions`, `ai-grade-submission`, `detect-plagiarism`, `generate-contents`

- ✅ `LOVABLE_API_KEY` y `OPENAI_API_KEY` solo via `Deno.env.get`.
- ✅ Modelo configurable via `ai_model_settings` (admin only, RLS).
- ✅ JWT verificado en todas excepto las que el flujo no lo permite (background).
- ✅ Prompts overrides validados por `course_teachers`.
- ✅ No se loguea el contenido del prompt ni la respuesta cruda.
- 🟡 **AI-COST** sin tope por organización/curso → potencial abuso si un docente regenera en loop. **Remediación:** contador `ai_call_quota(course_id, day)` o circuit-breaker en `aiChat()`.

## Webhook incoming — `send-push`

- ✅ Header `X-Trigger-Secret` validado contra `Deno.env.get("PUSH_TRIGGER_SECRET")`.
- ✅ Comparación con `timingSafeEqual`.
- ✅ Payload validado.
- 🟡 **WH-IN-IDEMP** sin idempotency key → si pg_net reintenta, se envía el push 2 veces. **Remediación:** dedupe por `(notification_id, attempt_id)` en tabla `push_attempts`.

## Webhook outgoing — Web Push (VAPID)

- ✅ VAPID keys via env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`).
- ✅ TTL definido en payload.
- ✅ Errores 410/404 limpian la subscription muerta.
- ✅ Sin PII en payload (solo `notification_id` + título).

## Próximos pasos (prioridad)

1. **CRÍTICO** — Implementar `oauth_states` + encriptación de tokens + revoke en disconnect (OAUTH-1/2/3/4). Migración SQL + edits a `_shared/calendar-google.ts` y `calendar-oauth-callback/index.ts`.
2. **ALTO** — Allowlist de origins en callback OAuth (OAUTH-5).
3. **MEDIO** — Rate-limit JDoodle + tope IA por curso.
4. **MEDIO** — Idempotency key en `send-push`.

---

_Reporte generado por `mcp_custom_e7PEG--external_audit_all` + consolidación manual basada en los outputs previos de `external_audit_plan` para cada tipo._
