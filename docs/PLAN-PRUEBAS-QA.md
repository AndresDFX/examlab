# Plan de pruebas QA — ExamLab

Documento orientado a asegurar cobertura funcional por **rol** y por **módulo**. Actualizar la columna **Estado** durante el ciclo de pruebas.

---

## Cómo usar este documento

| Columna | Uso |
|--------|-----|
| **ID** | Identificador estable para seguimiento en tickets o hojas de cálculo. |
| **Módulo** | Área funcional de la aplicación. |
| **Rol** | Quién ejecuta la prueba: `Todos`, `Admin`, `Docente`, `Estudiante`. |
| **Prioridad** | `P0` bloqueante, `P1` alta, `P2` media, `P3` baja. |
| **Caso de prueba** | Qué hacer y qué resultado se espera. |
| **Estado** | Marcar durante QA: `Pendiente`, `En curso`, `OK`, `Fallido`, `Bloqueado`, `N/A`. |

**Roles de la aplicación:** `Administrador`, `Docente`, `Estudiante` (definidos en `user_roles`). Un usuario puede tener más de un rol y **cambiar rol activo** desde el sidebar.

**Entornos sugeridos:** Staging con datos representativos; navegadores principales (Chromium, Firefox, Safari/WebKit); vista **escritorio** y **móvil** (layout responsive).

---

## Leyenda rápida — Estado

| Valor | Significado |
|-------|-------------|
| Pendiente | No ejecutada |
| En curso | En ejecución |
| OK | Pasa criterios |
| Fallido | No cumple (anotar ID de defecto) |
| Bloqueado | No se puede probar (dependencia, entorno, dato faltante) |
| N/A | No aplica al contexto |

---

## 1. Acceso, autenticación y shell (varios roles)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| AUTH-01 | Acceso | Todos | P0 | Abrir `/auth`: formulario email/contraseña visible; iniciar sesión con credenciales válidas redirige a `/app` y muestra mensaje de bienvenida. | Pendiente |
| AUTH-02 | Acceso | Todos | P0 | Credenciales incorrectas muestran error claro y no crean sesión. | Pendiente |
| AUTH-03 | Acceso | Todos | P1 | Con sesión activa, visitar `/auth` redirige al área interna (`/app`). | Pendiente |
| AUTH-04 | Acceso | Todos | P0 | Sin sesión, intentar abrir `/app` redirige a login. | Pendiente |
| SHELL-01 | Shell / layout | Todos | P1 | Sidebar (escritorio): enlaces según rol activo; Dashboard siempre visible para roles asignados. | Pendiente |
| SHELL-02 | Shell / layout | Todos | P1 | Barra superior móvil: acceso a navegación y rol; contenido usable sin solaparse. | Pendiente |
| SHELL-03 | Shell / layout | Multi-rol | P0 | Si el usuario tiene más de un rol, el selector cambia menú y contexto (Docente vs Estudiante, etc.) sin errores. | Pendiente |
| SHELL-04 | Shell / layout | Todos | P2 | Tema claro/oscuro (toggle): se aplica y persiste razonablemente entre recargas. | Pendiente |
| SHELL-05 | Shell / layout | Todos | P2 | Cambiar contraseña (diálogo): flujo completo según política del producto (éxito / error visible). | Pendiente |
| SHELL-06 | Shell / layout | Todos | P1 | Cerrar sesión: termina sesión y vuelve a pantalla de login. | Pendiente |
| SHELL-07 | Notificaciones | Todos | P1 | Campana / panel de notificaciones: listar, marcar leídas donde aplique; coherencia con dashboard. | Pendiente |
| DASH-01 | Dashboard | Admin | P1 | Panel muestra métricas (usuarios, cursos, exámenes, entregas, talleres) y accesos a administración sin error. | Pendiente |
| DASH-02 | Dashboard | Docente | P1 | Tarjetas, próximos exámenes/talleres y enlaces rápidos cargan datos coherentes con permisos. | Pendiente |
| DASH-03 | Dashboard | Estudiante | P1 | Estadísticas y listas (exámenes/talleres pendientes, completados, cursos) coherentes con matrícula y asignaciones. | Pendiente |
| DASH-04 | Dashboard | Todos | P2 | Bloque de notificaciones recientes en `/app`: clic marca como leída cuando corresponde. | Pendiente |

---

## 2. Administrador — Usuarios (`/app/admin/users`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| ADM-U-01 | Admin · Usuarios | Admin | P0 | Listado de usuarios/perfiles carga sin error para rol Admin. | Pendiente |
| ADM-U-02 | Admin · Usuarios | Admin | P0 | Crear o editar usuario (según UI): cambios persisten y reflejan roles esperados. | Pendiente |
| ADM-U-03 | Admin · Usuarios | Admin | P1 | Asignación de roles (`Admin`, `Docente`, `Estudiante`): usuario puede iniciar sesión con capacidades acordes. | Pendiente |
| ADM-U-04 | Admin · Usuarios | Admin | P2 | Importación CSV (si existe): archivo válido procesa; archivo inválido muestra error comprensible. | Pendiente |
| ADM-U-05 | Admin · Usuarios | Docente / Estudiante | P2 | Sin rol Admin, acceso directo a `/app/admin/users` debe denegarse o redirigir (según diseño). | Pendiente |

---

## 3. Administrador — Cursos (`/app/admin/courses`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| ADM-C-01 | Admin · Cursos | Admin | P0 | Listado de cursos con periodos/fechas visible y consistente. | Pendiente |
| ADM-C-02 | Admin · Cursos | Admin | P0 | Alta/edición de curso: guardar y ver reflejo en listado y en flujos docente/estudiante. | Pendiente |
| ADM-C-03 | Admin · Cursos | Admin | P1 | Matrícula de estudiantes / gestión de enrollments (según pantalla): estudiante matriculado ve curso en su módulo de cursos y recibe asignaciones cuando correspondan. | Pendiente |
| ADM-C-04 | Admin · Cursos | Admin | P2 | Validaciones de fechas y campos obligatorios impiden datos inconsistentes con mensajes claros. | Pendiente |

---

## 4. Docente — Cursos (`/app/teacher/courses`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| T-C-01 | Docente · Cursos | Docente | P1 | Lista de cursos asignados al docente; datos alineados con backend. | Pendiente |
| T-C-02 | Docente · Cursos | Docente | P2 | Acciones disponibles (ver detalle, enlaces a exámenes/talleres según UI) funcionan. | Pendiente |
| T-C-03 | Docente · Cursos | Estudiante | P2 | Estudiante no debe gestionar estos cursos como docente (acceso denegado o sin menú). | Pendiente |

---

## 5. Docente — Exámenes (`/app/teacher/exams`, `/app/teacher/exams/$examId`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| T-E-01 | Docente · Exámenes | Docente | P0 | Listado de exámenes; crear nuevo examen abre flujo de edición. | Pendiente |
| T-E-02 | Docente · Exámenes | Docente | P0 | Configurar título, curso, ventana `start_time` / `end_time`, duración `time_limit_minutes`, tipo de navegación entre preguntas. | Pendiente |
| T-E-03 | Docente · Exámenes | Docente | P1 | Añadir/editar/ordenar preguntas (tipos soportados: opción múltiple, desarrollo, código, etc.); guardar sin pérdida de datos. | Pendiente |
| T-E-04 | Docente · Exámenes | Docente | P1 | Asignación de examen a estudiantes o curso (según modelo): solo estudiantes asignados lo ven. | Pendiente |
| T-E-05 | Docente · Exámenes | Docente | P2 | Examen supletorio / `parent_exam_id` (si aplica): etiqueta y comportamiento correctos en listados. | Pendiente |
| T-E-06 | Docente · Exámenes | Docente | P1 | Enlace o botón al **Monitor** del examen abre `/app/teacher/monitor/$examId`. | Pendiente |

---

## 6. Docente — Monitor en vivo (`/app/teacher/monitor/$examId`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| T-M-01 | Docente · Monitor | Docente | P0 | Tabla de estudiantes con estado: `En progreso`, `Completado`, `Sospechoso` según `submissions.status`. | Pendiente |
| T-M-02 | Docente · Monitor | Docente | P1 | Tras **entrega manual** del estudiante, estado pasa a completado (actualización en lista en tiempo razonable: realtime o refresco automático). | Pendiente |
| T-M-03 | Docente · Monitor | Docente | P1 | Tras **fin de tiempo automático**, mismo criterio: no permanece “En progreso” si el servidor registró `completado`. | Pendiente |
| T-M-04 | Docente · Monitor | Docente | P1 | Controles de temporizador globales/por estudiante: pausa, reanudar, añadir tiempo; estudiante recibe comportamiento acorde (toast/timer). | Pendiente |
| T-M-05 | Docente · Monitor | Docente | P2 | Ver respuestas / modal de detalle según UI; override de nota manual si existe. | Pendiente |
| T-M-06 | Docente · Monitor | Docente | P2 | Eliminar entrega (si existe confirmación): fila desaparece y datos consistentes. | Pendiente |
| T-M-07 | Docente · Monitor | Docente | P2 | Acciones de IA / recalificar (si están en UI): respuesta exitosa y actualización de notas. | Pendiente |
| T-M-08 | Docente · Monitor | Estudiante | P2 | Estudiante no puede abrir monitor de docente (denegación). | Pendiente |

---

## 7. Docente — Calificaciones (`/app/teacher/gradebook`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| T-G-01 | Docente · Calificaciones | Docente | P1 | Vista tipo matriz o tabla por curso/examen; datos cargan para docente. | Pendiente |
| T-G-02 | Docente · Calificaciones | Docente | P2 | Exportación CSV (si existe): archivo descargable y campos correctos. | Pendiente |
| T-G-03 | Docente · Calificaciones | Docente | P2 | Edición de calificación override donde aplique se refleja en estudiante y monitor. | Pendiente |

---

## 8. Docente — Talleres (`/app/teacher/workshops`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| T-W-01 | Docente · Talleres | Docente | P1 | Crear taller: título, curso, fechas, estado `published`/`draft` según flujo. | Pendiente |
| T-W-02 | Docente · Talleres | Docente | P1 | Asignación a estudiantes/cursos; estudiante matriculado ve taller en su lista. | Pendiente |
| T-W-03 | Docente · Talleres | Docente | P2 | Revisión de entregas de taller (archivos/comentarios según UI). | Pendiente |

---

## 9. Docente — Asistencia (`/app/teacher/attendance`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| T-A-01 | Docente · Asistencia | Docente | P1 | Selección de curso/sesión y registro de asistencia guarda correctamente. | Pendiente |
| T-A-02 | Docente · Asistencia | Docente | P2 | Listados o filtros por fecha/grupo funcionan sin errores de UI. | Pendiente |

---

## 10. Estudiante — Exámenes (`/app/student/exams`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| ST-E-01 | Estudiante · Exámenes | Estudiante | P0 | Solo aparecen exámenes asignados; badges de Disponible / Próximo / Cerrado / Entregado coherentes con fechas. | Pendiente |
| ST-E-02 | Estudiante · Exámenes | Estudiante | P1 | Con intento `en_progreso` y ventana **abierta**, botón “Reanudar examen” navega al take. | Pendiente |
| ST-E-03 | Estudiante · Exámenes | Estudiante | P1 | Con intento `en_progreso` y ventana **cerrada** (fin de `end_time`), **no** debe ofrecer reanudar como acción disponible (botón deshabilitado / mensaje de ventana cerrada). | Pendiente |
| ST-E-04 | Estudiante · Exámenes | Estudiante | P1 | Tras entrega completada, acceso a revisión/detalle según diseño (`/app/student/review/$examId`). | Pendiente |

---

## 11. Estudiante — Presentación del examen (`/app/student/take/$examId`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| ST-T-01 | Estudiante · Take exam | Estudiante | P0 | Inicio de examen crea `submission` y permite navegar preguntas según `navigation_type`. | Pendiente |
| ST-T-02 | Estudiante · Take exam | Estudiante | P1 | Autoguardado de respuestas; al recargar página reanuda sin perder respuestas locales/servidor. | Pendiente |
| ST-T-03 | Estudiante · Take exam | Estudiante | P1 | Temporizador cuenta hacia `end_time` del examen; muestra advertencia de poco tiempo si aplica. | Pendiente |
| ST-T-04 | Estudiante · Take exam | Estudiante | P0 | Al llegar a cero el tiempo global, **entrega automática** sin modal obligatorio de “tiempo agotado”; estado en servidor `completado`. | Pendiente |
| ST-T-05 | Estudiante · Take exam | Estudiante | P1 | Entrega manual con preguntas sin responder: modal de confirmación; entrega guarda estado `completado`. | Pendiente |
| ST-T-06 | Estudiante · Take exam | Estudiante | P2 | Proctoring: advertencias por blur, pantalla completa, copiar/pegar; incremento de `focus_warnings`; al superar umbral, suspensión `sospechoso` según reglas del producto. | Pendiente |
| ST-T-07 | Estudiante · Take exam | Estudiante | P2 | Si falla persistencia en servidor al entregar, usuario recibe error y **no** debe ver éxito engañoso ni perder datos locales cuando exista salvaguarda offline. | Pendiente |
| ST-T-08 | Estudiante · Take exam | Estudiante | P3 | Modo offline / reconexión: comportamiento documentado (sincronización de respuestas). | Pendiente |

---

## 12. Estudiante — Revisión y retroalimentación (`/app/student/review/$examId`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| ST-R-01 | Estudiante · Revisión | Estudiante | P1 | Tras examen completado y calificación disponible, ver nota desglose, feedback por pregunta o global según UI. | Pendiente |
| ST-R-02 | Estudiante · Revisión | Estudiante | P2 | Enlaces desde listado de exámenes al review correctos para el `examId`. | Pendiente |

---

## 13. Estudiante — Talleres (`/app/student/workshops`, `/app/student/workshop/$workshopId`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| ST-W-01 | Estudiante · Talleres | Estudiante | P1 | Lista de talleres asignados; estados alineados con fechas de entrega. | Pendiente |
| ST-W-02 | Estudiante · Talleres | Estudiante | P1 | Entrada al detalle del taller y envío de archivos/texto según especificación. | Pendiente |
| ST-W-03 | Estudiante · Talleres | Estudiante | P2 | Taller vencido muestra indicación clara; reglas de reentrega si existen. | Pendiente |

---

## 14. Estudiante — Cursos (`/app/student/courses`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| ST-C-01 | Estudiante · Cursos | Estudiante | P2 | Lista de cursos matriculados y metadatos (periodo, nombre). | Pendiente |
| ST-C-02 | Estudiante · Cursos | Estudiante | P3 | Enlaces o información complementaria sin errores de permisos. | Pendiente |

---

## 15. Estudiante — Notas (`/app/student/grades`)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| ST-N-01 | Estudiante · Notas | Estudiante | P1 | Consolidado de calificaciones de exámenes/talleres visibles solo para el propio usuario. | Pendiente |
| ST-N-02 | Estudiante · Notas | Estudiante | P2 | Coherencia con calificaciones del gradebook docente y con review. | Pendiente |

---

## 16. Integración y regresión cruzada

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| INT-01 | Integración | Docente + Estudiante | P0 | Flujo extremo a extremo: crear examen → asignar → estudiante realiza → docente ve monitor y calificaciones → estudiante ve nota y revisión. | Pendiente |
| INT-02 | Integración | Admin + Docente | P1 | Crear curso y matricular estudiante → docente asigna examen en ese curso → estudiante lo ve. | Pendiente |
| INT-03 | Integración | Todos | P2 | Notificaciones (p. ej. examen sospechoso): docente recibe aviso enlazando al monitor cuando aplique política del sistema. | Pendiente |
| REG-01 | Regresión | Todos | P2 | Tras cambios de UI, repetir AUTH-01, ST-T-04, T-M-03 en una pasada corta antes de release. | Pendiente |

---

## 17. No funcionales (opcional pero recomendado)

| ID | Módulo | Rol | Prioridad | Caso de prueba | Estado |
|----|--------|-----|-----------|----------------|--------|
| NFR-01 | Rendimiento | Todos | P3 | Tiempos de carga aceptables en dashboard y take exam con red simulada “Fast 3G”. | Pendiente |
| NFR-02 | Accesibilidad | Todos | P3 | Navegación básica por teclado en login y entrega de examen (foco visible). | Pendiente |
| NFR-03 | Seguridad | Todos | P2 | No exponer datos de un usuario al manipular `examId`/IDs en URL de otro estudiante (errores o vacío). | Pendiente |

---

## Control de versiones del documento

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0 | 2026-04-19 | Versión inicial alineada con rutas ExamLab (`/app/...`) por rol y módulo. |

---

*Generado para el proyecto ExamLab. Ajustar casos si se añaden rutas o funciones nuevas.*
