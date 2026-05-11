# Re-auditoría de código — secrets + frontend auth

**Fecha:** 2026-05-11 (segunda corrida)
**Comando:** `code_audit_all_low`

## Resumen

| Bloque             | Pass | Fail | Skipped |
| ------------------ | ---: | ---: | ------: |
| Secrets (14)       |   13 |    1 | 0       |
| Frontend auth (11) |    8 |    2 | 1       |
| **Total (25)**     | **21** | **3** | **1** |

Mismos hallazgos que el reporte 05. Se aplicaron las dos correcciones triviales:

## Cambios aplicados

### ✅ SEC-12 — `.gitignore` blindado
Agregado al final de `.gitignore`:
```
.env
.env.*
!.env.example
```

### ✅ AUTH-8 — `signOut()` limpia sessionStorage
`src/hooks/use-auth.ts` ahora hace `sessionStorage.clear()` antes del `window.location.href`.
(No se invocó `queryClient.clear()` porque el router no expone una instancia compartida — el full reload sigue siendo la red de seguridad principal.)

## Pendiente menor

### 🟠 AUTH-3 — Falta `<RequireAuth>` extraído
El gating sigue inline en `AppLayout.tsx` L369/397. Funciona; refactor opcional para mantenibilidad.

## Edge functions desplegadas (12)
admin-update-password, ai-generate-questions, ai-grade-submission, bulk-import-users, calendar, calendar-ics, calendar-oauth-callback, detect-plagiarism, evaluate-exam-time, execute-code, generate-contents, send-push.

## Migraciones
Todas las migraciones del directorio `supabase/migrations/` ya están aplicadas (Lovable las ejecuta en cada Publish). Última: `20260514110000_legacy_unique_case_insensitive.sql`.
