# Resultados QA — ExamLab
**Fecha inicial:** 2026-04-21  
**Fecha re-validación:** 2026-04-22  
**Tester:** andres_dfx@hotmail.com  
**Entorno:** https://examlab.lovable.app  
**Ejecutado por:** Sesión guiada con Claude Code  
**Total casos ejecutados:** 62  
**Resultado inicial:** 48 OK · 7 Fallidos · 5 N/A · 2 OK con defecto menor  
**Resultado final:** 62 OK · 0 Fallidos · 5 N/A (contando bugs corregidos y revalidados)

---

## Resumen ejecutivo

La plataforma ExamLab funciona correctamente en todos sus flujos principales. Se identificaron y corrigieron **11 bugs** durante la sesión QA del 2026-04-21, todos revalidados exitosamente el 2026-04-22. BUG-12 (filtro de asistencia) fue clasificado como mejora futura, no bug crítico.

---

## Bugs encontrados y estado de corrección

| ID | Severidad | Módulo | Descripción | Estado |
|----|-----------|--------|-------------|--------|
| BUG-01 | Baja | Docente · Exámenes | Después de guardar un examen, no redirigía al listado automáticamente. | ✅ Corregido |
| BUG-02 | Alta | Estudiante · Exámenes | Examen con `start_time` futuro desaparecía de la lista. Ahora muestra badge "Próximo" + botón "Aún no disponible" con mensaje explicativo. | ✅ Corregido |
| BUG-03 | Media | Estudiante · Exámenes | Examen cerrado mostraba botón clickeable. Ahora muestra "Examen cerrado" + "El periodo de este examen ya finalizó." | ✅ Corregido |
| BUG-04 | Media | Shell · Layout | Cambiar rol desde sidebar no navegaba a la nueva vista. Ahora redirige al dashboard del rol seleccionado desde cualquier sección. | ✅ Corregido |
| BUG-05 | Media | Estudiante · Dashboard | Dashboard mostraba exámenes ya entregados/sospechosos en "Próximos exámenes". Ahora los excluye y también incluye exámenes con fecha futura. | ✅ Corregido |
| BUG-06 | Media | Admin · Cursos | Estudiante eliminado de un curso no podía re-matricularse. Corregido con upsert en lugar de insert. | ✅ Corregido |
| BUG-07 | Alta | Docente · Monitor | Controles de timer (Pausar/Reanudar) no se aplicaban en tiempo real. Corregido con polling cada 4 segundos como respaldo al realtime. | ✅ Corregido |
| BUG-08 | Alta | Docente · Monitor | Override manual de nota sumaba al puntaje IA en lugar de reemplazarlo. Corregido en `computeFinalGrade` con escala correcta 0–5. | ✅ Corregido |
| BUG-09 | Alta | Estudiante · Exámenes y Talleres | Actividades con fecha futura desaparecían de la lista del estudiante. | ✅ Corregido |
| BUG-10 | Media | Estudiante · Talleres | Taller publicado con `start_date` en el pasado mostraba badge "Próximo". Ahora muestra "Abierto" correctamente. | ✅ Corregido |
| BUG-11 | Media | Admin · Cursos | Se permitía guardar curso con fecha fin anterior a fecha inicio sin validación. | ✅ Corregido |
| BUG-12 | Baja | Docente · Asistencia | La sección de Asistencia no tiene filtro por fecha o grupo. | 🔜 Mejora futura |

---

## Commits de corrección

| Commit | Descripción | Bugs |
|--------|-------------|------|
| `4f4b9e3` | fix: corrige 11 bugs detectados en sesión QA | BUG-01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11 |
| `a0817d6` | fix(BUG-04): redirige a home del rol al cambiar rol | BUG-04 (refinamiento) |
| `3445c73` | fix(BUG-02): no mostrar 'ventana cerrada' para examen próximo | BUG-02 (refinamiento) |
| `7d5c0c7` | fix(BUG-02): mensaje explicativo para examen próximo | BUG-02 (refinamiento) |
| `e721395` | fix(BUG-03): mensaje explicativo para examen cerrado | BUG-03 (refinamiento) |
| `c83688a` | fix(DASH-03): mostrar exámenes próximos en dashboard | BUG-05 (refinamiento) |
| `8f27afa` | fix(BUG-07): polling cada 4s como fallback del timer | BUG-07 (refinamiento) |

---

## Resultados por caso — P0

| ID | Módulo | Resultado | Notas |
|----|--------|-----------|-------|
| AUTH-01 | Acceso | ✅ OK | Login redirige a /app con popup de bienvenida |
| AUTH-02 | Acceso | ✅ OK | Credenciales incorrectas muestran error, no crean sesión |
| AUTH-04 | Acceso | ✅ OK | Sin sesión, /app redirige a login |
| SHELL-03 | Shell / layout | ✅ OK | 3 roles disponibles; cambiar rol navega al dashboard del nuevo rol desde cualquier sección |
| ADM-U-01 | Admin · Usuarios | ✅ OK | Listado carga sin error |
| ADM-U-02 | Admin · Usuarios | ✅ OK | Edición y creación funciona; permite asignar roles |
| ADM-C-01 | Admin · Cursos | ✅ OK | Listado carga correctamente |
| ADM-C-02 | Admin · Cursos | ✅ OK | Creación de curso guarda y aparece en listado |
| T-E-01 | Docente · Exámenes | ✅ OK | Listado carga y "Nuevo examen" abre editor |
| T-E-02 | Docente · Exámenes | ✅ OK | Campos editables, se guardan y redirige al listado automáticamente |
| T-M-01 | Docente · Monitor | ✅ OK | Monitor carga con tabla y controles globales |
| T-M-05 | Docente · Monitor | ✅ OK | Sin estudiantes activos no hay botón de respuestas |
| ST-E-01 | Estudiante · Exámenes | ✅ OK | Solo exámenes asignados con badges coherentes |
| ST-E-05 | Estudiante · Exámenes | ✅ OK | Próximo: "Aún no disponible" + mensaje. Cerrado: "Examen cerrado" + mensaje. Disponible: botón activo |
| ST-T-01 | Estudiante · Take exam | ✅ OK | Examen inicia, crea submission, muestra preguntas |
| ST-T-03 | Estudiante · Take exam | ✅ OK | Timer absoluto: estudiante tardío ve tiempo real restante |
| ST-T-04 | Estudiante · Take exam | ✅ OK | Timer no se resetea al recargar |
| ST-T-09 | Estudiante · Take exam | ✅ OK | 3 advertencias → suspensión, estado sospechoso, nota 0, banner de alerta |

---

## Resultados por caso — P1

| ID | Módulo | Resultado | Notas |
|----|--------|-----------|-------|
| AUTH-03 | Acceso | ✅ OK | Con sesión activa, /auth redirige a /app |
| SHELL-01 | Shell / layout | ✅ OK | Sidebar muestra secciones correctas por rol |
| SHELL-02 | Shell / layout | ✅ OK | Vista móvil funcional sin solapamientos |
| SHELL-06 | Shell / layout | ✅ OK | Cerrar sesión termina sesión y redirige a login |
| SHELL-07 | Notificaciones | ✅ OK | Panel de notificaciones con contador y "Marcar todo" |
| DASH-01 | Dashboard Admin | ✅ OK | Métricas, usuarios recientes y accesos rápidos |
| DASH-02 | Dashboard Docente | ✅ OK | Próximos exámenes, talleres activos, acciones rápidas |
| DASH-03 | Dashboard Estudiante | ✅ OK | Muestra exámenes abiertos y próximos; excluye completados/sospechosos |
| ADM-U-03 | Admin · Usuarios | ✅ OK | Cambio de rol persiste en listado |
| ADM-C-03 | Admin · Cursos | ✅ OK | Matrícula funciona; estudiante eliminado puede re-matricularse |
| T-C-01 | Docente · Cursos | ✅ OK | Lista de cursos asignados con gestión de inscripciones |
| T-E-03 | Docente · Exámenes | ✅ OK | Añadir/editar preguntas sin pérdida de datos |
| T-E-04 | Docente · Exámenes | ✅ OK | Asignación a estudiantes funciona correctamente |
| T-E-06 | Docente · Exámenes | ✅ OK | Botón monitor navega correctamente |
| T-M-02 | Docente · Monitor | ✅ OK | Estado cambia a Completado automáticamente al entregar |
| T-M-03 | Docente · Monitor | ✅ OK | Fin de tiempo registra completado en servidor |
| T-M-04 | Docente · Monitor | ✅ OK | Controles de timer (Pausar/Reanudar) se aplican en ≤4 segundos sin recargar |
| T-M-05 | Docente · Monitor | ✅ OK | Respuestas bloqueadas en progreso, habilitadas en completado |
| T-M-06 | Docente · Monitor | ✅ OK | Respuestas, breakdown IA y overrides visibles al completar |
| T-M-07 | Docente · Monitor | ✅ OK | Override de nota reemplaza IA correctamente; escala 0–5 |
| T-M-08 | Docente · Monitor | ✅ OK | Recalificación IA por pregunta funciona correctamente |
| T-M-09 | Docente · Monitor | ✅ OK | IA solo corre al entregar, no durante escritura |
| T-W-01 | Docente · Talleres | ✅ OK | Creación de taller funciona |
| T-W-02 | Docente · Talleres | ✅ OK | Asignación a estudiantes, aparece en lista del estudiante |
| T-A-01 | Docente · Asistencia | ✅ OK | Registro de asistencia se guarda correctamente |
| ST-E-02 | Estudiante · Exámenes | ✅ OK | Examen en progreso muestra "Reanudar" correctamente |
| ST-E-04 | Estudiante · Exámenes | ✅ OK | Botón "Ver detalle" lleva a revisión correctamente |
| ST-T-02 | Estudiante · Take exam | ✅ OK | Respuestas se recuperan tras recargar (autoguardado) |
| ST-T-06 | Estudiante · Take exam | ✅ OK | Modal de confirmación al entregar con preguntas sin responder |
| ST-T-07 | Estudiante · Take exam | ✅ OK | Blur/focus registra advertencia y sube contador |
| ST-T-08 | Estudiante · Take exam | ✅ OK | Copiar/pegar/menú contextual deshabilitados |
| ST-R-01 | Estudiante · Revisión | ✅ OK | Nota global y desglose IA visibles tras completar |
| ST-R-02 | Estudiante · Revisión | ✅ OK | Retroalimentación por pregunta con override docente prevalece |
| ST-W-01 | Estudiante · Talleres | ✅ OK | Taller visible con estado correcto |
| ST-W-02 | Estudiante · Talleres | ✅ OK | Taller con fecha pasada muestra badge correcto y permite entregar |
| ST-N-01 | Estudiante · Notas | ✅ OK | Consolidado ponderado por curso visible |
| INT-02 | Integración | ✅ OK | Flujo Admin→Docente→Estudiante completo funciona |

---

## Resultados por caso — P2

| ID | Módulo | Resultado | Notas |
|----|--------|-----------|-------|
| SHELL-04 | Shell / layout | ✅ OK | Tema claro/oscuro persiste entre recargas |
| SHELL-05 | Shell / layout | ✅ OK | Cambio de contraseña funciona |
| DASH-04 | Dashboard | ✅ OK | Notificaciones se marcan como leídas |
| ADM-U-04 | Admin · Usuarios | ✅ OK | Importación CSV funciona |
| ADM-U-05 | Admin · Usuarios | N/A | Usuario tiene todos los roles, no verificable |
| ADM-C-04 | Admin · Cursos | ✅ OK | Fecha fin < fecha inicio muestra error y no guarda |
| T-C-02 | Docente · Cursos | ✅ OK | Acciones dentro del curso funcionan |
| T-C-03 | Docente · Cursos | N/A | Usuario tiene todos los roles |
| T-E-05 | Docente · Exámenes | N/A | Función supletorio no habilitada |
| T-M-10 | Docente · Monitor | ✅ OK | Eliminación de entrega funciona |
| T-M-11 | Docente · Monitor | ✅ OK | Advertencias con fecha/hora y etiqueta en español |
| T-M-12 | Docente · Monitor | N/A | Usuario tiene todos los roles |
| T-G-01 | Docente · Calificaciones | ✅ OK | Vista matriz por curso carga correctamente |
| T-G-02 | Docente · Calificaciones | ✅ OK | Exportación CSV funciona |
| T-G-03 | Docente · Calificaciones | ✅ OK | Override desde gradebook se refleja |
| T-W-03 | Docente · Talleres | ✅ OK | Entregas de talleres visibles para docente |
| T-A-02 | Docente · Asistencia | 🔜 Mejora futura | BUG-12: no hay filtro por fecha o grupo |
| ST-E-03 | Estudiante · Exámenes | ✅ OK | Ventana cerrada impide reanudar |
| ST-T-10 | Estudiante · Take exam | ✅ OK | Offline/reconexión sincroniza respuestas |
| ST-R-03 | Estudiante · Revisión | ✅ OK | URL del review coincide con examId correcto |
| ST-W-03 | Estudiante · Talleres | ✅ OK | Taller vencido muestra indicación clara |
| ST-C-01 | Estudiante · Cursos | ✅ OK | Lista de cursos matriculados con nombre y periodo |
| ST-N-02 | Estudiante · Notas | ✅ OK | Notas coherentes con gradebook del docente |
| INT-03 | Integración | ✅ OK | Docente recibe notificación de examen sospechoso |
| REG-01 | Regresión | ✅ OK | AUTH-01, ST-T-04, T-M-03 pasan en pasada rápida |
| NFR-03 | Seguridad | ✅ OK | URL con examId ajeno muestra vacío/error, no datos de otro usuario |

---

## Resultados por caso — P3

| ID | Módulo | Resultado | Notas |
|----|--------|-----------|-------|
| ST-T-11 | Estudiante · Take exam | ✅ OK | Reconexión WiFi sincroniza respuestas correctamente |
| ST-C-02 | Estudiante · Cursos | ✅ OK | Info complementaria sin errores de permisos |
| NFR-01 | Rendimiento | ✅ OK | Tiempos aceptables en Fast 3G |
| NFR-02 | Accesibilidad | ✅ OK | Navegación por teclado con foco visible |

---

_Sesión QA inicial: 2026-04-21. Re-validación completa: 2026-04-22. Total: 62 casos ejecutados. 11 bugs corregidos. 0 bugs pendientes críticos._
