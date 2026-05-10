# Auditoría de seguridad — examlab · Resumen ejecutivo

| Documento | Auditoría preliminar VVT-SEC-LOV-001 |
|-----------|--------------------------------------|
| **Auditor** | Vivetori SAS |
| **Cliente** | examlab — sistema LMS / examen online |
| **Fecha** | 2026-05-10 |
| **Stack auditado** | Lovable (React + Vite) + Supabase (Postgres + Edge Functions + Storage) |
| **Modo** | Auditoría estática del repo + probe vía PostgREST con `anon_key`. **Pendiente**: validación contra producción con PAT (sin éste, las policies del repo se asumen aplicadas; cualquier policy editada por dashboard queda fuera del alcance). |
| **Estado del proyecto** | Pre-producción — base sin datos reales todavía. Es el momento ideal para remediar antes de cargar usuarios. |

---

## Estado general

**Semáforo: 🟠 AMARILLO con un componente 🔴 ROJO inmediato**

El proyecto tiene una arquitectura razonable (RLS habilitada en todas las tablas, tabla `user_roles` separada con función `has_role` `SECURITY DEFINER`, aislamiento de Storage por `auth.uid()`, separación admin/docente/estudiante con enum). **No es un Lovable abandonado**.

Sin embargo, hay un **incidente activo** (credenciales hardcoded en repo) y dos **fallas estructurales en RLS** que rompen la integridad del producto principal (preguntas y exámenes visibles para estudiantes antes de tomarlos). Estos tres bloquean producción.

---

## Top 5 riesgos abiertos

| # | Hallazgo | Impacto | Severidad |
|---|----------|---------|-----------|
| **1** | **Master credentials hardcoded en `seed-data` Edge Function** | Cualquier persona con acceso al repo (incluso histórico vía `git log`) tiene `andres_dfx@hotmail.com / Tester#12345`. La función además es ejecutable sin auth → cualquiera puede invocar el seeding y resetear/crear usuarios demo con passwords conocidas. | 🔴 CRÍTICO |
| **2** | **Estudiantes pueden leer todas las preguntas de todos los exámenes** | `questions` y `exams` tienen policy `SELECT TO authenticated USING (true)`. Un estudiante autenticado puede `SELECT * FROM questions` y ver el banco completo, incluyendo preguntas de exámenes futuros aún no abiertos. **Anula la integridad del producto.** | 🔴 CRÍTICO |
| **3** | **Edge Functions de IA (`ai-generate-questions`, `ai-grade-submission`) sin verify_jwt al inicio** | Un atacante anónimo puede invocar las funciones y consumir el presupuesto de OpenAI/Anthropic/Gemini. DoS económico — apaga la cuenta cuando la cuota se agota. | 🔴 CRÍTICO |
| **4** | **Audit logs envenenables** | `audit_logs` con `INSERT WITH CHECK (true)` permite a cualquier authenticated insertar entradas con `actor_id` falsificado. Anula la trazabilidad: no se puede confiar en el log para investigaciones de incidentes. | 🟠 ALTO |
| **5** | **PII de admins/docentes/estudiantes accesible para todos los authenticated** | `profiles SELECT TO authenticated USING (true)` expone `personal_email` e `institutional_email`. Material para phishing targeted contra el cuerpo docente. | 🟠 ALTO |

---

## Decisión Go / No-Go para producción

### 🛑 NO-GO

El proyecto **no debe abrirse a usuarios reales** mientras estos tres ítems no estén resueltos:

| Bloqueante | Criterio de cierre |
|------------|--------------------|
| **B1** — Master password rotada y sacada del repo | Password de `andres_dfx@hotmail.com` rotado en Supabase; secret eliminado del código fuente; histórico git limpiado con `git filter-repo`; función `seed-data` eliminada o convertida en script local con `service_role` |
| **B2** — RLS en `questions` y `exams` corregido | Las policies se reescriben para que estudiantes solo vean preguntas de exámenes asignados Y abiertos (Patrón B del Protocolo) |
| **B3** — `verify_jwt` activado en todas las Edge Functions de costo (IA + execute-code) | Cada función llama `getUser()` antes de cualquier `fetch` a un proveedor externo |

**Sin estos tres, abrir el sistema a producción es exponer datos personales de usuarios reales y permitir trampa estructural en exámenes.**

### ✅ Go (post-remediación)

Con B1, B2, B3 resueltos y los hallazgos altos restantes (audit logs, PII profiles, drift schema) en plan de trabajo verificable, el proyecto puede ir a producción **con monitoreo activo y fecha de re-auditoría a 30 días**.

---

## Plan de remediación priorizado

### Sprint 1 — Esta semana (bloqueantes de producción)

| Día | Tarea | Responsable | Estimado |
|-----|-------|-------------|----------|
| Hoy | Rotar password `andres_dfx@hotmail.com` en Supabase Auth | Operador | 5 min |
| Hoy | `git filter-repo --replace-text replacements.txt` con `Tester#12345` y `Estudiante#123` | Operador | 30 min |
| Hoy | Force-push limpio + comunicar al equipo "re-clonar, no rebase" | Operador | 15 min |
| D+1 | Eliminar la Edge Function `seed-data` de producción; mover lógica a script local | Dev | 1 h |
| D+1 | Migración `harden_phase1.sql` con remediación de RLS para `questions`, `exams`, `profiles`, `audit_logs`, `ai_prompts` | Dev | 3 h |
| D+1 | `supabase db diff` en staging, validar que la app sigue funcionando con las nuevas policies | QA | 1 h |
| D+2 | Activar `verify_jwt = true` en `config.toml` para edge functions de IA + ejecución | Dev | 30 min |
| D+2 | Revisar el orden de validación de auth dentro de cada handler (auth ANTES de cualquier fetch externo) | Dev | 2 h |

### Sprint 2 — Próximas 2 semanas (hallazgos altos)

- Edge Functions: agregar verificación de pertenencia al curso (`detect-plagiarism`, `evaluate-exam-time`, `generate-contents`) — ~4 h.
- `bulk-import-users`: whitelist de roles importables (`Estudiante`, `Docente`; nunca `Admin`) + validación de input + auditoría — ~2 h.
- Frontend: `RequireAuth` envolvente con loading gate y redirect — ~3 h.
- Aplicar migraciones pendientes a producción (resolver drift de `audit_logs`, `ai_prompts`, `ai_model_settings`) — ~1 h con backup previo.
- Generar PAT y correr `supabase_list_rls_policies` para confirmar que las policies en producción coinciden con repo — ~30 min.

### Sprint 3 — Mes próximo (hallazgos medios/bajos + higiene continua)

- Wrapper `logger` que se desactive en build de producción (B2) — ~2 h.
- Limpiar `signOut()` (B3): `queryClient.clear()` + storage clean — ~1 h.
- Storage: confirmar que `project_files_teacher_read_all` filtra por `course_teachers` — ~1 h.
- CORS allowlist específico (no `*`) en todas las edge functions — ~2 h.
- Pre-commit hook con `gitleaks` para bloquear futuros secretos en commits — ~30 min.

---

## Hallazgos por número (referencia cruzada)

Reportes detallados:
- [Reporte 01 — RLS y schema](./01-hallazgos-iniciales.md)
- [Reporte 02 — Edge Functions, Storage, Frontend](./02-edge-functions-storage-frontend.md)

| Sev | ID | Tabla / Función / Componente | Reporte |
|-----|----|----|---------|
| 🔴 CRÍTICO | C1 | `questions` — RLS abierto a todos los authenticated | 01 |
| 🔴 CRÍTICO | C2 | `audit_logs` — INSERT WITH CHECK (true) | 01 |
| 🔴 CRÍTICO | C3 | `seed-data` — sin auth + master password en repo | 02 |
| 🔴 CRÍTICO | C4 | `ai-generate-questions` — JWT verificado tarde | 02 |
| 🔴 CRÍTICO | C5 | `bulk-import-users` — privilege escalation vía CSV | 02 |
| 🔴 CRÍTICO | C6 | `ai-grade-submission` — re-invocación interna sin re-validar (verificar) | 02 |
| 🟠 ALTO | A1 | `profiles` — PII accesible a todos los authenticated | 01 |
| 🟠 ALTO | A2 | `exams` — visibles antes de la apertura | 01 |
| 🟠 ALTO | A3 | `execute-code` — JWT no validado | 01 |
| 🟠 ALTO | A4 | Drift schema repo↔producción (3 tablas missing) | 01 |
| 🟠 ALTO | A5 | `admin-update-password` — confía en RLS para verificar rol | 02 |
| 🟠 ALTO | A6 | `detect-plagiarism` — sin check de curso del docente | 02 |
| 🟠 ALTO | A7 | `evaluate-exam-time` / `generate-contents` — idem A6 | 02 |
| 🟡 MEDIO | M1 | CORS `*` en Edge Functions sensibles | 01 |
| 🟡 MEDIO | M2 | `admin-delete-users` — borrado no transaccional | 01 |
| 🟡 MEDIO | M3 | `ai_prompts` — system prompts visibles a estudiantes | 01 |
| 🟡 MEDIO | M4 | Storage `project_files_teacher_read_all` — verificar scope | 02 |
| 🟡 MEDIO | M5 | `daily-notifications` — service key leak en logs | 02 |
| 🟡 MEDIO | M6 | `send-push` — suplantación de destinatario | 02 |
| 🟡 MEDIO | M7 | Frontend — gating sin loading gate | 02 |
| ⚪ BAJO | B1 | PostgREST `hint` revela schema | 01 |
| ⚪ BAJO | B2 | `console.log` con PII en src/ | 02 |
| ⚪ BAJO | B3 | `signOut()` no limpia caches | 02 |

---

## Ítems pendientes de auditoría

1. **PAT de Supabase** para validar `pg_policies` en producción y descartar drift.
2. **GitHub Personal Access Token** para correr `dead_code_scan` (en desarrollo) sobre tablas/funciones que pueden estar abandonadas.
3. **Headers de seguridad del host** (Lovable / Vercel / Netlify) — CSP, HSTS, etc.
4. **Cumplimiento Habeas Data (Ley 1581 Colombia)** si la app maneja datos de usuarios colombianos en producción — revisión legal aparte.
5. **Rotación trimestral** del `service_role` key — establecer calendario.

---

*Este reporte refleja el estado del repo al 2026-05-10. Auditoría sujeta a re-revisión 30 días post-remediación.*
