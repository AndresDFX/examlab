# Hallazgos de bugs — cacería ronda 3 (2026-07-15)

Tercer barrido sobre subsistemas aún no cubiertos a fondo: grading IA + fraude, offline
sync, storage/uploads, import/export, TOTP asistencia, Kahoot en vivo, proctoring,
notificaciones. Workflow con verificación adversarial por hallazgo. **6 confirmados, 0
refutados, todos seguros y arreglados.** (El finder de `proctoring` no completó por límite
de sesión; queda para una pasada futura.)

| # | Área | Sev | Bug | Fix |
|---|---|---|---|---|
| R3-1 | import-export | **alta** | `BulkImportDefensesDialog`: la aplicación usaba `rows` (todas las parseadas) en vez de `safeRows` (filtradas por el guard de desalineación de columnas). Una fila CSV mal alineada tipo `email,0,8,,` (factor "0") se mostraba como error PERO igual se aplicaba → `final_grade = submission_grade × 0 = 0` en SILENCIO. | `dedupeBySubmission(safeRows, …)` — un token. `BulkImportDefensesDialog.tsx` |
| R3-2 | ai-grading | media | `ai-grade-submission`: `maxAiLikelihood` se sembraba desde `sub.ai_detected_score`, que YA incluye el speedBoost → cada recalificación re-sumaba el speedBoost (0.22→0.34→…→>0.60) → falso `ai_detected`/`sospechoso` + penalización falsa en FraudPanel. | Sembrar en 0; la señal de preguntas no-recalificadas se preserva por la rama de skip. `ai-grade-submission/index.ts` |
| R3-3 | storage | media | Quick-upload del tablero: dos archivos cuyos nombres slugifican igual ("Cálculo.pdf"/"Calculo.pdf" → "calculo.pdf", o no-ASCII → "archivo.pdf") generaban el MISMO path y con `upsert:true` el 2º pisaba los bytes del 1º en silencio. | Dedup de slug dentro del batch (`usedSlugs` Set + prefijo idx), patrón de `ProjectFiles`. `board-content-upload.ts` |
| R3-4 | notif | media | El push (tab oculto) NO aplicaba el filtro por rol que sí aplica la campana in-app → llegaba push de notificaciones con `source_role === rol activo` que el usuario nunca ve en la lista. | Replicar el filtro antes del `postMessage` al SW, con `viewerRoleRef` (el effect realtime tiene deps `[userId]` y capturaría un rol viejo). `use-notifications.ts` |
| R3-5 | import-export | media | **CSV injection**: `toCSV` no neutralizaba celdas que empiezan con `= + - @` → al abrir el export en Excel/Sheets se evalúan como fórmula (exfiltración vía HYPERLINK/WEBSERVICE, DDE). Datos de usuario (nombres, feedback, preguntas) se exportan. | Prefijo `'` a celdas de fórmula, SIN romper números legítimos (`-5`, `4,5`). `csv.ts` + tests. |
| R3-6 | ai-grading | baja | `detect-plagiarism` insertaba pares duplicados cuando el modelo devuelve la misma pareja en ambos órdenes ({0,1} y {1,0}) — sin dedup intra-corrida (la tabla no tiene UNIQUE) → FraudPanel contaba doble. | `seenKeys` Set de claves canónicas por corrida. `detect-plagiarism/index.ts` |

Todos los cambios: client TS + edge functions (deploy vía Publish) — sin migración de DB esta
ronda. tsc=0, tests verdes.

**Pendiente**: re-correr el finder de `proctoring` (timer/session-lock/doble-submit/fullscreen)
en una próxima pasada — no completó por límite de sesión.
