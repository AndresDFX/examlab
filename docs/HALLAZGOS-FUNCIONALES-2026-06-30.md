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

## Recuperados adicionales de transcripts (verify falló) — otros módulos

> Hallazgos de los REVIEW agents cuyo verify adversarial no corrió (límite de sesión). **NO verificados adversarialmente** — verificar inline antes de corregir (la experiencia con grading mostró que el verify a veces baja la severidad).

### Talleres + grupos
| # | Sev | Título | Archivo |
|---|---|---|---|
| W1 | **HIGH** | Aprobar nota IA / guardar nota por-pregunta finaliza la calificación SIN notificar al estudiante ni al grupo | `app.teacher.workshops.tsx:2342-2377` (approveAIGrade), `1655-1708` (saveAnswerGrade) |
| W2 | med | ✅ CORREGIDO: listado lee app_settings.default_workshop_max_attempts (3-tier como WorkshopQuestions) | `app.student.workshops.tsx` |
| W3 | med | Race: 2 miembros del grupo entregando a la vez crean DOS submissions (sin UNIQUE workshop_id+group_id) | `WorkshopQuestions.tsx:1467-1532` |
| W4 | low | Miembros de grupo no matriculados quedan invisibles en el editor (conteo/eliminación incorrectos) | `WorkshopGroupsEditor.tsx:114-122,156,344-363` |
| W5 | low | moveUser no atómico: si el INSERT al nuevo grupo falla tras el DELETE, el alumno queda sin grupo | `WorkshopGroupsEditor.tsx:196-217` |

### Mensajería + difusión + programados
| # | Sev | Título | Archivo |
|---|---|---|---|
| M1 | med | `dispatch_scheduled_messages` perdió la rama `kind='group'` en migraciones posteriores (drift SQL) → mensajes programados de grupo no se despachan | `20260982000000_...sql:33-142` |
| M2 | med | Broadcast inmediato puede dejar fuera destinatarios por el límite por defecto de filas de PostgREST en SELECTs sin paginar (cursos >1000 alumnos) | `broadcast-course-message/index.ts:179-205, 278-283` |

### Proyectos + sustentación
| # | Sev | Título | Archivo |
|---|---|---|---|
| P1 | **HIGH** | ✅ CORREGIDO: re-submit limpia defense_factor/at/notes → la re-entrega exige sustentación fresca | `ProjectFiles.tsx` |
| P2 (=C6) | med | aiRegradeSubFile deja submission_grade/final_grade obsoletos en el state local | `app.teacher.projects.tsx:2031-2045,2136-2143` |
| P3 | low | En modo async, submission_grade se persiste como 0 hasta que el worker drena | `ProjectFiles.tsx:2489-2506` |

### Tutor
| # | Sev | Título | Archivo |
|---|---|---|---|
| T1 (=C11) | med | respuesta IA vacía/>20000 viola CHECK → ✅ CORREGIDO | `tutor-chat/index.ts` |
| T2 | low | ✅ CORREGIDO: cuenta sobre `lines` filtradas + índice (src + copia Deno) | `tutor-prompt.ts` |

**Total del workflow: ~30 hallazgos.** Corregidos esta sesión: 11 (C1-C5, C8, C9, C11, G4, G7). Pendientes de verificar+corregir en pasada dedicada (subagents disponibles post-12pm): W1, P1 (HIGH); M1, M2, W2, W3, G1/G2/G3/G5/G6 (med); resto low.

---

## Verificación adversarial (workflow verify-recovered-findings) — 11/11 confirmados

Segundo workflow (subagents disponibles tras reset 12pm): verificó adversarialmente los hallazgos recuperados. **0 refutados.** Severidad + riesgo de fix ajustados por el verificador (leyendo el código real):

| # | Sev (verify) | fix_risk | Estado |
|---|---|---|---|
| W1 | med | low | ✅ CORREGIDO (74948ed7) |
| W2 | med | low | ✅ CORREGIDO (74948ed7) |
| P1 | high | low | ✅ CORREGIDO (cda8871f) |
| G4 | high | — | ✅ CORREGIDO (119b4e5c) |
| W3 | med | low* | ✅ CORREGIDO (mig 20261014): índice UNIQUE parcial talleres+proyectos (0 dupes existentes → seguro). Upsert cliente = pulido opcional |
| M2 | med | low | ✅ CORREGIDO: paginado enrollments (.range) + chunk profiles.in(500) + chunk conversations.or(150) |
| C6 | med | medium | ✅ CORREGIDO: helper syncParentAfterFileRegrade en las 3 ramas de aiRegradeSubFile |
| M1 | low | low | ✅ CORREGIDO (mig 20261015): rama group reinsertada; verificado runtime (rolled back) |
| G2 | med | **medium** | ✅ CORREGIDO (cluster acta/boletín 2026-06-30) |
| G5 | med | **medium** | ✅ CORREGIDO (cluster acta/boletín 2026-06-30) |
| G3 | low | low | ✅ CORREGIDO (cluster acta/boletín 2026-06-30) |
| G1 | high | **high** | ✅ CORREGIDO (cluster acta/boletín 2026-06-30) |
| G6 | med | **high** | ✅ CORREGIDO (cluster acta/boletín 2026-06-30) |

**El cluster del acta/boletín (G1/G2/G3/G5/G6)** es UNA pasada cohesiva: alinear los documentos generados (acta sellada SQL + boletín PDF) al algoritmo canónico del gradebook (avg-plano + escala con min + decidir 'tarde'). Requiere migración de `generate_course_acta` + cambios en `report-context.ts` + tests de `grade.ts` con casos de asignación parcial de pesos. NO se debe apresurar (toca un documento legal sellado con hash y la nota de todos los expedientes).

### Resumen del esfuerzo (sesión 2026-06-30)
- 2 workflows (functional sweep 9 módulos + verify adversarial 11 hallazgos).
- ~30 hallazgos totales; **14 CORREGIDOS** (C1-C5, C8, C9, C11, G4, G7, P1, W1, W2) — tsc=0, suite 2055/2055, pusheados; 3 edges desplegados por CI.
- 11 restantes verificados con diseño de fix + riesgo, listos para pasada dedicada.
