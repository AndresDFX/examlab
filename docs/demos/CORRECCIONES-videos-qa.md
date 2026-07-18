# QA de videos demo — correcciones (student / teacher / admin)

Fuente: `videos student-teacher-admin.docx` (revisión del usuario, 2026-07-16).
Estado del pipeline: specs en `admin/pipeline/modules/`, se re-graban con
`make.mjs <id>` + `build-serie.mjs <rol>` y se suben a `help-videos`.

**Categorías:**
- 🔧 **Técnico** — bug de grabación (recorder/spec). Se arregla en el pipeline.
- 🎬 **Falta ejemplo** — la narración promete una demostración que la pantalla
  no muestra. Requiere agregar escena(s) de demostración al spec + que el tenant
  demo (Demo Global Corp) TENGA el dato a mostrar + re-grabar.
- ✅ **OK** — el QA lo describe correcto; sin acción.

## Fix técnico transversal aplicado
- 🔧 **"Punto muerto" al inicio** (Modulo-02, Modulo-06 y cualquiera con carga
  lenta antes del 1er beat): el `#demo-cursor` (punto azul) salía en el centro
  durante la carga. **Corregido**: `opacity:0` por defecto en el recorder
  (`record-module.mjs`). Beneficia a TODOS los videos al re-grabar.

## ESTUDIANTE
| Módulo | QA | Categoría | Acción |
|---|---|---|---|
| s01 | Desfase imagen/audio al mostrar el panel inicial | 🔧 | Ajustar sync (ver nota) + re-grabar |
| s02 | Bien; pero "dijo algo de IA y no mostró el ejemplo de IA" | 🎬 | Mostrar el tutor IA en acción o quitar la mención |
| s03 | No muestra cómo sería un examen de programación (lo menciona) | 🎬 | Escena: abrir un examen con pregunta de código |
| s04 | No muestra ejemplo de un taller ni cómo se retroalimenta | 🎬 | Escena: abrir taller entregado + feedback |
| s05 | No muestra ejemplo de cómo se ve un proyecto | 🎬 | Escena: abrir un proyecto |
| s06 | Panel de calificaciones OK (cortes + nota final) | ✅ | — |
| s07 | No muestra de dónde sale el código para marcar asistencia | 🎬 | Escena: card de check-in con código/QR |
| s08 | Encuesta OK, con ejemplo claro | ✅ | — |
| s09 | No muestra ejemplo de pizarra compartida | 🎬 | Escena: abrir una pizarra |
| s10 | Asistente IA OK (chats por curso); no muestra un chat real | 🎬 | Escena: chat del tutor con mensajes |
| s11 | Certificaciones OK (descargar + verificar) | ✅ | — |
| s12 | Calendario: no muestra ejemplo de reuniones/tareas | 🎬 | Escena: mes con eventos |
| s13 | Herramientas (notif/chat/logout) OK | ✅ | — |

## PROFESOR
| Módulo | QA | Categoría | Acción |
|---|---|---|---|
| t01 | Sidebar + menú principal OK | ✅ | — |
| t02 | No muestra un curso en la tabla ni el menú de acciones (sí crea curso) | 🎬 | Escena: fila de curso + RowActionsMenu abierto |
| t03 | No muestra interacción con exámenes ni crear preguntas con IA (sí crea examen) | 🎬 | Escena: generar preguntas con IA |
| t04 | OK — muestra preguntas manual + IA + crear taller | ✅ | — |
| t05 | No muestra interacción/entregables con IA (medio muestra crear proyecto) | 🎬 | Escena: entregable + IA en proyecto |
| t06 | Banco de preguntas OK (historial + IA) | ✅ | — |
| t07 | Calificaciones OK (escala + tabla) | ✅ | — |
| t08 | Asistencia OK (genera QR con límites) | ✅ | — |
| t09 | Contenido OK (manual + IA) | ✅ | — |
| t10 | Videos OK (subir a biblioteca) | ✅ | — |
| t11 | No muestra ejemplo claro de interactuar con la pizarra | 🎬 | Escena: dibujar/usar la pizarra |
| t12 | Encuesta: narra la creación pero la imagen no muestra cómo hacerlo | 🎬 | Re-grabar mostrando cada paso de creación |
| t13 | Mensajes OK (1-a-1, grupo, programar) | ✅ | — |
| t14 | Calendario OK (sync Google) | ✅ | — |

## ADMIN
| Módulo | QA | Categoría | Acción |
|---|---|---|---|
| 01 | Módulos + menú principal OK | ✅ | — |
| 02 | Punto muerto 3s + "crear usuario no muy claro" (sí muestra lista) | 🔧 + 🎬 | Fix punto ✅ + escena crear usuario clara |
| 03 | Académico OK (carrera, asignaturas, periodos) | ✅ | — |
| 04 | Cursos OK (crear con características) | ✅ | — |
| 05 | No muestra cómo crear contenido (lo intenta) | 🎬 | Escena: crear contenido paso a paso |
| 06 | Punto muerto 4s + no muestra cómo subir video | 🔧 + 🎬 | Fix punto ✅ + escena subir video |
| 07 | Prompts OK (IA + proveedor) | ✅ | — |
| 08 | Configuración OK (entorno + roles) | ✅ | — |
| 09 | Certificados OK | ✅ | — |
| 10 | Estadísticas globales OK | ✅ | — |
| 11 | Informes OK | ✅ | — |
| 12 | Auditoría OK (filtros) | ✅ | — |
| 13 | Soporte: no muestra cómo crear un ticket (lo intenta) | 🎬 | Escena: crear ticket paso a paso |
| 14 | Papelera: no muestra el ejemplo que narra | 🎬 | Escena: item en papelera + restaurar |
| 15 | Herramientas (roles/notif/mensajes/logout) OK | ✅ | — |
| 16 | Cron IA OK (cola) | ✅ | — |

## Resumen
- 🔧 Técnico: **punto muerto CORREGIDO** en el recorder (aplica a 02/06 + todos).
  Desfase s01: pendiente de ajuste de sync.
- 🎬 Falta ejemplo: **~16 videos** (s02,s03,s04,s05,s07,s09,s10,s12 · t02,t03,t05,
  t11,t12 · 02,05,06,13,14). Cada uno = agregar escena de demostración al spec +
  asegurar que Demo Global Corp tenga el dato + re-grabar. Es un trabajo de
  contenido por lotes (requiere seed data por caso), no un solo pase automático.
- ✅ OK (sin acción): **~19 videos**.
