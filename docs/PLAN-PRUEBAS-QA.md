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

## 19. FASE 3 — i18n, Cortes y Notificaciones

> **Regla estricta.** Esta sección **añade** casos nuevos. No elimina ni
> sobrescribe ningún caso previo de las secciones 1–18. Si un caso aquí
> depende de un flujo ya cubierto (ej. login), ese caso previo sigue siendo la
> fuente de verdad — no se duplica, solo se referencia.

**Alcance.** Validar manualmente los cambios introducidos por la fase 3:
internacionalización, modelo de evaluación por cortes, RBAC estricto y
notificaciones (push in-app + resumen diario de docentes).

### 19.1 Internacionalización (i18n)

| ID      | Descripción                                                  | Pasos                                                                                                                                                                                                                                 | Resultado esperado                                                                                                                                                                  |
| ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I18N-01 | El idioma por defecto es español al entrar por primera vez   | 1. Abrir la app en una ventana nueva (sin `localStorage` previo, usar "Incognito"). 2. Observar el shell (sidebar, dashboard, auth).                                                                                                  | Todos los textos de shell/nav/auth aparecen en español.                                                                                                                             |
| I18N-02 | Cambio manual ES → EN persiste tras recarga                  | 1. Hacer login. 2. En el footer del sidebar, abrir el switcher de idioma y elegir **English**. 3. Navegar entre rutas. 4. Recargar (Ctrl+R).                                                                                          | Tras cambiar, el shell aparece en inglés (Dashboard, Exams, Sign out…). Tras recargar, el idioma sigue en inglés (se persiste en `localStorage:examlab:lang`).                      |
| I18N-03 | Cambio EN → ES vuelve a español sin recargar                 | 1. Con el idioma en inglés, seleccionar **Español** en el switcher.                                                                                                                                                                   | Toda la UI se re-renderiza en español sin necesidad de recarga.                                                                                                                     |
| I18N-04 | Curso en inglés fuerza idioma del estudiante en el take flow | 1. Como Admin, editar un curso y poner `language='en'` (vía Supabase Studio o migración). 2. Como docente asignar un examen de ese curso a un estudiante. 3. Como estudiante (con preferencia ES), abrir `/app/student/take/$examId`. | El take flow aparece en inglés (header, botones, mensajes de tiempo) mientras está dentro del examen. Al salir a `/app/student/exams`, vuelve al idioma de preferencia del usuario. |
| I18N-05 | Curso en español no altera la preferencia del usuario        | 1. Con preferencia del usuario en inglés, abrir take de un curso con `language='es'`.                                                                                                                                                 | Take flow se muestra en español durante el examen. Al salir, se restaura inglés.                                                                                                    |
| I18N-06 | Fallback a español para claves faltantes en inglés           | 1. Cambiar a inglés. 2. Entrar a una ruta no traducida (ej. `/app/teacher/exams`).                                                                                                                                                    | Los textos no traducidos se muestran en español (default); la app no crashea ni muestra claves crudas (`exam.submit` como literal).                                                 |
| I18N-07 | IA genera preguntas en el idioma del curso                   | 1. Curso en `language='en'`. 2. Docente abre ese examen y usa "Generar con IA" sobre un tema.                                                                                                                                         | Las preguntas creadas llegan en **inglés** (enunciado + rúbrica + opciones si aplica).                                                                                              |
| I18N-08 | IA califica y da feedback en el idioma del curso             | 1. Curso en `language='en'`. 2. Estudiante entrega un examen con preguntas abiertas. 3. Docente recalifica con IA.                                                                                                                    | El `feedback` del breakdown aparece en inglés.                                                                                                                                      |
| I18N-09 | Login muestra switcher de idioma antes de autenticar         | 1. Logout. 2. Abrir `/auth`.                                                                                                                                                                                                          | Hay un switcher de idioma visible en la tarjeta de login. Cambiarlo afecta de inmediato los labels del formulario.                                                                  |

### 19.2 RBAC — rutas bloqueadas

| ID      | Descripción                                                           | Pasos                                                                                                                                                                                              | Resultado esperado                                                                                            |
| ------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| RBAC-01 | Estudiante no puede acceder a rutas de docente por URL                | 1. Login como usuario con rol **Estudiante** únicamente. 2. Pegar manualmente en la URL `/app/teacher/exams`.                                                                                      | Redirección inmediata a `/app/unauthorized`, se ve el mensaje "Sin permisos" y un botón "Ir al inicio".       |
| RBAC-02 | Estudiante no puede acceder a admin                                   | 1. Como estudiante, ir a `/app/admin/users`.                                                                                                                                                       | Redirección a `/app/unauthorized`.                                                                            |
| RBAC-03 | Docente no puede acceder a admin                                      | 1. Login como usuario con rol Docente únicamente. 2. Ir a `/app/admin/courses`.                                                                                                                    | Redirección a `/app/unauthorized`.                                                                            |
| RBAC-04 | Docente no puede ver rutas de estudiante                              | 1. Como docente, ir a `/app/student/take/xxx`.                                                                                                                                                     | Redirección a `/app/unauthorized` (aunque la ruta sería 404 si el id fuera válido, el guard dispara primero). |
| RBAC-05 | Usuario multi-rol puede cambiar a rol compatible                      | 1. Login como usuario con roles **Docente + Estudiante**. 2. Cambiar rol activo a Estudiante en el sidebar. 3. Ir a `/app/teacher/exams`.                                                          | Redirige a `/app/unauthorized`. Cambiar rol activo a Docente y repetir — ahora entra.                         |
| RBAC-06 | RLS bloquea consultas directas a la API                               | 1. Como Estudiante autenticado, abrir devtools → Network. 2. Ejecutar en consola: `supabase.from('grade_cuts').select('*').eq('course_id','...')` para un curso en el que **no** está matriculado. | La respuesta tiene `data: []` (o error de policy). Nunca devuelve cortes de cursos ajenos.                    |
| RBAC-07 | `/app/unauthorized` está accesible para cualquier usuario autenticado | 1. Como estudiante, visitar directamente `/app/unauthorized`.                                                                                                                                      | Se muestra correctamente (no hay bucle de redirección).                                                       |
| RBAC-08 | Sin sesión, cualquier `/app/*` manda a `/auth`                        | 1. Cerrar sesión. 2. Pegar `/app/teacher/grading/abc`.                                                                                                                                             | Redirección a `/auth`, no a `/app/unauthorized`.                                                              |

### 19.3 Cortes y pesos de evaluación

| ID     | Descripción                                                           | Pasos                                                                                                                                    | Resultado esperado                                                                                                                                 |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| CUT-01 | Docente accede a configuración de calificaciones de un curso asignado | 1. Login docente. 2. Ir a `/app/teacher/grading/$courseId` de un curso que le pertenece.                                                 | Carga la página con el nombre del curso, el bloque "Proyecto final vs. coursework" y la lista de cortes.                                           |
| CUT-02 | Docente **no** asignado al curso no puede ver cortes del mismo        | 1. Login como docente A. 2. Intentar abrir `/app/teacher/grading/$courseId` de un curso asignado a docente B.                            | RLS devuelve datos vacíos y la UI no muestra cortes. El guard RBAC permite la ruta (es docente) pero los datos permanecen vacíos.                  |
| CUT-03 | Suma de peso proyecto + coursework debe ser 100 para guardar          | 1. Entrar a la config. 2. Poner 60 proyecto y 30 coursework. 3. Pulsar Guardar.                                                          | Badge muestra "Suma actual: 90" en rojo; toast de error "Los pesos deben sumar 100"; no se llama al backend.                                       |
| CUT-04 | Guardar config válida (60+40) persiste                                | 1. Poner 60 proyecto + 40 coursework → Guardar. 2. Recargar.                                                                             | Los valores persisten tras recarga. Toast "Configuración guardada".                                                                                |
| CUT-05 | Crear cortes y asignar pesos que sumen 100                            | 1. Crear Corte 1, Corte 2, Final con pesos 30/30/40. 2. Observar badge en el encabezado de "Cortes".                                     | Badge "Suma actual: 100" en color de éxito (secondary).                                                                                            |
| CUT-06 | Intentar exceder 100 en suma de cortes falla en DB                    | 1. Sobre la configuración anterior, editar Corte 1 a 50.                                                                                 | Toast de error de Postgres: "La suma de pesos de cortes excede 100". El valor no queda guardado.                                                   |
| CUT-07 | Items de un corte deben sumar 100 para ser válidos                    | 1. Entrar a Corte 1. 2. Añadir 2 items (examen+taller) con pesos 50/40.                                                                  | Badge del corte muestra "Suma actual: 90". (La UI lo permite mientras editas; la validación de 100 es visual).                                     |
| CUT-08 | Intentar exceder 100 en items del mismo corte falla en DB             | 1. Con items 50/40, editar el segundo a 70.                                                                                              | Toast de error de trigger: "La suma de pesos de items del corte excede 100".                                                                       |
| CUT-09 | Eliminar un corte elimina sus items en cascada                        | 1. Crear un corte con 2 items. 2. Eliminar el corte (confirmación).                                                                      | El corte y sus items desaparecen. Ningún orphan visible tras recarga.                                                                              |
| CUT-10 | Item tipo `project` requiere título, no exam_id ni workshop_id        | 1. Crear item project. 2. Dejar título vacío.                                                                                            | El constraint de CHECK permite la fila mientras title no sea null (default "Proyecto"). Cambiar a cadena vacía debe dar error de check al guardar. |
| CUT-11 | Estudiante matriculado puede leer (SELECT) los cortes                 | 1. Como estudiante de un curso que ya tiene cortes. 2. Abrir devtools: `supabase.from('grade_cuts').select('*').eq('course_id','<id>')`. | Devuelve las filas del curso.                                                                                                                      |
| CUT-12 | Estudiante no matriculado no puede leerlos                            | 1. Como estudiante NO matriculado en el curso. 2. Idem consulta.                                                                         | Devuelve array vacío.                                                                                                                              |
| CUT-13 | Fecha fin anterior a inicio es rechazada                              | 1. Editar un corte con `start_date=2026-05-10` y `end_date=2026-05-01`.                                                                  | Error por constraint `grade_cuts_dates_ok`.                                                                                                        |

### 19.4 Notificaciones — estudiantes

| ID       | Descripción                                                      | Pasos                                                                                                                                                                                            | Resultado esperado                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NOT-S-01 | Estudiante notificado cuando un corte cierra en 3 días           | 1. Crear corte con `end_date = CURRENT_DATE + 3` en un curso con estudiantes matriculados. 2. Ejecutar `SELECT notify_students_cut_closing(3);` (o invocar edge function `daily-notifications`). | Cada estudiante matriculado recibe una notificación "Corte X cerrando pronto" en la campana. Toast si la app está en foco; OS-level notification si hay permiso y la pestaña está oculta.      |
| NOT-S-02 | No duplica notificaciones si el job corre dos veces el mismo día | 1. Tras NOT-S-01, ejecutar otra vez la función ese mismo día.                                                                                                                                    | `notify_students_cut_closing` devuelve `0`; la tabla `notifications` no crece.                                                                                                                 |
| NOT-S-03 | Estudiante notificado cuando el curso cierra en 7 días           | 1. Curso con `end_date = CURRENT_DATE + 7`. 2. Ejecutar `SELECT notify_students_course_closing(7);`.                                                                                             | Notificación "Curso X cerrando pronto" a cada estudiante matriculado.                                                                                                                          |
| NOT-S-04 | Estudiante notificado al tener nueva calificación                | 1. Como docente, guardar un override manual o lanzar IA sobre una entrega. 2. Al finalizar el update, verificar la campana del estudiante.                                                       | (Requiere trigger/edge posterior; por ahora validar que `submissions.final_override_grade` cambió. El hook de notificación sigue la integración de `notify_course_students` si se implementa.) |

### 19.5 Notificaciones — docentes (anti-spam)

| ID       | Descripción                                                    | Pasos                                                                                                                                               | Resultado esperado                                                                                                                                                                                                       |
| -------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NOT-T-01 | Docente **no** recibe notificación por cada entrega individual | 1. 3 estudiantes entregan un taller en la misma mañana. 2. Verificar la campana del docente.                                                        | **0** notificaciones nuevas por las entregas (regla anti-spam).                                                                                                                                                          |
| NOT-T-02 | Resumen: taller vence mañana                                   | 1. Taller con `due_date = CURRENT_DATE + 1`. 2. Ejecutar `SELECT notify_teachers_workshop_due_tomorrow();`.                                         | Cada docente del curso recibe UNA notificación con el conteo.                                                                                                                                                            |
| NOT-T-03 | Resumen: entregas pendientes después del cierre                | 1. Taller con `due_date < now()` y submissions `entregado`/`ai_revisado` (no calificadas). 2. Ejecutar `SELECT notify_teachers_pending_grading();`. | Cada docente recibe UNA notificación "N entrega(s) pendientes por calificar en curso X".                                                                                                                                 |
| NOT-T-04 | Cambios en el día no crean duplicados en el mismo día          | 1. Tras NOT-T-02 hoy, agregar otro taller para mañana. 2. Correr la función otra vez.                                                               | Ya existe notificación de hoy con el link `/app/teacher/workshops`; el NOT EXISTS la deduplica y `ROW_COUNT=0`. (Nota: este es un trade-off conservador; en la próxima iteración se puede segmentar por curso/workshop). |

### 19.6 PWA / Service Worker

| ID     | Descripción                                                     | Pasos                                                                                                                                                                        | Resultado esperado                                                                                                  |
| ------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| PWA-01 | Service Worker se actualiza sin romper la sesión                | 1. Desplegar nueva versión. 2. Recargar con la pestaña abierta.                                                                                                              | Nueva versión activa tras recarga; no hay pérdida de sesión.                                                        |
| PWA-02 | Notificaciones OS-level se muestran con pestaña oculta          | 1. Conceder permiso `Notification.requestPermission()`. 2. Con la pestaña minimizada, disparar una notificación realtime (insertar fila en `notifications` para el usuario). | Aparece notificación del sistema operativo con título y cuerpo. Clic lleva a `/app` o al `link` de la notificación. |
| PWA-03 | Con pestaña visible, solo suena el toast in-app (no duplica OS) | 1. Misma prueba con la pestaña en foco.                                                                                                                                      | Sólo se ve el toast de sonner y se actualiza la campana; **no** se muestra notificación OS-level.                   |

### 19.7 Checklist de regresión ligera después de fase 3

Antes de marcar la fase como lista, una pasada corta sobre casos fase 2 que
tocan los mismos archivos:

- [ ] **AUTH-01** sigue pasando (login con credenciales válidas).
- [ ] **ST-T-03** timer absoluto sin reset al recargar.
- [ ] **ST-T-09** suspensión al cruzar MAX_WARNINGS.
- [ ] **T-M-05** monitor solo permite ver respuestas en estado final.
- [ ] **DEV-TIMER-02** suite automatizado pasa (`npm run test:run`).

---

## 22. FASE 4 — Cursos, Talleres por curso, Reintentos de examen

Cubre los cambios introducidos para sanear bugs de cursos, refactorizar
asignación de talleres y permitir reintentos parametrizables.

### 22.1 Cursos — bugs corregidos

| ID         | Módulo  | Rol   | Prioridad | Caso de prueba                                                                                                                                                                              | Estado    |
| ---------- | ------- | ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| CRS-FIX-01 | Cursos  | Admin | P0        | Editar un curso existente con `start_date`/`end_date` previos: las fechas precargan correctamente en los inputs `<input type="date">` (no quedan vacíos por formato ISO).                    | Pendiente |
| CRS-FIX-02 | Cursos  | Admin | P0        | Crear curso nuevo, asignar fecha inicio/fin, guardar y reabrir el modal: las fechas se mantienen.                                                                                            | Pendiente |
| CRS-FIX-03 | Cursos  | Admin | P0        | Duplicar un curso con N estudiantes matriculados y M exámenes/talleres: el curso clon contiene los mismos estudiantes (validar `course_enrollments`) y el toast indica el conteo copiado.   | Pendiente |
| CRS-FIX-04 | Cursos  | Admin | P1        | Duplicar un curso sin matrículas: la operación se completa sin error y el conteo informado es 0.                                                                                            | Pendiente |

### 22.2 Talleres — asignación a nivel de curso

| ID        | Módulo   | Rol        | Prioridad | Caso de prueba                                                                                                                                                                                     | Estado    |
| --------- | -------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| WSH-RF-01 | Talleres | Docente    | P0        | Crear un taller en un curso con N estudiantes matriculados: aparece automáticamente para los N estudiantes (vía `autoAssignWorkshop`) sin necesidad de seleccionarlos individualmente.             | Pendiente |
| WSH-RF-02 | Talleres | Docente    | P1        | En el editor de taller ya no existe la UI de selección individual de estudiantes (refactor) — los talleres se entienden como ítems del curso.                                                       | Pendiente |
| WSH-RF-03 | Talleres | Docente    | P1        | Matricular un nuevo estudiante en el curso después de publicar el taller: el estudiante recibe la asignación al matricularse (re-ejecutar autoasignación al editar/publicar).                        | Pendiente |
| WSH-RF-04 | Talleres | Estudiante | P1        | Estudiante matriculado ve el taller en `/app/student/workshops` sin requerir asignación manual del docente.                                                                                          | Pendiente |

### 22.3 Reintentos de examen (parametrización)

| ID        | Módulo    | Rol        | Prioridad | Caso de prueba                                                                                                                                                                                                                  | Estado    |
| --------- | --------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RTY-01    | Cursos    | Docente    | P0        | En la edición del curso, configurar `max_exam_attempts = 3`: el valor persiste y se refleja al recargar.                                                                                                                          | Pendiente |
| RTY-02    | Exámenes  | Docente    | P0        | Crear un examen sin override: hereda `max_exam_attempts` del curso. En el editor del examen el campo "intentos" muestra el valor del curso como placeholder/default.                                                              | Pendiente |
| RTY-03    | Exámenes  | Docente    | P1        | Sobrescribir `max_attempts` por examen (ej. quiz con 5 intentos en un curso con default 1): el override prevalece para ese examen sin afectar al resto.                                                                          | Pendiente |
| RTY-04    | Exámenes  | Estudiante | P0        | Examen con `max_attempts=2`. Primer intento → entregar → en el card aparece "Intento 1 de 2" y un botón "Reintentar examen" mientras la ventana siga abierta.                                                                     | Pendiente |
| RTY-05    | Exámenes  | Estudiante | P0        | Tras agotar los intentos (`finishedCount >= maxAttempts`): el card muestra "Sin intentos disponibles" y el botón de inicio queda deshabilitado.                                                                                  | Pendiente |
| RTY-06    | Exámenes  | Estudiante | P1        | Submission `en_progreso` con intentos disponibles: al volver, el botón dice "Reanudar" y NO consume un nuevo intento (la submission existente se retoma).                                                                         | Pendiente |
| RTY-07    | Exámenes  | Estudiante | P2        | Examen con `max_attempts=1` (default): el badge "Intento X de Y" NO se muestra para evitar ruido visual; al entregar, sólo se ofrece "Ver detalle".                                                                              | Pendiente |
| RTY-08    | Exámenes  | Docente    | P1        | Monitor del examen: las múltiples submissions de un mismo estudiante (cuando hay reintentos) son visibles y diferenciables por `started_at`.                                                                                     | Pendiente |

### 22.4 Checklist de regresión post-FASE 4

- [ ] **AUTH-01** sigue pasando.
- [ ] **ST-T-03** timer absoluto sin reset al recargar (los reintentos no rompen el reloj).
- [ ] **T-M-05** monitor solo permite ver respuestas en estado final (también para múltiples intentos).
- [ ] **DEV-TIMER-02** suite automatizado pasa (`npm run test:run`).
- [ ] Ningún taller de cursos ya existentes pierde sus asignaciones después del refactor.

---

## 23. FASE 5 — Notas de apoyo, copia de docentes, asistencia P/A, asignación de talleres con exclusiones

Cubre las nuevas funcionalidades introducidas para mejorar la experiencia
docente/estudiante: aprobación de notas de examen, control sobre la copia
de docentes al duplicar cursos, evaluación rápida de asistencia y selector
de cursos con exclusión de estudiantes para talleres.

### 23.1 Notas de apoyo en exámenes (cheat-sheet aprobada)

| ID         | Módulo   | Rol        | Prioridad | Caso de prueba                                                                                                                                                                                                       | Estado    |
| ---------- | -------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| NOTES-01   | Exámenes | Estudiante | P0        | En el card de un examen disponible (no completado, ventana abierta), aparece la sección "Notas de apoyo" con un textarea y botón "Enviar a revisión".                                                                  | Pendiente |
| NOTES-02   | Exámenes | Estudiante | P0        | Al enviar texto plano, el estado cambia a `pendiente`, el textarea se bloquea y el botón desaparece hasta que el docente responda.                                                                                    | Pendiente |
| NOTES-03   | Exámenes | Docente    | P0        | En el editor del examen → pestaña "Notas de apoyo" se listan todas las notas con nombre del estudiante, contenido y badges (Pendiente/Aprobada/Rechazada). Contadores arriba muestran totales por estado.            | Pendiente |
| NOTES-04   | Exámenes | Docente    | P0        | Aprobar una nota: el estado pasa a `aprobada`, se registra `reviewed_by` y `reviewed_at`. El estudiante ve un badge "Aprobada" y el contenido en pre-formato dentro del card.                                          | Pendiente |
| NOTES-05   | Exámenes | Docente    | P0        | Rechazar una nota: se obliga a ingresar motivo (botón deshabilitado mientras esté vacío). El estudiante ve el motivo dentro de un cuadro destructive y puede editar + reenviar (vuelve a `pendiente`).                | Pendiente |
| NOTES-06   | Exámenes | Estudiante | P0        | Al iniciar un examen donde la nota fue aprobada, aparece un panel sticky superior (colapsable) con el contenido aprobado, visible en todas las preguntas.                                                              | Pendiente |
| NOTES-07   | Exámenes | Estudiante | P1        | Si la nota no fue aprobada (o no se subió), el panel de notas NO se muestra durante el examen.                                                                                                                        | Pendiente |
| NOTES-08   | Exámenes | Docente    | P1        | "Revocar / rechazar" sobre una nota ya aprobada exige nuevo motivo y revierte el estado a `rechazada`; el contenido aprobado deja de aparecer en el take del estudiante.                                              | Pendiente |
| NOTES-09   | Seguridad | —         | P0        | RLS: un estudiante NO puede ver/editar las notas de otro (`exam_notes` con `auth.uid() = user_id`). Solo Docente/Admin pueden listar todas y actualizar `status`/`rejection_reason`.                                  | Pendiente |

### 23.2 Duplicación de cursos — copia opcional de docentes

| ID        | Módulo | Rol   | Prioridad | Caso de prueba                                                                                                                                                                | Estado    |
| --------- | ------ | ----- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| DUP-T-01  | Cursos | Admin | P0        | En el modal de duplicar curso, el toggle "Copiar docentes" aparece **desactivado por defecto**.                                                                                | Pendiente |
| DUP-T-02  | Cursos | Admin | P0        | Duplicar con el toggle apagado: el curso clon NO recibe los docentes del curso origen (`course_teachers` vacío para el clon).                                                  | Pendiente |
| DUP-T-03  | Cursos | Admin | P0        | Duplicar con el toggle encendido: el curso clon recibe los mismos `course_teachers`. El toast confirma el conteo.                                                              | Pendiente |
| DUP-T-04  | Cursos | Admin | P1        | Combinar copia de docentes con copia de matrículas (toggles independientes): cada uno actúa según su estado, sin afectar al otro.                                              | Pendiente |

### 23.3 Asistencia rápida — selector P / A

| ID        | Módulo     | Rol     | Prioridad | Caso de prueba                                                                                                                                                                | Estado    |
| --------- | ---------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| ATT-PA-01 | Asistencia | Docente | P0        | El selector de estado por estudiante muestra solo dos opciones visibles: **P** (Presente) y **A** (Ausente), en un control compacto.                                            | Pendiente |
| ATT-PA-02 | Asistencia | Docente | P0        | Cambiar entre P y A persiste el cambio en `attendance_records.status` (`presente`/`ausente`).                                                                                  | Pendiente |
| ATT-PA-03 | Asistencia | Docente | P1        | En viewport móvil (≤640px) la tabla es scrollable horizontalmente sin romper layout; las celdas de estado mantienen ancho fijo y son tappables.                                | Pendiente |

### 23.4 Asignación de talleres por curso con exclusión de estudiantes

| ID        | Módulo   | Rol     | Prioridad | Caso de prueba                                                                                                                                                                                          | Estado    |
| --------- | -------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| WSH-EX-01 | Talleres | Docente | P0        | Al asignar un taller, el primer paso es elegir el **Curso** destino (selector). No se pide elegir estudiante por estudiante.                                                                              | Pendiente |
| WSH-EX-02 | Talleres | Docente | P0        | Aparece un listado de los estudiantes del curso con badges "Incluido" / "Excluido" y checkboxes para excluir individualmente.                                                                            | Pendiente |
| WSH-EX-03 | Talleres | Docente | P0        | Al confirmar, el taller se asigna a todos los estudiantes del curso EXCEPTO los marcados como excluidos. La operación es idempotente al editar/republicar.                                              | Pendiente |
| WSH-EX-04 | Talleres | Docente | P1        | Cambiar el estado de un estudiante de "Excluido" a "Incluido" después de la asignación inicial: al guardar, recibe la asignación faltante sin duplicar entregas previas.                                 | Pendiente |

### 23.5 Checklist de regresión post-FASE 5

- [ ] §22 (FASE 4) sigue pasando: cursos, talleres y reintentos no se ven afectados por las nuevas notas.
- [ ] El modal de duplicar curso sigue copiando exámenes, talleres y matrículas según los toggles previos.
- [ ] El monitor del examen y la calificación IA siguen funcionando aunque el estudiante haya tenido notas aprobadas (las notas no contaminan `answers`).
- [ ] La pestaña "Notas de apoyo" en el editor del examen no rompe la pestaña de Asignaciones ni Preguntas.

---

## Control de versiones del documento

| Versión | Fecha      | Cambios                                                                                                                                                                                                                                                |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.0     | 2026-04-19 | Versión inicial alineada con rutas ExamLab (`/app/...`) por rol y módulo.                                                                                                                                                                              |
| 1.1     | 2026-04-20 | Monitor restringido a estados finales, override por pregunta, recalificación IA granular, control temporal explícito del botón de inicio, retroalimentación por pregunta para estudiante, sección §18 con escenarios automatizados para desarrollador. |
| 1.2     | 2026-04-21 | FASE 3 — i18n (ES default, EN opcional, idioma forzado por curso), cortes de evaluación y pesos, RBAC estricto + `/app/unauthorized`, notificaciones anti-spam para docentes y recordatorios para estudiantes (sección §19).                           |
| 1.3     | 2026-04-23 | FASE 4 — fix selector de fechas y duplicación de cursos con matrículas, talleres asignados a nivel curso, parametrización de reintentos de examen (curso + override por examen) — sección §22.                                                          |
| 1.4     | 2026-04-24 | FASE 5 — notas de apoyo aprobables por examen, toggle de copia de docentes al duplicar curso, asistencia P/A compacta y responsive, asignación de talleres por curso con exclusión de estudiantes (sección §23).                                       |

---

_Generado para el proyecto ExamLab. Ajustar casos si se añaden rutas o funciones nuevas._
