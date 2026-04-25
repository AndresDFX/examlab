# Plan de pruebas QA — ExamLab

Documento orientado a asegurar cobertura funcional por **rol** y por **módulo**. Actualizar la columna **Estado** durante el ciclo de pruebas.

---

## Cómo usar este documento

| Columna            | Uso                                                                              |
| ------------------ | -------------------------------------------------------------------------------- |
| **ID**             | Identificador estable para seguimiento en tickets o hojas de cálculo.            |
| **Módulo**         | Área funcional de la aplicación.                                                 |
| **Rol**            | Quién ejecuta la prueba: `Todos`, `Admin`, `Docente`, `Estudiante`.              |
| **Prioridad**      | `P0` bloqueante, `P1` alta, `P2` media, `P3` baja.                               |
| **Caso de prueba** | Qué hacer y qué resultado se espera.                                             |
| **Estado**         | Marcar durante QA: `Pendiente`, `En curso`, `OK`, `Fallido`, `Bloqueado`, `N/A`. |

**Roles de la aplicación:** `Administrador`, `Docente`, `Estudiante` (definidos en `user_roles`). Un usuario puede tener más de un rol y **cambiar rol activo** desde el sidebar.

**Entornos sugeridos:** Staging con datos representativos; navegadores principales (Chromium, Firefox, Safari/WebKit); vista **escritorio** y **móvil** (layout responsive).

**Complemento automatizado:** Antes de iniciar el QA manual, ejecutar `npm run test:run` y confirmar que los 40+ tests de `src/utils/*.test.ts` y `src/test/proctoring-integration.test.ts` pasan. Esto valida temporizador, proctoring y calificación sin necesidad de correr la aplicación. Si algo del suite falla, **no abrir ticket manual** hasta que el suite pase — el fallo automatizado es la evidencia.

---

## Leyenda rápida — Estado

| Valor     | Significado                                              |
| --------- | -------------------------------------------------------- |
| Pendiente | No ejecutada                                             |
| En curso  | En ejecución                                             |
| OK        | Pasa criterios                                           |
| Fallido   | No cumple (anotar ID de defecto)                         |
| Bloqueado | No se puede probar (dependencia, entorno, dato faltante) |
| N/A       | No aplica al contexto                                    |

---

## 1. Acceso, autenticación y shell (varios roles)

| ID       | Módulo         | Rol        | Prioridad | Caso de prueba                                                                                                                                 | Estado    |
| -------- | -------------- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| AUTH-01  | Acceso         | Todos      | P0        | Abrir `/auth`: formulario email/contraseña visible; iniciar sesión con credenciales válidas redirige a `/app` y muestra mensaje de bienvenida. | Pendiente |
| AUTH-02  | Acceso         | Todos      | P0        | Credenciales incorrectas muestran error claro y no crean sesión.                                                                               | Pendiente |
| AUTH-03  | Acceso         | Todos      | P1        | Con sesión activa, visitar `/auth` redirige al área interna (`/app`).                                                                          | Pendiente |
| AUTH-04  | Acceso         | Todos      | P0        | Sin sesión, intentar abrir `/app` redirige a login.                                                                                            | Pendiente |
| SHELL-01 | Shell / layout | Todos      | P1        | Sidebar (escritorio): enlaces según rol activo; Dashboard siempre visible para roles asignados.                                                | Pendiente |
| SHELL-02 | Shell / layout | Todos      | P1        | Barra superior móvil: acceso a navegación y rol; contenido usable sin solaparse.                                                               | Pendiente |
| SHELL-03 | Shell / layout | Multi-rol  | P0        | Si el usuario tiene más de un rol, el selector cambia menú y contexto (Docente vs Estudiante, etc.) sin errores.                               | Pendiente |
| SHELL-04 | Shell / layout | Todos      | P2        | Tema claro/oscuro (toggle): se aplica y persiste razonablemente entre recargas.                                                                | Pendiente |
| SHELL-05 | Shell / layout | Todos      | P2        | Cambiar contraseña (diálogo): flujo completo según política del producto (éxito / error visible).                                              | Pendiente |
| SHELL-06 | Shell / layout | Todos      | P1        | Cerrar sesión: termina sesión y vuelve a pantalla de login.                                                                                    | Pendiente |
| SHELL-07 | Notificaciones | Todos      | P1        | Campana / panel de notificaciones: listar, marcar leídas donde aplique; coherencia con dashboard.                                              | Pendiente |
| DASH-01  | Dashboard      | Admin      | P1        | Panel muestra métricas (usuarios, cursos, exámenes, entregas, talleres) y accesos a administración sin error.                                  | Pendiente |
| DASH-02  | Dashboard      | Docente    | P1        | Tarjetas, próximos exámenes/talleres y enlaces rápidos cargan datos coherentes con permisos.                                                   | Pendiente |
| DASH-03  | Dashboard      | Estudiante | P1        | Estadísticas y listas (exámenes/talleres pendientes, completados, cursos) coherentes con matrícula y asignaciones.                             | Pendiente |
| DASH-04  | Dashboard      | Todos      | P2        | Bloque de notificaciones recientes en `/app`: clic marca como leída cuando corresponde.                                                        | Pendiente |

---

## 2. Administrador — Usuarios (`/app/admin/users`)

| ID       | Módulo           | Rol                  | Prioridad | Caso de prueba                                                                                                | Estado    |
| -------- | ---------------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| ADM-U-01 | Admin · Usuarios | Admin                | P0        | Listado de usuarios/perfiles carga sin error para rol Admin.                                                  | Pendiente |
| ADM-U-02 | Admin · Usuarios | Admin                | P0        | Crear o editar usuario (según UI): cambios persisten y reflejan roles esperados.                              | Pendiente |
| ADM-U-03 | Admin · Usuarios | Admin                | P1        | Asignación de roles (`Admin`, `Docente`, `Estudiante`): usuario puede iniciar sesión con capacidades acordes. | Pendiente |
| ADM-U-04 | Admin · Usuarios | Admin                | P2        | Importación CSV (si existe): archivo válido procesa; archivo inválido muestra error comprensible.             | Pendiente |
| ADM-U-05 | Admin · Usuarios | Docente / Estudiante | P2        | Sin rol Admin, acceso directo a `/app/admin/users` debe denegarse o redirigir (según diseño).                 | Pendiente |

---

## 3. Administrador — Cursos (`/app/admin/courses`)

| ID       | Módulo         | Rol   | Prioridad | Caso de prueba                                                                                                                                                        | Estado    |
| -------- | -------------- | ----- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| ADM-C-01 | Admin · Cursos | Admin | P0        | Listado de cursos con periodos/fechas visible y consistente.                                                                                                          | Pendiente |
| ADM-C-02 | Admin · Cursos | Admin | P0        | Alta/edición de curso: guardar y ver reflejo en listado y en flujos docente/estudiante.                                                                               | Pendiente |
| ADM-C-03 | Admin · Cursos | Admin | P1        | Matrícula de estudiantes / gestión de enrollments (según pantalla): estudiante matriculado ve curso en su módulo de cursos y recibe asignaciones cuando correspondan. | Pendiente |
| ADM-C-04 | Admin · Cursos | Admin | P2        | Validaciones de fechas y campos obligatorios impiden datos inconsistentes con mensajes claros.                                                                        | Pendiente |

---

## 4. Docente — Cursos (`/app/teacher/courses`)

| ID     | Módulo           | Rol        | Prioridad | Caso de prueba                                                                       | Estado    |
| ------ | ---------------- | ---------- | --------- | ------------------------------------------------------------------------------------ | --------- |
| T-C-01 | Docente · Cursos | Docente    | P1        | Lista de cursos asignados al docente; datos alineados con backend.                   | Pendiente |
| T-C-02 | Docente · Cursos | Docente    | P2        | Acciones disponibles (ver detalle, enlaces a exámenes/talleres según UI) funcionan.  | Pendiente |
| T-C-03 | Docente · Cursos | Estudiante | P2        | Estudiante no debe gestionar estos cursos como docente (acceso denegado o sin menú). | Pendiente |

---

## 5. Docente — Exámenes (`/app/teacher/exams`, `/app/teacher/exams/$examId`)

| ID     | Módulo             | Rol     | Prioridad | Caso de prueba                                                                                                                  | Estado    |
| ------ | ------------------ | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| T-E-01 | Docente · Exámenes | Docente | P0        | Listado de exámenes; crear nuevo examen abre flujo de edición.                                                                  | Pendiente |
| T-E-02 | Docente · Exámenes | Docente | P0        | Configurar título, curso, ventana `start_time` / `end_time`, duración `time_limit_minutes`, tipo de navegación entre preguntas. | Pendiente |
| T-E-03 | Docente · Exámenes | Docente | P1        | Añadir/editar/ordenar preguntas (tipos soportados: opción múltiple, desarrollo, código, etc.); guardar sin pérdida de datos.    | Pendiente |
| T-E-04 | Docente · Exámenes | Docente | P1        | Asignación de examen a estudiantes o curso (según modelo): solo estudiantes asignados lo ven.                                   | Pendiente |
| T-E-05 | Docente · Exámenes | Docente | P2        | Examen supletorio / `parent_exam_id` (si aplica): etiqueta y comportamiento correctos en listados.                              | Pendiente |
| T-E-06 | Docente · Exámenes | Docente | P1        | Enlace o botón al **Monitor** del examen abre `/app/teacher/monitor/$examId`.                                                   | Pendiente |

---

## 6. Docente — Monitor en vivo (`/app/teacher/monitor/$examId`)

| ID     | Módulo            | Rol        | Prioridad | Caso de prueba                                                                                                                                                                                                            | Estado    |
| ------ | ----------------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| T-M-01 | Docente · Monitor | Docente    | P0        | Tabla de estudiantes con estado: `En progreso`, `Completado`, `Sospechoso` según `submissions.status`.                                                                                                                    | Pendiente |
| T-M-02 | Docente · Monitor | Docente    | P1        | Tras **entrega manual** del estudiante, estado pasa a completado (actualización en lista en tiempo razonable: realtime o refresco automático).                                                                            | Pendiente |
| T-M-03 | Docente · Monitor | Docente    | P1        | Tras **fin de tiempo automático**, mismo criterio: no permanece "En progreso" si el servidor registró `completado`.                                                                                                       | Pendiente |
| T-M-04 | Docente · Monitor | Docente    | P1        | Controles de temporizador globales/por estudiante: pausa, reanudar, añadir tiempo; estudiante recibe comportamiento acorde (toast/timer).                                                                                 | Pendiente |
| T-M-05 | Docente · Monitor | Docente    | P0        | Botón **"ver respuestas"** solo se habilita para filas con estado `completado` o `sospechoso`; está deshabilitado mientras el estudiante está `en_progreso`.                                                              | Pendiente |
| T-M-06 | Docente · Monitor | Docente    | P1        | Al abrir el visor en una entrega `completado/sospechoso`, se ven las respuestas, el breakdown de IA, y (si existe) los overrides manuales por pregunta.                                                                   | Pendiente |
| T-M-07 | Docente · Monitor | Docente    | P1        | **Override manual por pregunta**: editar la nota de una pregunta guarda en `answers.__manual_overrides[qid]` y recalcula `final_override_grade` automáticamente; limpiar el campo elimina el override.                    | Pendiente |
| T-M-08 | Docente · Monitor | Docente    | P1        | **Recalificar con IA una pregunta**: el edge function recibe `questionId` y actualiza solo ese item del breakdown sin alterar las otras preguntas.                                                                        | Pendiente |
| T-M-09 | Docente · Monitor | Docente    | P1        | **Calificación IA al cierre**: la IA corre al entregar el examen (manual o por tiempo) — no mientras el estudiante escribe. Confirmable revisando que no hay llamadas al endpoint `ai-grade-submission` antes del submit. | Pendiente |
| T-M-10 | Docente · Monitor | Docente    | P2        | Eliminar entrega (si existe confirmación): fila desaparece y datos consistentes.                                                                                                                                          | Pendiente |
| T-M-11 | Docente · Monitor | Docente    | P2        | Advertencias de proctoring listadas en el detalle: cada evento muestra fecha/hora legible y etiqueta en español (tanto para claves nuevas `pestaña/copiar/...` como antiguas `blur/copy/...`).                            | Pendiente |
| T-M-12 | Docente · Monitor | Estudiante | P2        | Estudiante no puede abrir monitor de docente (denegación).                                                                                                                                                                | Pendiente |

---

## 7. Docente — Calificaciones (`/app/teacher/gradebook`)

| ID     | Módulo                   | Rol     | Prioridad | Caso de prueba                                                                     | Estado    |
| ------ | ------------------------ | ------- | --------- | ---------------------------------------------------------------------------------- | --------- |
| T-G-01 | Docente · Calificaciones | Docente | P1        | Vista tipo matriz o tabla por curso/examen; datos cargan para docente.             | Pendiente |
| T-G-02 | Docente · Calificaciones | Docente | P2        | Exportación CSV (si existe): archivo descargable y campos correctos.               | Pendiente |
| T-G-03 | Docente · Calificaciones | Docente | P2        | Edición de calificación override donde aplique se refleja en estudiante y monitor. | Pendiente |

---

## 8. Docente — Talleres (`/app/teacher/workshops`)

| ID     | Módulo             | Rol     | Prioridad | Caso de prueba                                                                 | Estado    |
| ------ | ------------------ | ------- | --------- | ------------------------------------------------------------------------------ | --------- |
| T-W-01 | Docente · Talleres | Docente | P1        | Crear taller: título, curso, fechas, estado `published`/`draft` según flujo.   | Pendiente |
| T-W-02 | Docente · Talleres | Docente | P1        | Asignación a estudiantes/cursos; estudiante matriculado ve taller en su lista. | Pendiente |
| T-W-03 | Docente · Talleres | Docente | P2        | Revisión de entregas de taller (archivos/comentarios según UI).                | Pendiente |

---

## 9. Docente — Asistencia (`/app/teacher/attendance`)

| ID     | Módulo               | Rol     | Prioridad | Caso de prueba                                                           | Estado    |
| ------ | -------------------- | ------- | --------- | ------------------------------------------------------------------------ | --------- |
| T-A-01 | Docente · Asistencia | Docente | P1        | Selección de curso/sesión y registro de asistencia guarda correctamente. | Pendiente |
| T-A-02 | Docente · Asistencia | Docente | P2        | Listados o filtros por fecha/grupo funcionan sin errores de UI.          | Pendiente |

---

## 10. Estudiante — Exámenes (`/app/student/exams`)

| ID      | Módulo                | Rol        | Prioridad | Caso de prueba                                                                                                                                                                                                                                     | Estado    |
| ------- | --------------------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| ST-E-01 | Estudiante · Exámenes | Estudiante | P0        | Solo aparecen exámenes asignados; badges de Disponible / Próximo / Cerrado / Entregado coherentes con fechas.                                                                                                                                      | Pendiente |
| ST-E-02 | Estudiante · Exámenes | Estudiante | P1        | Con intento `en_progreso` y ventana **abierta**, botón "Reanudar examen" navega al take.                                                                                                                                                           | Pendiente |
| ST-E-03 | Estudiante · Exámenes | Estudiante | P1        | Con intento `en_progreso` y ventana **cerrada** (fin de `end_time`), **no** debe ofrecer reanudar como acción disponible (botón deshabilitado / mensaje de ventana cerrada).                                                                       | Pendiente |
| ST-E-04 | Estudiante · Exámenes | Estudiante | P1        | Tras entrega completada, acceso a revisión/detalle vía botón "Ver detalle y retroalimentación" que navega a `/app/student/review/$examId`.                                                                                                         | Pendiente |
| ST-E-05 | Estudiante · Exámenes | Estudiante | P0        | **Control temporal** de botón de inicio: con `start_time` en el pasado y `end_time` en el futuro → habilitado; con `start_time` en el futuro → deshabilitado y muestra "Próximo"; con `end_time` en el pasado → deshabilitado y muestra "Cerrado". | Pendiente |

---

## 11. Estudiante — Presentación del examen (`/app/student/take/$examId`)

| ID      | Módulo                 | Rol        | Prioridad | Caso de prueba                                                                                                                                                                                       | Estado    |
| ------- | ---------------------- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| ST-T-01 | Estudiante · Take exam | Estudiante | P0        | Inicio de examen crea `submission` y permite navegar preguntas según `navigation_type`.                                                                                                              | Pendiente |
| ST-T-02 | Estudiante · Take exam | Estudiante | P1        | Autoguardado de respuestas; al recargar página reanuda sin perder respuestas locales/servidor.                                                                                                       | Pendiente |
| ST-T-03 | Estudiante · Take exam | Estudiante | P0        | **Temporizador absoluto**: cuenta hacia `exam.end_time`, no hacia `time_limit_minutes` desde el inicio. Un estudiante que entra 10 min tarde a una ventana 17:00→18:00 ve ~50 min restantes (no 60). | Pendiente |
| ST-T-04 | Estudiante · Take exam | Estudiante | P0        | **No se resetea al recargar**: tras recargar la pestaña el timer muestra los segundos restantes reales, no el máximo.                                                                                | Pendiente |
| ST-T-05 | Estudiante · Take exam | Estudiante | P0        | Al llegar a cero el tiempo global, **entrega automática** sin modal obligatorio de "tiempo agotado"; estado en servidor `completado`; se dispara la calificación IA una sola vez.                    | Pendiente |
| ST-T-06 | Estudiante · Take exam | Estudiante | P1        | Entrega manual con preguntas sin responder: modal de confirmación; entrega guarda estado `completado`.                                                                                               | Pendiente |
| ST-T-07 | Estudiante · Take exam | Estudiante | P1        | **Proctoring — blur/focus**: al cambiar de pestaña o perder foco de la ventana, el contador de `focus_warnings` sube en 1 y se dispara un autosave.                                                  | Pendiente |
| ST-T-08 | Estudiante · Take exam | Estudiante | P1        | **Proctoring — copiar/pegar/menú contextual**: intentos de copiar, pegar o abrir menú contextual registran evento tipado (`copiar` / `pegar` / `menu`) y suman advertencia.                          | Pendiente |
| ST-T-09 | Estudiante · Take exam | Estudiante | P0        | **Proctoring — suspensión**: al alcanzar `MAX_WARNINGS=3` advertencias, la `submission` pasa a estado `sospechoso` y el examen se bloquea o finaliza según diseño.                                   | Pendiente |
| ST-T-10 | Estudiante · Take exam | Estudiante | P2        | Si falla persistencia en servidor al entregar, usuario recibe error y **no** debe ver éxito engañoso ni perder datos locales cuando exista salvaguarda offline (IndexedDB).                          | Pendiente |
| ST-T-11 | Estudiante · Take exam | Estudiante | P3        | Modo offline / reconexión: comportamiento documentado (sincronización de respuestas).                                                                                                                | Pendiente |

---

## 12. Estudiante — Revisión y retroalimentación (`/app/student/review/$examId`)

| ID      | Módulo                | Rol        | Prioridad | Caso de prueba                                                                                                                                                                                                 | Estado    |
| ------- | --------------------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| ST-R-01 | Estudiante · Revisión | Estudiante | P1        | Tras examen completado y calificación disponible, ver nota desglose, feedback por pregunta o global según UI.                                                                                                  | Pendiente |
| ST-R-02 | Estudiante · Revisión | Estudiante | P1        | **Retroalimentación por pregunta**: cada pregunta muestra su respuesta, puntaje obtenido y feedback. Si existe override manual del docente para esa pregunta, ese feedback prevalece sobre el generado por IA. | Pendiente |
| ST-R-03 | Estudiante · Revisión | Estudiante | P2        | Enlaces desde listado de exámenes al review correctos para el `examId`.                                                                                                                                        | Pendiente |

---

## 13. Estudiante — Talleres (`/app/student/workshops`, `/app/student/workshop/$workshopId`)

| ID      | Módulo                | Rol        | Prioridad | Caso de prueba                                                                | Estado    |
| ------- | --------------------- | ---------- | --------- | ----------------------------------------------------------------------------- | --------- |
| ST-W-01 | Estudiante · Talleres | Estudiante | P1        | Lista de talleres asignados; estados alineados con fechas de entrega.         | Pendiente |
| ST-W-02 | Estudiante · Talleres | Estudiante | P1        | Entrada al detalle del taller y envío de archivos/texto según especificación. | Pendiente |
| ST-W-03 | Estudiante · Talleres | Estudiante | P2        | Taller vencido muestra indicación clara; reglas de reentrega si existen.      | Pendiente |

---

## 14. Estudiante — Cursos (`/app/student/courses`)

| ID      | Módulo              | Rol        | Prioridad | Caso de prueba                                                | Estado    |
| ------- | ------------------- | ---------- | --------- | ------------------------------------------------------------- | --------- |
| ST-C-01 | Estudiante · Cursos | Estudiante | P2        | Lista de cursos matriculados y metadatos (periodo, nombre).   | Pendiente |
| ST-C-02 | Estudiante · Cursos | Estudiante | P3        | Enlaces o información complementaria sin errores de permisos. | Pendiente |

---

## 15. Estudiante — Notas (`/app/student/grades`)

| ID      | Módulo             | Rol        | Prioridad | Caso de prueba                                                                           | Estado    |
| ------- | ------------------ | ---------- | --------- | ---------------------------------------------------------------------------------------- | --------- |
| ST-N-01 | Estudiante · Notas | Estudiante | P1        | Consolidado de calificaciones de exámenes/talleres visibles solo para el propio usuario. | Pendiente |
| ST-N-02 | Estudiante · Notas | Estudiante | P2        | Coherencia con calificaciones del gradebook docente y con review.                        | Pendiente |

---

## 16. Integración y regresión cruzada

| ID     | Módulo      | Rol                  | Prioridad | Caso de prueba                                                                                                                              | Estado    |
| ------ | ----------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| INT-01 | Integración | Docente + Estudiante | P0        | Flujo extremo a extremo: crear examen → asignar → estudiante realiza → docente ve monitor y calificaciones → estudiante ve nota y revisión. | Pendiente |
| INT-02 | Integración | Admin + Docente      | P1        | Crear curso y matricular estudiante → docente asigna examen en ese curso → estudiante lo ve.                                                | Pendiente |
| INT-03 | Integración | Todos                | P2        | Notificaciones (p. ej. examen sospechoso): docente recibe aviso enlazando al monitor cuando aplique política del sistema.                   | Pendiente |
| REG-01 | Regresión   | Todos                | P2        | Tras cambios de UI, repetir AUTH-01, ST-T-04, T-M-03 en una pasada corta antes de release.                                                  | Pendiente |

---

## 17. No funcionales (opcional pero recomendado)

| ID     | Módulo        | Rol   | Prioridad | Caso de prueba                                                                                        | Estado    |
| ------ | ------------- | ----- | --------- | ----------------------------------------------------------------------------------------------------- | --------- |
| NFR-01 | Rendimiento   | Todos | P3        | Tiempos de carga aceptables en dashboard y take exam con red simulada “Fast 3G”.                      | Pendiente |
| NFR-02 | Accesibilidad | Todos | P3        | Navegación básica por teclado en login y entrega de examen (foco visible).                            | Pendiente |
| NFR-03 | Seguridad     | Todos | P2        | No exponer datos de un usuario al manipular `examId`/IDs en URL de otro estudiante (errores o vacío). | Pendiente |

---

## 18. Guía del desarrollador — Escenarios críticos automatizables

Esta sección condensa las tres áreas **bloqueantes para el release** y cómo
validarlas combinando el suite automatizado (`npm run test:run`) con un paso
manual confirmatorio. Si un caso del suite falla, esa es la verdad — abrir
ticket solo si el suite pasa pero el comportamiento manual diverge.

### 18.1 Lógica del temporizador

Suite: [src/utils/exam-time.test.ts](../src/utils/exam-time.test.ts)

| ID           | Escenario                                                                                              | Cobertura automatizada                                                  | Confirmación manual                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| DEV-TIMER-01 | Timer cuenta hacia `end_time` absoluto, no hacia duración máxima.                                      | `computeSecondsLeft` con `end` y varios `now`.                          | Abrir examen con `start_time` hace 10 min y `end_time` en 50 min; el header muestra ~50:00, no 60:00. |
| DEV-TIMER-02 | Recalcular el timer en ticks sucesivos **no** lo devuelve al máximo (anti-regresión del bug de reset). | Test `does not reset to initial duration when recomputed across ticks`. | Recargar la pestaña en la mitad del examen; el timer reanuda cerca del valor que tenía, no al máximo. |
| DEV-TIMER-03 | Se clampa a 0 cuando el examen ya terminó; devuelve 0 con entradas inválidas.                          | Tests de `ago1h`, null, "not-a-date".                                   | Forzar `end_time` en el pasado vía SQL; el estudiante no ve número negativo.                          |
| DEV-TIMER-04 | `formatTimerMMSS` produce `MM:SS` con ceros a la izquierda.                                            | Tests de 0, 9, 65, 3600, -10.                                           | Ver header a las 00:59 → 01:00 al cruzar el minuto.                                                   |

### 18.2 Lógica del proctoring (seguridad)

Suite: [src/utils/proctoring.test.ts](../src/utils/proctoring.test.ts) y
[src/test/proctoring-integration.test.ts](../src/test/proctoring-integration.test.ts)

| ID           | Escenario                                                                                                                         | Cobertura automatizada                          | Confirmación manual                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| DEV-PROCT-01 | `window.blur` incrementa el contador en 1 y dispara autosave.                                                                     | Integration test con listener real sobre jsdom. | Alt-tab durante un examen → el contador en header sube a 1/3.                                                       |
| DEV-PROCT-02 | `visibilitychange` a `hidden` cuenta como advertencia; volver a `visible` **no**.                                                 | Dos tests separados para cada transición.       | Minimizar ventana → cuenta sube. Restaurar foco → no sube.                                                          |
| DEV-PROCT-03 | Al cruzar `MAX_WARNINGS=3` la submission pasa a `sospechoso`.                                                                     | Test que itera 3 blurs y verifica flip.         | Provocar 3 alt-tabs → UI muestra "sospechoso" y se cierra el examen.                                                |
| DEV-PROCT-04 | `warningLabel` devuelve la misma etiqueta en español tanto para claves nuevas (`pestaña`, `copiar`) como legacy (`blur`, `copy`). | Tests explícitos por cada par.                  | Abrir el monitor con entregas antiguas (claves en inglés) y nuevas (en español) — ambas muestran los mismos textos. |
| DEV-PROCT-05 | `warningEventTimestamp` acepta `at` ISO, `at` ms y `ts` ms.                                                                       | Tres tests de normalización.                    | Ver listado de eventos en monitor: todos con fecha legible, sin "—" cuando hay timestamp.                           |

### 18.3 Control de acceso temporal

Suite: [src/utils/exam-time.test.ts](../src/utils/exam-time.test.ts) (bloque `getExamAccessState` / `isExamOpen`)

| ID            | Escenario                                                                                                                  | Cobertura automatizada                       | Confirmación manual                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| DEV-ACCESS-01 | `start_time` en el **futuro** → estado `upcoming` → botón de inicio **deshabilitado**.                                     | Test `returns upcoming for a future window`. | Crear examen con inicio mañana; listado del estudiante muestra badge "Próximo" y botón deshabilitado. |
| DEV-ACCESS-02 | `start_time <= now <= end_time` → estado `open` → botón **habilitado**.                                                    | Test `returns open for an active window`.    | Listado muestra "Disponible" y permite iniciar.                                                       |
| DEV-ACCESS-03 | `end_time` en el **pasado** → estado `closed` → botón deshabilitado; si había intento `en_progreso`, no se puede reanudar. | Test `returns closed for a past window`.     | Ajustar `end_time` al pasado vía SQL; el botón "Reanudar" desaparece o queda deshabilitado.           |
| DEV-ACCESS-04 | Fechas inválidas no rompen la UI: devuelven `closed`.                                                                      | Test `returns closed for invalid dates`.     | Modificar manualmente una fecha a string vacío — no crash, solo queda cerrado.                        |

### 18.4 Calificación

Suite: [src/utils/grade.test.ts](../src/utils/grade.test.ts)

| ID           | Escenario                                                    | Cobertura automatizada                          | Confirmación manual                                                                                          |
| ------------ | ------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| DEV-GRADE-01 | Suma `earned / totalPoints * 10` con redondeo a 2 decimales. | Tests de 10, 5, 3 y parciales.                  | Monitor recalcula al guardar override.                                                                       |
| DEV-GRADE-02 | Override manual gana sobre breakdown IA para la misma `qid`. | Test explícito con override vs IA.              | En el monitor, cambiar nota manual de una pregunta → final sube/baja pero IA en otras preguntas se mantiene. |
| DEV-GRADE-03 | Sin datos devuelve `null` (UI muestra "—", no "0").          | Tests de lista vacía y sin breakdown/overrides. | Antes de que corra la IA, la columna nota muestra "—".                                                       |

### 18.5 Correr el suite en local

```bash
npm run test          # modo watch durante desarrollo
npm run test:run      # una pasada (usar en CI / pre-release)
```

El archivo de configuración es [vitest.config.ts](../vitest.config.ts) con
entorno `jsdom`, setup en [src/test/setup.ts](../src/test/setup.ts).

---

## 24. FASE 6 — Talleres tipo examen, calificación automática, validación Mermaid y asistencia P/A

> **Regla estricta.** Esta sección **reemplaza** los planes de FASES 3, 4 y 5 (ya gestionadas y verificadas en producción) por los nuevos casos focales de FASE 6. Las secciones §1–§18 siguen siendo el plan base permanente y NO deben modificarse.

### 24.1 Editor de preguntas del taller (docente) — `/app/teacher/workshops`

| ID      | Caso                                                                                                                                                                              | Estado |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 24.1.1  | El listado de talleres muestra el botón **Preguntas** (icono `ListChecks`) por fila, además de los botones existentes (Asignación, Calificar, Editar, Eliminar).                  | [ ]    |
| 24.1.2  | Al hacer clic en **Preguntas**, se abre un dialog con el `TeacherWorkshopQuestionsEditor` y dos pestañas: **Manual** e **IA**.                                                    | [ ]    |
| 24.1.3  | **Manual / Abierta**: se puede crear una pregunta tipo `abierta` con `content`, `expected_rubric` y `points`. Se persiste en `workshop_questions` con `position` correlativo.     | [ ]    |
| 24.1.4  | **Manual / Cerrada**: se pueden definir 2–4 opciones y marcar la correcta. Se persiste como `selected_option` esperada en `options.correct`.                                      | [ ]    |
| 24.1.5  | **Manual / Código**: se puede definir `starter_code`, `language` (java por defecto) y `expected_rubric`. La pregunta se guarda con `type='codigo'`.                               | [ ]    |
| 24.1.6  | **Manual / Diagrama**: se puede crear una pregunta `diagrama` con `expected_rubric`. El estudiante deberá responder con código Mermaid válido.                                    | [ ]    |
| 24.1.7  | **IA**: introduciendo temas + tipo + cantidad y pulsando "Generar", la edge function `ai-generate-questions` (modo `workshop`) devuelve N preguntas y se persisten en bloque.     | [ ]    |
| 24.1.8  | Al cerrar y reabrir el dialog, las preguntas previamente creadas siguen visibles y ordenadas por `position`.                                                                      | [ ]    |
| 24.1.9  | Eliminar una pregunta pide confirmación y la elimina de `workshop_questions` sin borrar el resto.                                                                                 | [ ]    |
| 24.1.10 | El idioma del curso (`courses.language`) se propaga al editor (`courseLanguage` prop) y se usa en los prompts de IA para generar preguntas en el idioma correcto.                 | [ ]    |

### 24.2 Presentación del taller (estudiante) — `/app/student/workshops`

| ID      | Caso                                                                                                                                                                                  | Estado |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 24.2.1  | En cada card de taller publicado y dentro de fecha, aparece el botón **Responder preguntas** (icono `ListChecks`) además del existente "Entregar taller".                             | [ ]    |
| 24.2.2  | Si el taller NO tiene preguntas en `workshop_questions`, el componente `StudentWorkshopTaker` muestra un mensaje "Este taller no tiene preguntas". No se rompe la UI.                 | [ ]    |
| 24.2.3  | Si el taller tiene preguntas, se renderizan ordenadas por `position` con el componente adecuado: `Textarea` (abierta), `RadioGroup` (cerrada), `CodeEditor` (código), `DiagramEditor` (diagrama). | [ ]    |
| 24.2.4  | El botón "Calificar pregunta" envía la respuesta a la edge function `ai-grade-submission` con `mode: workshopQuestionGrading` y persiste `ai_grade` y `ai_feedback` en `workshop_submission_answers`. | [ ]    |
| 24.2.5  | Tras calificar todas las preguntas, el botón "Finalizar y calcular nota" suma ponderadamente (`SUM(ai_grade * points) / SUM(points) * max_score`) y actualiza `workshop_submissions.final_grade` y `status='ai_revisado'`. | [ ]    |
| 24.2.6  | Si el taller está vencido (`due_date < now()`), el botón "Responder preguntas" no aparece — solo se permite ver feedback existente.                                                  | [ ]    |
| 24.2.7  | Si el estudiante refresca a mitad de respuesta, las respuestas previamente calificadas se restauran (`workshop_submission_answers` filtrado por `submission_id`).                     | [ ]    |

### 24.3 Validación de Mermaid e IA por tipo de pregunta

| ID      | Caso                                                                                                                                                                                                       | Estado |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 24.3.1  | Pregunta tipo **diagrama**: si el estudiante envía un diagrama Mermaid sintácticamente inválido, la IA detecta el error de parse, devuelve `ai_grade=0` y `ai_feedback` describe el error de sintaxis.     | [ ]    |
| 24.3.2  | Pregunta tipo **diagrama**: si el diagrama es válido pero NO responde a la rúbrica (e.g. flowchart cuando se pide secuencia), la IA penaliza la pertinencia (`ai_grade < points * 0.5`).                   | [ ]    |
| 24.3.3  | Pregunta tipo **diagrama**: un diagrama válido y pertinente recibe una nota cercana a `points` con feedback positivo.                                                                                      | [ ]    |
| 24.3.4  | Pregunta tipo **código**: la IA evalúa correctitud algorítmica + estilo + cumplimiento de la rúbrica. Si hay `test_cases`, los considera en el feedback.                                                   | [ ]    |
| 24.3.5  | Pregunta tipo **cerrada**: la calificación es determinista (no usa IA). Si `selected_option == options.correct`, otorga `points`; en caso contrario, `0`.                                                  | [ ]    |
| 24.3.6  | Pregunta tipo **abierta**: la IA puntúa según la rúbrica con feedback narrativo en el idioma del curso.                                                                                                    | [ ]    |
| 24.3.7  | Si la edge function devuelve **429** (rate limit) o **402** (créditos), la UI del estudiante muestra un toast claro ("Servicio de IA no disponible — intenta más tarde") y NO marca la pregunta calificada. | [ ]    |

### 24.4 Carga de código (`CodeEditor`) en preguntas tipo `codigo`

| ID      | Caso                                                                                                                                                                              | Estado |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 24.4.1  | El `CodeEditor` carga el `starter_code` definido por el docente al abrir la pregunta por primera vez.                                                                             | [ ]    |
| 24.4.2  | El estudiante puede editar el código, cambiar `language` si el editor lo permite, y enviar.                                                                                       | [ ]    |
| 24.4.3  | El código se persiste en `workshop_submission_answers.code_content` y NO en `answer_text`.                                                                                        | [ ]    |
| 24.4.4  | Al recargar la página, el código previamente enviado se restaura en el editor.                                                                                                    | [ ]    |
| 24.4.5  | Si el estudiante envía cadena vacía, la UI bloquea el envío y muestra "El código no puede estar vacío".                                                                           | [ ]    |

### 24.5 Selector de asistencia P/A — `/app/teacher/attendance`

| ID      | Caso                                                                                                                                                                              | Estado |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 24.5.1  | Encima de la grilla de estudiantes se muestra una **leyenda** explicando: **P = Presente**, **A = Ausente**.                                                                      | [ ]    |
| 24.5.2  | Cada selector de estado en la fila del estudiante muestra únicamente **`P`** o **`A`** (sin texto adicional como "Presente" / "Ausente").                                         | [ ]    |
| 24.5.3  | El cambio de estado persiste correctamente en `attendance_records.status` (valores `presente` / `ausente` en BD).                                                                 | [ ]    |
| 24.5.4  | La leyenda y los selectores son legibles tanto en desktop (≥1024px) como en mobile (≤640px).                                                                                      | [ ]    |
| 24.5.5  | El cambio de estado NO recarga toda la tabla — solo actualiza el registro modificado (UX fluida).                                                                                 | [ ]    |
| 24.5.6  | Las pestañas / filtros existentes (sesión, fecha) siguen funcionando sin regresión.                                                                                               | [ ]    |

### 24.6 Calificación automática del taller — flujo end-to-end

| ID      | Caso                                                                                                                                                                              | Estado |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 24.6.1  | El docente crea un taller con preguntas mixtas (1 abierta, 1 cerrada, 1 código, 1 diagrama), `max_score=100` y `points` distintos por pregunta.                                   | [ ]    |
| 24.6.2  | El estudiante responde y califica las 4 preguntas. Cada `ai_grade` se persiste por separado en `workshop_submission_answers`.                                                     | [ ]    |
| 24.6.3  | Al pulsar "Finalizar", `final_grade` se calcula como suma ponderada (Σ `ai_grade * points`) / (Σ `points`) × `max_score`. La fórmula es verificable manualmente en BD.            | [ ]    |
| 24.6.4  | El `status` del `workshop_submissions` cambia a `ai_revisado` al finalizar la calificación automática.                                                                            | [ ]    |
| 24.6.5  | El docente puede ver la entrega en la UI de calificación existente y **sobrescribir** `final_grade` manualmente — el override se respeta y NO se recalcula con IA.                 | [ ]    |
| 24.6.6  | Si el estudiante recalifica una pregunta, su `ai_grade` se actualiza y `final_grade` se recalcula al "Finalizar" de nuevo (sin duplicar registros en `workshop_submission_answers`). | [ ]    |
| 24.6.7  | El modo **clásico** del taller (entrega libre con archivo / link / contenido) sigue funcionando sin regresión — los dos modos coexisten.                                          | [ ]    |

### 24.7 Compatibilidad y regresión cruzada

| ID      | Caso                                                                                                                                                                          | Estado |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 24.7.1  | Talleres antiguos sin preguntas (`workshop_questions` vacío) siguen comportándose en modo clásico exactamente como antes — botón "Entregar taller" disponible y funcional. | [ ]    |
| 24.7.2  | El monitor de exámenes (`/app/teacher/monitor/$examId`) y la calificación IA de exámenes siguen sin verse afectados por las nuevas tablas de talleres.                    | [ ]    |
| 24.7.3  | Las RLS de `workshop_questions` y `workshop_submission_answers` impiden que un estudiante acceda a respuestas/preguntas de otros (verificable via `supabase__read_query`).  | [ ]    |
| 24.7.4  | La duplicación de cursos (FASE 4/5) sigue funcionando — los talleres se duplican; las preguntas asociadas NO se duplican automáticamente (decisión consciente de FASE 6).  | [ ]    |
| 24.7.5  | El plan de cortes y notas (FASE 3) sigue calculando correctamente la nota final del curso usando `final_grade` de talleres, independientemente del modo (clásico o preguntas). | [ ]    |
| 24.7.6  | La asistencia P/A compactada NO altera el cálculo de la nota de asistencia en cortes/notas (regresión sobre FASE 3).                                                       | [ ]    |



---

## Control de versiones del documento

| Versión | Fecha      | Cambios                                                                                                                                                                                                                                                |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.0     | 2026-04-19 | Versión inicial alineada con rutas ExamLab (`/app/...`) por rol y módulo.                                                                                                                                                                              |
| 1.1     | 2026-04-20 | Monitor restringido a estados finales, override por pregunta, recalificación IA granular, control temporal explícito del botón de inicio, retroalimentación por pregunta para estudiante, sección §18 con escenarios automatizados para desarrollador. |
| 1.2     | 2026-04-21 | FASE 3 — i18n (ES default, EN opcional, idioma forzado por curso), cortes de evaluación y pesos, RBAC estricto + `/app/unauthorized`, notificaciones anti-spam para docentes y recordatorios para estudiantes (sección §19).                           |
| 1.3     | 2026-04-23 | FASE 4 — fix selector de fechas y duplicación de cursos con matrículas, talleres asignados a nivel curso, parametrización de reintentos de examen (curso + override por examen) — sección §22.                                                          |
| 1.4     | 2026-04-24 | FASE 5 — notas de apoyo aprobables por examen, toggle de copia de docentes al duplicar curso, asistencia P/A compacta y responsive, asignación de talleres por curso con exclusión de estudiantes (sección §23).                                       |
| 1.5     | 2026-04-25 | FASE 6 — talleres tipo examen con preguntas (abierta/cerrada/código/diagrama), generación y calificación IA inmediata por pregunta, validación de Mermaid, leyenda P/A en asistencia. Reemplaza secciones de fase previas (§19, §22, §23) por §24 unificada. |

---

_Generado para el proyecto ExamLab. Ajustar casos si se añaden rutas o funciones nuevas._
