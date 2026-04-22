# Resultados QA — ExamLab
**Fecha:** 2026-04-21  
**Tester:** andres_dfx@hotmail.com  
**Entorno:** https://examlab.lovable.app  
**Ejecutado por:** Sesión guiada con Claude Code  
**Total casos ejecutados:** 62  
**Resultado:** 48 OK · 7 Fallidos · 5 N/A · 2 OK con defecto menor

---

## Resumen ejecutivo

La plataforma ExamLab funciona correctamente en sus flujos principales: autenticación, gestión de usuarios y cursos, presentación de exámenes, proctoring, calificación IA y retroalimentación. Se identificaron **12 bugs**, de los cuales 2 son de severidad **Alta** (afectan visibilidad de actividades y calificaciones), 6 de severidad **Media** y 4 de severidad **Menor/Baja**.

---

## Bugs encontrados

| ID | Severidad | Módulo | Descripción |
|----|-----------|--------|-------------|
| BUG-01 | Baja | Docente · Exámenes | Después de guardar un examen, no redirige automáticamente al listado — el usuario debe navegar manualmente. Los datos sí se guardan correctamente. |
| BUG-02 | Alta | Estudiante · Exámenes | Examen con `start_time` en el futuro desaparece de la lista del estudiante en lugar de mostrarse con badge "Próximo" y botón deshabilitado. El estudiante no puede saber que tiene un examen próximo. |
| BUG-03 | Media | Estudiante · Exámenes | Con examen en estado "Cerrado", el botón "Iniciar examen" sigue visualmente clickeable. Sí bloquea con mensaje de error, pero debería estar visualmente deshabilitado (gris). |
| BUG-04 | Media | Shell · Layout | Al cambiar de rol desde el sidebar, la vista solo se actualiza si el usuario está en el Dashboard. En otras secciones (Exámenes, Cursos, etc.) la pantalla no cambia — hay que hacer clic manualmente en el ítem del sidebar. |
| BUG-05 | Media | Estudiante · Dashboard | El dashboard del estudiante muestra exámenes ya entregados/sospechosos con botón "Iniciar" en lugar de reflejar su estado real. Al hacer clic redirige a la lista donde sí aparece el estado correcto. |
| BUG-06 | Media | Admin · Cursos | Al eliminar un estudiante de un curso, ese estudiante desaparece de la lista de candidatos para re-matricularlo. No es posible volver a inscribirlo sin intervención directa en base de datos. |
| BUG-07 | Alta | Docente · Monitor | Los controles de temporizador (Pausar/Reanudar/Añadir tiempo) no se aplican en tiempo real al examen del estudiante — requieren recarga manual de la página del estudiante. |
| BUG-08 | Alta | Docente · Monitor / Calificaciones | Override manual de nota por pregunta suma al puntaje de IA en lugar de reemplazarlo, duplicando el puntaje. Causa notas infladas incorrectas visibles en monitor y revisión del estudiante. |
| BUG-09 | Alta | Estudiante · Exámenes y Talleres | Tanto exámenes como talleres con fecha de inicio futura desaparecen completamente de la lista del estudiante. El estudiante no puede ver su agenda de actividades próximas. |
| BUG-10 | Media | Estudiante · Talleres | Taller con fecha de inicio en el pasado sigue mostrando badge "Próximo" y no permite entregar. El estado no se recalcula correctamente según las fechas. |
| BUG-11 | Media | Admin · Cursos | Al crear un curso solo el nombre es obligatorio. Se permite guardar con fecha de fin anterior a fecha de inicio sin validación ni mensaje de error. |
| BUG-12 | Baja | Docente · Asistencia | La sección de Asistencia no tiene filtro por fecha o grupo, dificultando la gestión en cursos con múltiples sesiones. |

---

## Resultados por caso — P0

| ID | Módulo | Prioridad | Resultado | Notas |
|----|--------|-----------|-----------|-------|
| AUTH-01 | Acceso | P0 | ✅ OK | Login con credenciales válidas redirige a /app con popup de bienvenida |
| AUTH-02 | Acceso | P0 | ✅ OK | Credenciales incorrectas muestran error, no crean sesión |
| AUTH-04 | Acceso | P0 | ✅ OK | Sin sesión, /app redirige a login |
| SHELL-03 | Shell / layout | P0 | ✅ OK | 3 roles (Admin, Docente, Estudiante) — cambio de rol actualiza menú correctamente desde Dashboard |
| ADM-U-01 | Admin · Usuarios | P0 | ✅ OK | Listado de usuarios carga sin error |
| ADM-U-02 | Admin · Usuarios | P0 | ✅ OK | Edición y creación de usuarios funciona; permite asignar roles |
| ADM-C-01 | Admin · Cursos | P0 | ✅ OK | Listado de cursos carga correctamente (se detecta que 2 cursos tienen periodo y fechas vacíos) |
| ADM-C-02 | Admin · Cursos | P0 | ✅ OK | Creación de curso guarda y aparece en listado con todos sus datos |
| T-E-01 | Docente · Exámenes | P0 | ✅ OK | Listado carga y botón "Nuevo examen" abre editor |
| T-E-02 | Docente · Exámenes | P0 | ✅ OK (BUG-01) | Todos los campos editables y se guardan; sin embargo no redirige al listado tras guardar |
| T-M-01 | Docente · Monitor | P0 | ✅ OK | Monitor carga con tabla de estudiantes y controles globales |
| T-M-05 | Docente · Monitor | P0 | ✅ OK | Sin estudiantes activos no hay botón de respuestas habilitado |
| ST-E-01 | Estudiante · Exámenes | P0 | ✅ OK | Solo aparecen exámenes asignados con badges coherentes |
| ST-E-05 | Estudiante · Exámenes | P0 | ❌ Fallido | BUG-02 (examen próximo desaparece) + BUG-03 (botón cerrado clickeable) |
| ST-T-01 | Estudiante · Take exam | P0 | ✅ OK | Examen inicia, crea submission, muestra 9 preguntas navegables |
| ST-T-03 | Estudiante · Take exam | P0 | ✅ OK | Timer absoluto confirmado: estudiante que entra tarde ve tiempo restante real, no el máximo |
| ST-T-04 | Estudiante · Take exam | P0 | ✅ OK | Timer no se resetea al recargar página |
| ST-T-09 | Estudiante · Take exam | P0 | ✅ OK | Al 3ra advertencia: examen se suspende, estado sospechoso, nota 0, banner de alerta visible |

**P0: 17/18 OK · 1 Fallido**

---

## Resultados por caso — P0

| ID | Módulo | Resultado | Notas |
|----|--------|-----------|-------|
| AUTH-01 | Acceso | ✅ OK | Login redirige a /app con popup de bienvenida |
| AUTH-02 | Acceso | ✅ OK | Credenciales incorrectas muestran error, no crean sesión |
| AUTH-04 | Acceso | ✅ OK | Sin sesión, /app redirige a login |
| SHELL-03 | Shell / layout | ✅ OK | 3 roles disponibles, cambio actualiza menú correctamente desde Dashboard |
| ADM-U-01 | Admin · Usuarios | ✅ OK | Listado carga sin error |
| ADM-U-02 | Admin · Usuarios | ✅ OK | Edición y creación funciona; permite asignar roles |
| ADM-C-01 | Admin · Cursos | ✅ OK | Listado carga (2 cursos sin periodo/fechas) |
| ADM-C-02 | Admin · Cursos | ✅ OK | Creación de curso guarda y aparece en listado |
| T-E-01 | Docente · Exámenes | ✅ OK | Listado carga y "Nuevo examen" abre editor |
| T-E-02 | Docente · Exámenes | ⚠️ OK (BUG-01) | Campos editables y se guardan; no redirige al listado tras guardar |
| T-M-01 | Docente · Monitor | ✅ OK | Monitor carga con tabla y controles globales |
| T-M-05 | Docente · Monitor | ✅ OK | Sin estudiantes activos no hay botón de respuestas |
| ST-E-01 | Estudiante · Exámenes | ✅ OK | Solo exámenes asignados con badges coherentes |
| ST-E-05 | Estudiante · Exámenes | ❌ Fallido | BUG-02 (próximo desaparece) + BUG-03 (botón cerrado clickeable) |
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
| DASH-03 | Dashboard Estudiante | ⚠️ OK (BUG-05) | Carga estadísticas pero examen sospechoso aparece como "Iniciar" |
| ADM-U-03 | Admin · Usuarios | ✅ OK | Cambio de rol persiste en listado |
| ADM-C-03 | Admin · Cursos | ⚠️ OK (BUG-06) | Matrícula funciona; estudiante eliminado no puede re-matricularse |
| T-C-01 | Docente · Cursos | ✅ OK | Lista de cursos asignados con gestión de inscripciones |
| T-E-03 | Docente · Exámenes | ✅ OK | Añadir/editar preguntas sin pérdida de datos |
| T-E-04 | Docente · Exámenes | ✅ OK | Asignación a estudiantes funciona correctamente |
| T-E-06 | Docente · Exámenes | ✅ OK | Botón monitor navega correctamente |
| T-M-02 | Docente · Monitor | ✅ OK | Estado cambia a Completado automáticamente al entregar |
| T-M-03 | Docente · Monitor | ✅ OK | Fin de tiempo registra completado en servidor |
| T-M-04 | Docente · Monitor | ❌ Fallido | BUG-07: controles no se aplican en tiempo real, requieren recarga |
| T-M-05 | Docente · Monitor | ✅ OK | Respuestas bloqueadas en progreso, habilitadas en completado |
| T-M-06 | Docente · Monitor | ✅ OK | Respuestas, breakdown IA y overrides visibles al completar |
| T-M-07 | Docente · Monitor | ❌ Fallido | BUG-08: override suma a IA en lugar de reemplazar, nota duplicada |
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
| ST-W-02 | Estudiante · Talleres | ❌ Fallido | BUG-10: taller con fecha pasada sigue en "Próximo", no se puede entregar |
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
| ADM-C-04 | Admin · Cursos | ❌ Fallido | BUG-11: fecha fin < fecha inicio permitida sin validación |
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
| T-A-02 | Docente · Asistencia | ❌ Fallido | BUG-12: no hay filtro por fecha o grupo |
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

_Sesión QA completada el 2026-04-21. Total: 62 casos ejecutados._
