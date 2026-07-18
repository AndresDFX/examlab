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
| s09 | No muestra ejemplo de pizarra compartida | 🎬 | **PARCIAL** — pizarra compartida (seed) ya aparece en la lista; falta escena que la ABRA |
| s10 | No muestra un chat real con el asistente | 🎬 | **PARCIAL** — rename aplicado; falta escena que abra el chat del Tutor del curso con mensajes |
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

## Resumen de estado (2026-07-18)
- ✅ **APLICADO**: fix técnico transversal (punto muerto 02/06 + s01 sync, re-grabados) ·
  rename tutor/asistente · s05 (entrega de proyecto) · ~19 videos que el QA marcó OK.
- 🟡 **PARCIAL** (data lista, falta escena que abra el ejemplo): s03, s09, s10, admin-02, admin-06.
- 🔴 **PENDIENTE** (escena + data + re-grabar): s02, s04, s07, s12 · t02, t03, t05, t11, t12 · admin-05, 13, 14.
- ⚠ **Riesgo**: t03/t05 (y s02 parcialmente) piden mostrar **generación con IA en vivo**,
  que en el entorno demo es intermitente (disponibilidad del modelo) → grabarla de forma
  determinista no es fiable; se recomienda o bien sembrar el resultado, o narrar sin prometer la demo en vivo.
- **Nota de método**: cada 🎬 = escena de demostración en el spec + dato en Demo Global Corp +
  re-grabar. No es un pase automático; se hace por lotes y conviene revisar el MP4 resultante.
