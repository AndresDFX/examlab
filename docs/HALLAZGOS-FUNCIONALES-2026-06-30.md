# Hallazgos funcionales — workflow de validación 2026-06-30

Workflow `functional-validation-sweep` (9 módulos, review + verify adversarial). El verify se interrumpió por límite de sesión → varios hallazgos quedaron SIN verificar adversarialmente (recuperados de los transcripts de review). Se verifican/corrigen inline.

## Confirmados por verify adversarial (11)

| # | Módulo | Sev | Título | Estado |
|---|---|---|---|---|
| C1 | exam-take | med | autosave es debounce, no heartbeat → session-lock se degrada con alumno inactivo | ✅ heartbeat setInterval 5s |
| C2 | exam-take | low | saveAnswersNow tras setCurrentIdx persiste índice ANTERIOR (ref no sincronizado) | ✅ currentIdxRef antes del save (3 handlers) |
| C3 | exam-take | low | restoreQuestionIndex sin clamp a questions.length → pantalla en blanco al reanudar | ✅ clamp con questionCount + test |
| C4 | exam-ai-grade | low | detect-plagiarism `inserted > 0` (array vs número) → audit siempre 'info' | ✅ inserted.length |
| C5 | exam-ai-grade | low | ai-grade-submission `timeLimitSec` lee columna no incluida en join → dead code | ✅ removido |
| C6 | projects | med | aiRegradeSubFile no actualiza gradingSubs → final_grade stale al guardar sustentación | ⬜ pendiente (riesgo medio, requiere recompute) |
| C7 | attendance | low | check_in_open queda colgado si el proyector se cierra (sin cron de expiración) | ⬜ pendiente (necesita cron/RPC) |
| C8 | attendance | low | check-in por deep-link no refresca la tarjeta (depende de realtime) | ✅ loadOpenSessions encadenado |
| C9 | polls | med | slotSummary/suggestSlotCupo usan floor; generateSlotsForDates usa ceil → divergencia | ✅ slotsPerDayCount (ceil) + tests |
| C10 | polls | low | re-votar en slot (clear+vote) no atómico → alumno puede quedar sin voto | ⬜ pendiente (RPC atómico) |
| C11 | tutor | low | respuesta IA vacía/>20000 viola CHECK de tutor_chat_messages → pierde turno completo | ✅ clamp/fallback (insert + response) |

**Corregidos en esta pasada (9):** C1, C2, C3, C4, C5, C8, C9, C11. tsc=0, suite verde. **Pendientes (low/med, sin rush):** C6 (regrade-stale), C7 (checkin cron), C10 (vote atómico) + grading-weights G1-G7 (ver abajo).

## Recuperados de transcripts (verify falló por límite) — grading-weights (7, 4 HIGH)

| # | Sev | Título | Archivos |
|---|---|---|---|
| G1 | **HIGH** | Acta oficial calcula final como avg-de-CORTES; gradebook/estudiante usan avg-PLANO de items | `20260978000000_generate_course_acta_fixes.sql:180-187` vs `app.teacher.gradebook.tsx:1001-1008` / `app.student.grades.tsx:503-524` |
| G2 | **HIGH** | Asistencia en acta+boletín usa `pct*max` (ignora grade_scale_min); UI usa `min+pct*(max-min)` | acta `:163-164`, `report-context.ts:371` vs gradebook `:982` / student `:421-422` |
| G3 | **HIGH** | 'tarde' cuenta como presente en acta+boletín pero NO en gradebook/estudiante | `report-context.ts:100`, acta `:162` vs gradebook `:980` / student `:418` |
| G4 | **HIGH** | ✅ CORREGIDO (119b4e5c): consolidado usa computeAttemptGrade(own, retry_mode) como getGrade | `app.teacher.gradebook.tsx` |
| G5 | med | Boletín PDF calcula final como avg-de-cortes (no como gradebook) | `report-context.ts:379-380` |
| G6 | med | Acta SQL: LEFT JOIN a submissions duplica el examen con múltiples intentos → pondera N veces | `20260978000000_...sql:109-120` |
| G7 | low | ✅ CORREGIDO (119b4e5c): externos usan grade_scale_max en ambos grids editables | `app.teacher.gradebook.tsx` |

## Pendientes de recuperar (otros módulos con verify fallido)
workshops-groups, projects (parcial), messaging-broadcast, exam-ai (parcial), tutor (parcial) — revisar transcripts si quedan hallazgos no listados arriba.
