# Plan de pruebas QA — ExamLab

Este documento prioriza las funcionalidades **nuevas o modificadas** que aún no
han sido verificadas en sesiones anteriores. Los **62 casos** del QA inicial
(2026-04-21/22) ya están gestionados y se reportan en
[`QA-RESULTADOS.md`](QA-RESULTADOS.md) — no se repiten aquí salvo como
**regresión P0** cuando un cambio reciente toca su área.

---

## Cómo usar este documento

| Columna            | Uso                                                                              |
| ------------------ | -------------------------------------------------------------------------------- |
| **ID**             | Identificador estable para seguimiento.                                          |
| **Módulo**         | Área funcional.                                                                  |
| **Rol**            | Quién ejecuta: `Todos`, `Admin`, `Docente`, `Estudiante`.                        |
| **Prioridad**      | `P0` bloqueante, `P1` alta, `P2` media, `P3` baja.                               |
| **Caso**           | Qué hacer y qué se espera.                                                       |
| **Estado**         | `Pendiente`, `En curso`, `OK`, `Fallido`, `Bloqueado`, `N/A`.                    |

**Entornos:** Lovable producción + AWS self-hosted (cuando aplique). Probar en
Chrome y Firefox como mínimo. Móvil cuando el caso lo indique.

**Antes de cada ronda:** ejecutar `npm run test:run` y confirmar que el suite
pase. Si falla, no se abren tickets manuales hasta resolver el fallo
automatizado.

---

## 🆕 1. Proyectos: subida de archivos por slot + preview Mermaid

> Funcionalidad nueva. Cada entregable del proyecto recibe **archivos reales**
> subidos a Supabase Storage (no cajas de texto). El tipo de archivo aceptado
> depende del `language` configurado por el docente: `.md` para diagramas,
> `.java`/`.py`/etc. para código, `.md`/`.txt` por defecto. Se permite subir
> **N archivos por slot**. La IA califica concatenando todos los archivos del
> slot con separadores `// === Archivo: <name> ===`. La vista de revisión
> muestra cada archivo descargable y, para `.md`, renderiza Mermaid en vivo.

### 1.A — Docente: definir slots

| ID         | Módulo                        | Rol        | Prioridad | Caso                                                                                                                                                                                                  | Estado    |
| ---------- | ----------------------------- | ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| PROJ-T-01  | Docente · Proyectos           | Docente    | P0        | Crear proyecto, ir a "Archivos esperados" → tab **Manual**: crear 2 archivos (Título + Rúbrica + Puntos). Aparecen en la lista numerados.                                                             | Pendiente |
| PROJ-T-02  | Docente · Proyectos           | Docente    | P0        | Tab **Generar con IA**: indicar tema y 3 archivos. La IA crea 3 slots con título, rúbrica y `language` coherente (ej. "java" para slots de código). No se duplican si se repite el botón.             | Pendiente |
| PROJ-T-03  | Docente · Proyectos           | Docente    | P1        | Eliminar slot desde la lista pide confirmación. Tras confirmar, desaparece de la lista y deja de mostrarse al estudiante en su próximo intento.                                                       | Pendiente |
| PROJ-T-04  | Docente · Proyectos           | Docente    | P1        | El docente puede asignar `language: "mermaid"` o `"diagrama"` a un slot manualmente para forzar el tipo de archivo aceptado en la vista del estudiante.                                               | Pendiente |

### 1.B — Estudiante: subir archivos

| ID         | Caso                                                                                                                                                                                                                                   | Estado    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| PROJ-S-01  | Abrir proyecto asignado y disponible: el modal muestra un uploader (input file con `multiple`) por cada slot. El badge muestra el `language` (mermaid, java, python, …).                                                                | Pendiente |
| PROJ-S-02  | El input de archivo respeta el filtro `accept` correcto por tipo: `.md` para mermaid/diagrama; `.java` para java; `.py` para python; etc. El navegador filtra automáticamente al abrir el selector.                                    | Pendiente |
| PROJ-S-03  | Subir 1 archivo `.md` válido: aparece en la lista bajo el uploader con nombre y tamaño. Se puede subir un segundo, un tercero, etc. (N archivos por slot).                                                                              | Pendiente |
| PROJ-S-04  | Eliminar un archivo (botón papelera): desaparece de la lista, se borra de Storage y de `project_submission_attachments`.                                                                                                                | Pendiente |
| PROJ-S-05  | Intentar subir archivo > 10 MB: toast error "excede 10 MB" y no se sube.                                                                                                                                                                | Pendiente |
| PROJ-S-06  | Intentar enviar el proyecto dejando un slot sin archivos: error "Falta subir al menos un archivo en: <título>". No se envía la entrega.                                                                                                | Pendiente |
| PROJ-S-07  | Cerrar el modal sin enviar: los archivos ya subidos persisten (estaban en Storage). Al volver a abrir, el estudiante los ve. Puede agregar más antes de enviar.                                                                         | Pendiente |
| PROJ-S-08  | Enviar con todos los slots completos: la app concatena los archivos de cada slot con `// === Archivo: <name> ===`, los envía a la IA, la IA califica, aparece la nota global `final_grade / max_score` y feedback por slot.            | Pendiente |
| PROJ-S-09  | El archivo concatenado se guarda en `project_submission_files.content` (truncado a 100k chars) para que el docente vea exactamente qué se envió a la IA.                                                                                | Pendiente |

### 1.C — Estudiante: revisión post-calificación

| ID         | Caso                                                                                                                                                                                              | Estado    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| PROJ-R-01  | Abrir `/app/student/project/<id>` después de enviar: cada slot lista los archivos entregados (nombre, tamaño, botón Descargar). Botón Descargar abre signed URL en nueva pestaña.                | Pendiente |
| PROJ-R-02  | Para archivos `.md` con bloques `\`\`\`mermaid`: el contenido se descarga automáticamente y los bloques Mermaid se renderizan como diagramas en vivo. Hay un `<details>` con la fuente Markdown. | Pendiente |
| PROJ-R-03  | Para slots `language=mermaid` con `.md` que NO tiene fences (solo contenido directo `flowchart …`): el contenido completo se renderiza como Mermaid.                                              | Pendiente |
| PROJ-R-04  | Para archivos de código (`.java`, `.py`, etc.): se descargan y se muestran en bloque monospace con scroll horizontal/vertical.                                                                    | Pendiente |
| PROJ-R-05  | Archivos > 1 MB no se previsualizan (mensaje "demasiado grande"). El botón Descargar sigue funcionando.                                                                                          | Pendiente |
| PROJ-R-06  | Archivos binarios (PDF, imágenes, ZIP) no muestran preview. Solo el botón Descargar.                                                                                                              | Pendiente |
| PROJ-R-07  | Si `ai_likelihood >= 0.6`, aparece badge rojo "Posible IA" en el header del slot.                                                                                                                 | Pendiente |
| PROJ-R-08  | Submisiones legacy (anteriores a la migración de attachments) que solo tienen `content` y no archivos: la vista muestra el bloque de texto monospace fallback.                                    | Pendiente |
| PROJ-R-09  | URL `/app/student/project/<id>` con un proyecto vinculado al curso del estudiante via `project_courses` (sin `project_assignments`): la vista carga normalmente (no más error "no acceso").       | Pendiente |
| PROJ-R-10  | URL con proyecto NO vinculado y sin asignación directa: muestra el mensaje "No tienes acceso a este **proyecto** o no está asignado a tu cuenta" (no más "examen").                              | Pendiente |

### 1.D — Storage y Mermaid

| ID         | Caso                                                                                                                                                                                | Estado    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| PROJ-ST-01 | Estructura de paths en bucket `project-files`: `<userId>/<projectId>/<slotId>/<timestamp>-<filename>`.                                                                              | Pendiente |
| PROJ-ST-02 | RLS: el estudiante solo puede leer/subir/borrar archivos en su propia carpeta `<userId>/...`. Verificar con un segundo usuario.                                                     | Pendiente |
| PROJ-ST-03 | RLS: docentes y admins pueden leer todos los archivos del bucket (permiso explícito en la migración).                                                                              | Pendiente |
| PROJ-ST-04 | Eliminar un slot del proyecto (lado docente) NO borra los archivos subidos por estudiantes en otros proyectos del mismo bucket — solo se borra al borrar el `project_submission_files` correspondiente (CASCADE). | Pendiente |

### 1.E — IA: fallback de modelos

| ID         | Caso                                                                                                                                                                                                          | Estado    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| PROJ-G-01  | Cuota Gemini agotada en `gemini-2.5-flash` (self-hosted): el wrapper inyectado reintenta con `gemini-2.0-flash`, `2.0-flash-lite`, `1.5-flash`, `1.5-flash-8b`. Log: `[AI fallback] succeeded with X`. | Pendiente |
| PROJ-G-02  | Si todos los modelos del fallback fallan, el slot se guarda con `ai_grade=0` y `ai_feedback="Error IA: …"`. El estudiante ve la calificación pero con mensaje de error.                                       | Pendiente |

---

## 🆕 2. Selectores de fecha (shadcn DatePicker / DateTimePicker)

> Reemplazo de `<input type="date">` y `<input type="datetime-local">` nativos
> por componente shadcn (Popover + Calendar) en todos los formularios. Motivo:
> en Chrome y Safari el calendario nativo no abría confiablemente,
> especialmente dentro de modals Radix.

| ID         | Módulo                        | Rol      | Prioridad | Caso                                                                                                                                            | Estado    |
| ---------- | ----------------------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| DATE-01    | Crear examen (modal)          | Docente  | P0        | "Inicio" y "Fin" abren un calendario al hacer click en cualquier parte del botón (no solo el ícono). Probado en Chrome y Firefox.               | Pendiente |
| DATE-02    | Crear examen (modal)          | Docente  | P0        | El calendario muestra la fecha actualmente seleccionada y permite seleccionar otra. Cierra al elegir y deja la fecha en el botón.               | Pendiente |
| DATE-03    | Crear examen (modal)          | Docente  | P0        | El input de hora (formato 24h) acepta cambios y persiste la fecha cuando solo se cambia la hora. La selección de fecha conserva la hora actual. | Pendiente |
| DATE-04    | Editar examen detalle         | Docente  | P0        | Al editar examen existente, los DateTimePicker muestran la fecha/hora actual con formato local (`d MMM yyyy HH:mm`).                            | Pendiente |
| DATE-05    | Crear taller                  | Docente  | P1        | "Visible desde" y "Fecha límite" funcionan igual que en exámenes.                                                                               | Pendiente |
| DATE-06    | Crear proyecto                | Docente  | P1        | "Fecha de inicio" y "Fecha de entrega" funcionan; la fecha de entrega es obligatoria (asterisco).                                               | Pendiente |
| DATE-07    | Editar curso                  | Admin    | P1        | "Fecha inicio" y "Fecha fin" abren calendario en lugar del input nativo. Validación: fin < inicio sigue mostrando error.                        | Pendiente |
| DATE-08    | Cortes (CutsEditor / grading) | Docente  | P1        | Cada corte tiene 2 DatePickers (inicio y fin). Funcionan dentro del editor de cortes (CutsEditor) y en el editor de calificaciones por curso.   | Pendiente |
| DATE-09    | Asistencia                    | Docente  | P2        | "Nueva sesión" abre DatePicker para elegir la fecha de la clase.                                                                                | Pendiente |
| DATE-10    | Móvil (touch)                 | Todos    | P1        | En vista móvil, los DatePickers abren el popover por encima del modal sin solaparse y permiten selección con touch.                             | Pendiente |
| DATE-11    | Limpiar                       | Todos    | P2        | Al borrar la fecha (devolver `""`), el botón vuelve al placeholder ("Selecciona una fecha"). El form sigue siendo enviable si el campo es opcional. | Pendiente |

---

## 🆕 3. Campos obligatorios visibles en HTML

> Los campos críticos ahora muestran asterisco rojo en el `<Label>` y tienen
> el atributo `required` en el input. Esto activa la validación nativa del
> navegador y mejora la accesibilidad (anuncio "(obligatorio)" para lectores
> de pantalla).

| ID       | Módulo               | Rol      | Prioridad | Caso                                                                                                                                | Estado    |
| -------- | -------------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- |
| REQ-01   | Crear examen         | Docente  | P0        | El Label "Título", "Inicio" y "Fin" muestran asterisco rojo. Intentar enviar el form vacío bloquea con tooltip nativo del navegador. | Pendiente |
| REQ-02   | Crear taller         | Docente  | P1        | "Título" y "Fecha límite" muestran asterisco. Submit vacío → bloqueado.                                                             | Pendiente |
| REQ-03   | Crear proyecto       | Docente  | P1        | "Título" y "Fecha de entrega" muestran asterisco. Submit vacío → bloqueado.                                                         | Pendiente |
| REQ-04   | Archivos del proyecto (manual) | Docente | P1        | "Título del archivo" muestra asterisco. Submit vacío → bloqueado o muestra toast.                                                   | Pendiente |
| REQ-05   | Archivos del proyecto (IA)     | Docente | P1        | "Tema del proyecto" muestra asterisco. Submit vacío → bloqueado o muestra toast.                                                    | Pendiente |
| REQ-06   | Crear curso          | Admin    | P1        | "Nombre" muestra asterisco. Submit vacío → bloqueado.                                                                               | Pendiente |
| REQ-07   | Estudiante · Proyecto | Estudiante | P1      | Cada caja de archivo en la entrega es `required`. El navegador no envía el form si alguna está vacía. (También hay validación JS que muestra toast). | Pendiente |
| REQ-08   | Lectores de pantalla | -        | P2        | Verificar con NVDA/VoiceOver que el asterisco se anuncia como "(obligatorio)" para campos marcados.                                 | Pendiente |

---

## 🆕 4. Importar / Exportar / Plantilla CSV (estandarizado)

> Todas las pantallas con datos masivos ahora usan el componente compartido
> `<ImportExportMenu>` (ver [`src/components/ImportExportMenu.tsx`](../src/components/ImportExportMenu.tsx)).
> El menú dropdown tiene tres ítems consistentes en cualquier pantalla:
>
> - **Descargar plantilla** — siempre disponible.
> - **Importar desde CSV** — abre selector de archivo.
> - **Exportar a CSV** — genera CSV con el contenido actual (info toast si no hay datos).
>
> El nombre del botón ("Datos", "Usuarios", "Asistencia", "Clases", "CSV"…)
> se personaliza por pantalla pero la estructura interna es la misma.

| ID         | Pantalla                            | Rol      | Prioridad | Caso                                                                                                                                                | Estado    |
| ---------- | ----------------------------------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| IE-UI-01   | Cualquier pantalla con menú         | -        | P0        | El botón abre un dropdown con las 3 opciones. La estructura visual es idéntica en Usuarios, Asistencia, Clases, Exámenes, Talleres y Calificaciones. | Pendiente |
| IE-UI-02   | Móvil                               | -        | P1        | El dropdown abre alineado a la derecha y no se sale del viewport. Cada opción es tappeable.                                                          | Pendiente |
| IE-UI-03   | Plantilla siempre visible           | -        | P1        | "Descargar plantilla" aparece **incluso cuando no hay datos** y aunque la pantalla no soporte importar. Permite empezar desde cero.                  | Pendiente |
| IE-USR-01  | Admin · Usuarios                    | Admin    | P0        | Descargar plantilla genera `template-usuarios.csv` con columnas `full_name, institutional_email, personal_email, password, roles, course_name`.       | Pendiente |
| IE-USR-02  | Admin · Usuarios                    | Admin    | P0        | Importar CSV con 3 usuarios nuevos: muestra toast "Importados correctamente: 3" y aparecen en la lista tras refresh automático.                       | Pendiente |
| IE-USR-03  | Admin · Usuarios                    | Admin    | P0        | Importar CSV con 1 nuevo + 1 duplicado + 1 error: toast warning con desglose `Importados: 1 · Duplicados: 1 · Errores: 1` con detalle del email.      | Pendiente |
| IE-USR-04  | Admin · Usuarios                    | Admin    | P1        | Exportar: descarga `usuarios-<ts>.csv` con todos los usuarios actuales. Las columnas son las mismas de la plantilla.                                  | Pendiente |
| IE-AST-01  | Docente · Asistencia · Clases       | Docente  | P0        | Plantilla `template-clases.csv`: descargable. Importar agrega sesiones al curso seleccionado. Sin curso → menú deshabilitado.                         | Pendiente |
| IE-AST-02  | Docente · Asistencia · Asistencia   | Docente  | P0        | Plantilla `template-asistencia.csv`. Importar registros marca asistencia masiva. Exportar genera matriz estudiante × sesión.                          | Pendiente |
| IE-EX-01   | Docente · Exámenes                  | Docente  | P1        | Plantilla, import y export funcionan (lista de exámenes con título, fechas, estado).                                                                  | Pendiente |
| IE-WS-01   | Docente · Talleres                  | Docente  | P1        | Igual que exámenes, para talleres.                                                                                                                    | Pendiente |
| IE-GRA-01  | Docente · Calificaciones (gradebook)| Docente  | P0        | Sin curso seleccionado → menú deshabilitado. Con curso: la plantilla se genera **dinámicamente** con los exámenes, talleres (`[T]`) y proyectos (`[P]`) que tenga el curso *en ese momento*.              | Pendiente |
| IE-GRA-02  | Docente · Calificaciones (gradebook)| Docente  | P0        | La plantilla incluye **una fila pre-rellenada por estudiante matriculado** con `nombre` y `email_institucional`, y celdas vacías para cada columna. El docente solo escribe los valores. | Pendiente |
| IE-GRA-03  | Docente · Calificaciones (gradebook)| Docente  | P0        | Cambiar de curso y volver a descargar plantilla: el archivo nuevo refleja los datos del curso recién seleccionado (los headers y los emails cambian). | Pendiente |
| IE-GRA-04  | Docente · Calificaciones (gradebook)| Docente  | P0        | Agregar un taller o proyecto al curso, recargar la pantalla, descargar plantilla: la nueva columna aparece con su prefijo correcto (`[T]` o `[P]`). | Pendiente |
| IE-GRA-05  | Docente · Calificaciones (gradebook)| Docente  | P0        | Exportar genera `calificaciones-<ts>.csv` con la matriz visible (incluyendo prefijo `[T]` para talleres, `[P]` para proyectos y sufijo `(S)` para supletorios). | Pendiente |
| IE-GRA-06  | Docente · Calificaciones (gradebook)| Docente  | P0        | Importar CSV: solo escribe celdas que difieren del valor actual (no toca lo no incluido). Toast: `N celda(s) lista(s) para guardar`. Botón "Guardar cambios" persiste para exámenes (final_override_grade), talleres y proyectos (final_grade). | Pendiente |
| IE-GRA-07  | Docente · Calificaciones (gradebook)| Docente  | P1        | Importar CSV con email que no existe en el curso: la fila se omite (toast incluye `M fila(s) omitida(s)`). No rompe el resto de la importación.       | Pendiente |
| IE-GRA-08  | Docente · Calificaciones (gradebook)| Docente  | P1        | Importar nota de un proyecto donde el estudiante NO tiene entrega previa: la celda no se actualiza (no se puede crear submission desde el CSV). El batch reporta el error sin abortar el resto.            | Pendiente |
| IE-ERR-01  | Cualquier pantalla                  | -        | P1        | Importar archivo no-CSV (ej. PDF): toast error "Error importando: …" sin crashear la app.                                                             | Pendiente |
| IE-ERR-02  | Cualquier pantalla                  | -        | P1        | Importar CSV vacío (solo header): toast "El archivo no contiene datos".                                                                              | Pendiente |
| IE-ERR-03  | Cualquier pantalla                  | -        | P2        | Exportar cuando no hay datos: toast info "No hay datos para exportar" (no descarga archivo vacío).                                                    | Pendiente |

---

## 🆕 5. Despliegue AWS self-hosted (lovable-aws-deployment)

> Carpeta agnóstica al proyecto que despliega cualquier app Lovable en AWS
> con un único `bash deploy.sh` desde CloudShell. Levanta EC2 + Supabase
> self-hosted (Docker Compose) + IA con fallback de modelos.

| ID         | Módulo                  | Rol     | Prioridad | Caso                                                                                                                                                                       | Estado    |
| ---------- | ----------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| AWS-D-01   | deploy.sh · Inputs      | Operador | P0        | Ejecutar `bash deploy.sh` en CloudShell con cuenta sin stack previo. Pide proyecto/contraseña/región/api-key, valida formato de región (rechaza si pega API key allí).     | Pendiente |
| AWS-D-02   | deploy.sh · Validación key | Operador | P1     | Pegar key con formato no estándar (no `AIzaSy...`) pide confirmación "¿usar tal cual?". Saltar (Enter) deshabilita IA.                                                     | Pendiente |
| AWS-D-03   | bootstrap · EC2         | Operador | P0        | Tras `deploy.sh`, esperar 12-15 min. La instancia llega a "✅ Deployment OK" en `/var/log/user-data.log`. App responde en `http://<EIP>:3000`. Supabase Kong en `:8000`.    | Pendiente |
| AWS-D-04   | Update sin recrear      | Operador | P1        | Cambiar código y volver a ejecutar `deploy.sh`: detecta stack existente, ejecuta live-update vía SSM. Toma ~3 min. La EC2 NO se recrea (mismo InstanceId, EIP estable).    | Pendiente |
| AWS-D-05   | Persistencia EIP        | Operador | P1        | Reiniciar la EC2 desde la consola: la Elastic IP sigue siendo la misma; al volver a estar `running`, la app vuelve a responder en la misma URL.                            | Pendiente |
| AWS-D-06   | Genericidad             | Operador | P1        | Copiar la carpeta `lovable-aws-deployment/` a otro proyecto Lovable (cualquiera) y desplegar con `PROJECT_NAME=mi-otra-app`. Funciona sin tocar nada del código del proyecto. | Pendiente |
| AWS-D-07   | IA · sed automático     | -       | P0        | Verificar en EC2: `grep generativelanguage /opt/supabase/volumes/functions/*/index.ts` muestra que las URLs fueron sustituidas. El Lovable Gateway no se llama nunca.       | Pendiente |
| AWS-D-08   | IA · wrapper inyectado  | -       | P0        | `head -3 /opt/supabase/volumes/functions/<fn>/index.ts` muestra `// === [auto-injected by deploy] AI fallback wrapper ===`. La función de fallback existe.                 | Pendiente |
| AWS-D-09   | Cleanup                 | Operador | P2        | `aws cloudformation delete-stack ...` elimina todos los recursos. Los buckets S3 (deploy + storage) no se eliminan automáticamente (intencional para no perder uploads).   | Pendiente |
| AWS-D-10   | EC2 Instance Connect    | Operador | P2        | Desde la consola AWS, conectar por EC2 Instance Connect funciona (puerto 22 abierto + paquete `ec2-instance-connect` instalado).                                           | Pendiente |
| AWS-D-11   | Session Manager         | Operador | P1        | `aws ssm start-session --target <ID>` abre shell en la EC2 sin SSH key. Útil para diagnosticar.                                                                            | Pendiente |
| AWS-D-12   | Credenciales generadas  | Operador | P2        | `sudo cat /root/<proyecto>-credentials.txt` dentro de la EC2 muestra ANON_KEY, SERVICE_ROLE_KEY, JWT_SECRET, DB password, DASHBOARD password (modo 600).                   | Pendiente |

---

## 🔄 6. Regresión crítica (P0) tras cambios recientes

> Los siguientes casos ya pasaron en QA inicial (ver `QA-RESULTADOS.md`),
> pero los cambios de esta iteración (DatePicker, required, modelo de
> proyectos) tocan formularios principales. Se ejecutan como **smoke test**.

| ID         | Caso original          | Por qué reverificar                                                                                                                              | Estado    |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| REG-AUTH-01| AUTH-01 (Login OK)     | Sin cambios — solo confirmar que el flujo sigue intacto.                                                                                         | Pendiente |
| REG-T-E-02 | T-E-02 (Crear examen)  | Cambio: DatePicker en Inicio/Fin + Label required. Confirmar que se guarda y aparece en listado.                                                 | Pendiente |
| REG-T-W-01 | T-W-01 (Crear taller)  | Cambio: DateTimePicker + Label required.                                                                                                         | Pendiente |
| REG-ST-T-04| ST-T-04 (Timer no resetea) | Sin cambios en timer — solo confirmar que el flujo de toma de examen sigue intacto.                                                          | Pendiente |
| REG-T-M-04 | T-M-04 (Pausar/reanudar)   | Sin cambios en realtime — solo confirmar que el polling cada 4s sigue actuando como fallback.                                                 | Pendiente |
| REG-ADM-C-04| ADM-C-04 (Fecha fin < inicio) | Cambio: DatePicker. Confirmar que la validación sigue funcionando.                                                                         | Pendiente |

---

## 📋 7. Casos pendientes / mejoras futuras

> Reportadas en QA-RESULTADOS pero no críticas. Se mantienen aquí para
> seguimiento.

| ID      | Origen     | Caso                                                              | Estado          |
| ------- | ---------- | ----------------------------------------------------------------- | --------------- |
| FUT-01  | BUG-12     | Asistencia no tiene filtro por fecha o grupo.                    | Mejora futura   |
| FUT-02  | -          | Storage S3 backend (Supabase): hoy guarda en disco local de EC2. Plan: conectar el bucket S3 ya creado. | Mejora futura   |

---

## ✅ Definición de "QA aprobado"

Una iteración queda aprobada cuando:

1. Todos los casos de las secciones 1, 2, 3, 4 están en estado **OK**.
2. Todos los casos de la sección 5 (despliegue AWS) están **OK** o **N/A** justificado.
3. La sección 6 de regresión P0 pasa sin defectos.
4. `npm run test:run` pasa al 100%.
5. Los defectos encontrados están documentados como BUG-NN en
   `QA-RESULTADOS.md` con su severidad y commit de corrección (si aplica).

---

_Última actualización: 2026-04-30. Sesiones previas y bugs corregidos en
[`QA-RESULTADOS.md`](QA-RESULTADOS.md)._
