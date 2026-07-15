# Hallazgos de bugs — cacería amplia 2026-07-15

Ronda de correctness/lógica/integridad (NO RLS — barrido y cerrado aparte, ver
[HALLAZGOS-RLS-2026-07-15.md](HALLAZGOS-RLS-2026-07-15.md)). Workflow de 5 finders por
área (notas, evaluaciones, asistencia, mensajería, contenido) + verificación. Todo lo
CONFIRMADO se verificó leyendo el código real y —para el cluster de notas— **empíricamente
contra PROD** (transacciones con rollback, sin mutar datos).

## Cluster de notas: acta legal / boletín ↔ gradebook / certificado / vista estudiante

El **gradebook** (`app.teacher.gradebook.tsx`) y la **vista del estudiante**
(`app.student.grades.tsx`) son la fuente de verdad: de ahí sale el **certificado** y es lo
que el alumno ve. El **boletín** (`src/modules/reports/report-context.ts`) y el **acta legal**
(`generate_course_acta`) divergían. La pasada 2026-06-30 alineó *avg-plano* + *asistencia con
min*, pero dejó SIN arreglar la normalización por `max_score` (la más grande), el min de
exámenes, los items sin corte y la resolución grupal del boletín.

| # | Sev | Bug | Estado |
|---|---|---|---|
| N1 | **ALTA** | Talleres/proyectos entraban CRUDOS (0..max_score, default 100) al promedio ponderado, mezclados con exámenes/asistencia 0..escala → nota inflada (un 100/100 aportaba 100, no 5). Acta y boletín. **Verificado en prod**: curso "Paradigmas" (FESNA) con 24 notas 100/100, 23 fuera de escala. | ✅ `3e71cd90` |
| N2 | media | Exámenes: el gradebook re-escala a [min,max] con `toScale`; acta/boletín usaban la nota cruda (0-based) → divergencia en cursos con `grade_scale_min>0`. | ✅ `3e71cd90` |
| N3 | media | Boletín (`report-context`) resolvía la entrega de taller/proyecto GRUPAL solo por `user_id` (el "último editor") → los demás miembros del grupo obtenían 0. El acta ya se había arreglado por membresía (`20261060`); el boletín quedó con el patrón viejo. | ✅ `3e71cd90` |
| N4 | media | Items SIN corte (`cut_id NULL`) se excluían de la nota final del acta/boletín, pero el gradebook/estudiante/certificado los incluyen → nota_final ≠ certificado. | ✅ `3e71cd90` |
| N5 | baja | `report-context` redondeaba el % de asistencia a entero antes de escalar; gradebook/acta usan la fracción exacta. | ✅ `3e71cd90` |
| N6 | (latente) | El bloque de exámenes del acta pasaba `s.final_grade`, pero `submissions` NO tiene esa columna (solo `final_override_grade` + `ai_grade`) → "column does not exist" al generar acta de cursos con cortes+exámenes. Oculto porque solo corría al ejecutarse el bloque. | ✅ `3e71cd90` (BONUS) |

**Verificación end-to-end** (rolled back, curso "Paradigmas", escala 0..5): con el fix, la
`nota_final` máxima quedó en **4.58** y **0 notas fuera de escala** (antes producía valores >5).
Alineado con `toScale` del gradebook = fuente del certificado.

Relación con el doc viejo: N1/N2/N3/N4 son **complementarios** al cluster 2026-06-30
(G1/G2/G5) — ese arregló avg-plano + asistencia-min pero NO la escala por `max_score` ni el
min de exámenes ni los items sin corte. G3 ('tarde') queda **resuelto como NO-bug**:
`countsAsPresent = presente || tarde` y el acta cuenta `status IN ('presente','tarde')` — coinciden.

## Otros hallazgos confirmados

| # | Área | Sev | Bug | Estado |
|---|---|---|---|---|
| A1 | Asistencia | **ALTA** | Abrir check-in enviaba notif/email/push DUPLICADO: el trigger DB `trg_notify_attendance_check_in_open` (kind='attendance') Y una llamada cliente extra `notify_course_students(kind='exam')`. 2× por apertura (186 correos en curso de 93). | ✅ removida la llamada cliente (el trigger cubre todas las vías, idempotente) |
| A2 (C7) | Asistencia | media | No existía nada que EXPIRE `check_in_open`; si el docente no cierra a mano, la tarjeta "Check-in disponible" quedaba colgada indefinidamente (el estudiante no puede leer `closes_at` — tabla privada). | ✅ pg_cron `close-expired-attendance-checkins` (cada minuto) + `close_expired_attendance_check_ins()`. Aplicado a prod (cerró 2 colgados reales). |
| A3 | Asistencia | baja | El escáner QR podía disparar `onDetected` 2× (callback por frame + `stop()` async). | ✅ `detectedRef` guard |
| E1 | Evaluaciones | media | NPE al renderizar el Badge de nota de taller/proyecto cuando `course` es null (`course.grade_scale_min` sin optional chaining) → crashea la lista entera. | ✅ guard `course ?` en `app.student.workshops/projects` |
| M1 | Email | media | `send-email`: `markDelivered`/`auditEmail` estaban DENTRO del try reintentable; un blip de red al marcar entregado (mensaje "timeout") disparaba `continue` → REENVÍO del mismo correo. | ✅ SMTP send aislado; bookkeeping best-effort fuera del scope de reintento |
| P1 | Encuestas | media | Reabrir una encuesta cerrada-por-tiempo era imposible (label solo miraba `closed_manually`; toast "reabierta" mentía porque `closes_at` seguía vencido). | ✅ label por estado EFECTIVO + `toggleClose` limpia `closes_at` vencido al reabrir |
| P2 | Encuestas | baja | Editar el cupo de un slot permitía bajarlo por debajo de `responses_count` (sobre-suscripción silenciosa "2 / 1"). | ✅ validación en el diff vote-safe |

## Pendiente (no incluido en esta pasada)

- **Pizarra compartida** (media): `applyingRemoteRef` se limpia con `setTimeout(0)`; si `onChange`
  corre antes, el receptor re-emite/persiste un scene remoto SIN imágenes → posible pérdida de
  binarios en boards con `whiteboard_shared`. Fix: resetear el flag dentro de `handleChange` o
  usar dedupKey por versión. *(pendiente — race sutil, requiere prueba manual multi-cliente)*
- **C10** (baja, doc 2026-06-30): re-votar en slot (clear+vote) no atómico. Requiere RPC atómico.
