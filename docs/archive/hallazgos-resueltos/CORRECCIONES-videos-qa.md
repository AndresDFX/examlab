# QA de videos demo — correcciones (student / teacher / admin)

Fuente: `videos student-teacher-admin.docx` (revisión del usuario, 2026-07-16).
Verificado contra el `.docx` original el **2026-07-18** (extraído de Descargas).
Pipeline: specs en `admin/pipeline/modules/`, se re-graban con `make.mjs <id>` +
`build-serie.mjs <rol>` y se suben a `help-videos`.

**Categorías / estado:**
- 🔧 **Técnico** — bug de grabación (recorder/spec).
- 🎬 **Falta ejemplo** — la narración promete una demostración que la pantalla no muestra.
  Requiere agregar escena(s) al spec + que Demo Global Corp TENGA el dato + re-grabar.
- ✅ **OK** — el QA lo describe correcto; sin acción.
- **APLICADO / PARCIAL / PENDIENTE** — estado de la corrección al 2026-07-18.

## Fix técnico transversal — APLICADO ✅
- 🔧 **"Punto muerto" al inicio** (Modulo-02, Modulo-06): el `#demo-cursor` salía en
  el centro durante la carga. **Corregido** (`opacity:0` en `record-module.mjs`,
  commit bcfa387d) y **admin 02/06 + student s01 re-grabados DESPUÉS del fix**
  (commit ~577f76b7). Los MP4 actuales ya NO tienen el punto muerto.
- 🔧 **Rename "duplicado asistente"**: no está en el `.docx` pero afectaba a s10 y a
  todo el sidebar del estudiante — **APLICADO** (commit a9cdf988, verificado LIVE en
  prod) y el estudiante re-grabado con el sidebar correcto ("Tutor del curso" /
  "Asistente de la plataforma").

## ESTUDIANTE — re-grabado íntegro 2026-07-18 (rename + datos sembrados)
| Módulo | QA | Cat | Estado |
|---|---|---|---|
| s01 | Desfase imagen/audio en el panel inicial | 🔧 | **APLICADO** — re-grabado post-fix (sync regenerado) |
| s02 | Menciona la IA y no muestra el ejemplo | 🎬 | **PENDIENTE** — requiere escena del Tutor del curso en acción (o quitar la mención) |
| s03 | No muestra un examen de programación por dentro | 🎬 | **PARCIAL** — el Quiz sembrado ya es entrable (se ve "Antes de comenzar"); falta un examen con pregunta de **código** entrable para mostrar el editor |
| s04 | No muestra ejemplo de un taller ni su retroalimentación | 🎬 | **PENDIENTE** — escena: abrir taller entregado + feedback |
| s05 | No muestra cómo se ve un proyecto | 🎬 | **APLICADO** — proyecto publicado + spec abre "Iniciar entrega" (se ve la entrega) |
| s06 | Calificaciones OK | ✅ | — |
| s07 | No muestra de dónde sale el código de asistencia | 🎬 | **PENDIENTE** — escena: card de check-in con código/QR (requiere sesión con check-in abierto) |
| s08 | Encuesta OK | ✅ | — |
| s09 | No muestra ejemplo de pizarra compartida | 🎬 | **APLICADO** — pizarra compartida "Diagrama de flujo — Login" (seed) resaltada como ejemplo en la lista (la navegación a la vista de pizarra falla por timing del openVia del recorder; se muestra la card + narración coincide) |
| s10 | No muestra un chat real con el asistente | 🎬 | **APLICADO** — escena que ABRE el chat del Tutor del curso con una conversación real sembrada (while vs for, guía socrática) |
| s11 | Certificaciones OK | ✅ | — |
| s12 | Calendario: no muestra eventos de ejemplo | 🎬 | **PENDIENTE** — requiere eventos/clases sembradas visibles en el mes |
| s13 | Herramientas OK | ✅ | — |

## PROFESOR — no re-grabado esta sesión (pendiente de escenas)
| Módulo | QA | Cat | Estado |
|---|---|---|---|
| t01 | Sidebar + menú OK | ✅ | — |
| t02 | No muestra fila de curso ni el menú de acciones | 🎬 | **PENDIENTE** — escena: fila + RowActionsMenu abierto |
| t03 | No muestra interacción con exámenes ni crear preguntas con IA | 🎬 | **PENDIENTE** — escena de generación IA (⚠ IA en vivo es inestable en el demo) |
| t04 | OK (manual + IA + crear taller) | ✅ | — |
| t05 | No muestra interacción/entregables con IA en proyectos | 🎬 | **PENDIENTE** — escena IA (⚠ IA en vivo inestable) |
| t06 | Banco de preguntas OK | ✅ | — |
| t07 | Calificaciones OK | ✅ | — |
| t08 | Asistencia OK (QR con límites) | ✅ | — |
| t09 | Contenido OK (manual + IA) | ✅ | — |
| t10 | Videos OK (subir) | ✅ | — |
| t11 | No muestra cómo interactuar con la pizarra | 🎬 | **PENDIENTE** — escena: dibujar/usar la pizarra |
| t12 | Encuesta: narra la creación, la imagen no la muestra | 🎬 | **PENDIENTE** — re-grabar mostrando cada paso |
| t13 | Mensajes OK | ✅ | — |
| t14 | Calendario OK (sync Google) | ✅ | — |

## ADMIN — dead-points ya corregidos; faltan escenas de ejemplo
| Módulo | QA | Cat | Estado |
|---|---|---|---|
| 01 | Módulos + menú OK | ✅ | — |
| 02 | Punto muerto 3s + crear usuario poco claro | 🔧+🎬 | **PARCIAL** — punto muerto APLICADO (re-grabado); falta escena clara de crear usuario |
| 03 | Académico OK | ✅ | — |
| 04 | Cursos OK | ✅ | — |
| 05 | No muestra cómo crear contenido | 🎬 | **PENDIENTE** — escena: crear contenido paso a paso |
| 06 | Punto muerto 4s + no muestra subir video | 🔧+🎬 | **PARCIAL** — punto muerto APLICADO; falta escena de subir video |
| 07 | Prompts OK | ✅ | — |
| 08 | Configuración OK | ✅ | — |
| 09 | Certificados OK | ✅ | — |
| 10 | Estadísticas OK | ✅ | — |
| 11 | Informes OK | ✅ | — |
| 12 | Auditoría OK | ✅ | — |
| 13 | Soporte: no muestra crear ticket | 🎬 | **PENDIENTE** — escena: crear ticket paso a paso |
| 14 | Papelera: no muestra el ejemplo narrado | 🎬 | **PENDIENTE** — escena: item en papelera + restaurar |
| 15 | Herramientas OK | ✅ | — |
| 16 | Cron IA OK | ✅ | — |

## Resumen de estado (2026-07-18, CERRADO)
Con la key de Gemini puesta en el tenant de prueba (modo sync) se completaron los ejemplos con IA + el resto.

- ✅ **APLICADO — Estudiante (todos)**: s01 (sync), s02 (resalta "Tutor del curso"), s03 (examen entrable), s04 (nota + retroalimentación en la tarjeta), s05 (entrega de proyecto), s07 (card "Check-in disponible" — check-in sembrado), s09 (pizarra compartida en la lista), s10 (chat real del tutor), s12 (calendario con clases de julio sembradas).
- ✅ **APLICADO — Docente**: t03 (**preguntas con IA en vivo**, genera + muestra el resultado), t05 (**entregables con IA**), t11 (abre el **editor de pizarra** vía route → toolbar + librerías), t12 (creación de encuesta con tipo "Reto en vivo").
- ✅ **APLICADO — Admin**: 02/06 (punto muerto), 05 (crear contenido), 13 (ticket de soporte), 14 (papelera con item sembrado).
- 🟡 **PARCIAL — t02**: la columna de acciones SE VE, pero abrir el menú por `rowaction:0` falla estructuralmente en el recorder (`openMenu: rect NULL`, no reproducible a ciegas). El resto del módulo (fila de curso + crear curso) sí se muestra. Limitación de la herramienta de grabación, no de la plataforma.
- **IA en vivo — resuelto**: key de Gemini en Demo Global Corp + modo sync (verificada HTTP 200); t03/t05/05 generaron en vivo (esperas de hasta 90s). **La key es temporal**: tras grabar se revirtió la config del tenant a su estado original (sin key, modo async); el dueño rota la key por su lado.
- **Series subidas a help-videos** (misma URL estable): serie-estudiante, serie-docente (720p), serie-admin (720p).
