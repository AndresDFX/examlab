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

## 🆕 1. Proyectos: caja de texto por archivo + preview Mermaid

> Funcionalidad nueva. Reemplaza el flujo anterior de "subir ZIP" por
> N cajas de texto (una por archivo esperado), con calificación inmediata
> archivo-por-archivo y vista previa Mermaid para diagramas.

| ID         | Módulo                        | Rol        | Prioridad | Caso                                                                                                                                                                                                                          | Estado    |
| ---------- | ----------------------------- | ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| PROJ-T-01  | Docente · Proyectos           | Docente    | P0        | Crear proyecto, ir a "Archivos esperados" → tab **Manual**: crear 2 archivos (Título + Rúbrica + Puntos). Aparecen en la lista numerados.                                                                                     | Pendiente |
| PROJ-T-02  | Docente · Proyectos           | Docente    | P0        | Tab **Generar con IA**: indicar tema "Sistema de inventario" + 3 archivos. La IA crea 3 slots con título y rúbrica coherentes. No se duplican si se repite el botón.                                                          | Pendiente |
| PROJ-T-03  | Docente · Proyectos           | Docente    | P1        | Eliminar archivo desde la lista pide confirmación. Tras confirmar, desaparece de la lista y deja de mostrarse al estudiante en su próximo intento.                                                                            | Pendiente |
| PROJ-T-04  | Docente · Proyectos           | Docente    | P1        | Crear proyecto con `language: "mermaid"` en algún archivo (vía Generar IA con tema "Diagrama de flujo del proceso de matrícula"). El slot debe aparecer marcado como diagrama en la vista del estudiante.                     | Pendiente |
| PROJ-S-01  | Estudiante · Proyectos        | Estudiante | P0        | Abrir proyecto asignado y disponible: el modal muestra una caja por cada archivo definido por el docente (con título y descripción). Cada caja es obligatoria (asterisco rojo).                                               | Pendiente |
| PROJ-S-02  | Estudiante · Proyectos        | Estudiante | P0        | Pegar contenido en cada caja y enviar: la calificación se hace **inmediatamente archivo por archivo**. Aparece nota global `final_grade / max_score` y feedback IA.                                                           | Pendiente |
| PROJ-S-03  | Estudiante · Proyectos        | Estudiante | P0        | Intentar enviar dejando una caja vacía: muestra error `Falta contenido en: <título>`. No envía la entrega.                                                                                                                    | Pendiente |
| PROJ-S-04  | Estudiante · Proyectos · Mermaid | Estudiante | P0        | En un slot de tipo diagrama (o cualquier slot donde el contenido empiece con `flowchart`, `graph`, `sequenceDiagram`, etc.), pegar código Mermaid válido: aparece **preview renderizado** debajo del textarea.                | Pendiente |
| PROJ-S-05  | Estudiante · Proyectos · Mermaid | Estudiante | P1        | Pegar Mermaid con sintaxis inválida (ej. `flowchart\n A -->`): aparece bloque rojo "Error en el diagrama: …". El textarea no se bloquea — el estudiante puede corregir.                                                       | Pendiente |
| PROJ-S-06  | Estudiante · Proyectos · Mermaid | Estudiante | P2        | El badge `Mermaid` aparece en el header del slot en cuanto el contenido es válido o cuando `language` indica diagrama, aunque el contenido aún no esté completo.                                                              | Pendiente |
| PROJ-R-01  | Estudiante · Revisión proyecto | Estudiante | P0        | Tras calificación, abrir detalle del proyecto: cada archivo muestra el contenido entregado en bloque monospace + nota `earned/points` + feedback IA. Si era diagrama, también muestra preview Mermaid.                       | Pendiente |
| PROJ-R-02  | Estudiante · Revisión proyecto | Estudiante | P1        | Si IA detectó alta probabilidad de generación por IA (`ai_likelihood >= 0.6`), aparece badge rojo "Posible IA" en el header del archivo.                                                                                      | Pendiente |
| PROJ-G-01  | IA · Calificación archivo     | -          | P0        | Cuota Gemini agotada en `gemini-2.5-flash`: el wrapper inyectado **automáticamente reintenta** con `gemini-2.0-flash`, `2.0-flash-lite`, `1.5-flash`, `1.5-flash-8b`. El log de la edge function muestra `[AI fallback] succeeded with X`. | Pendiente |
| PROJ-G-02  | IA · Calificación archivo     | -          | P1        | Si todos los modelos del fallback fallan, la entrega se guarda con `ai_grade=0` y `ai_feedback="Error IA: …"`. El estudiante ve la calificación pero con mensaje de error.                                                    | Pendiente |

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

## 🆕 4. Despliegue AWS self-hosted (lovable-aws-deployment)

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

## 🔄 5. Regresión crítica (P0) tras cambios recientes

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

## 📋 6. Casos pendientes / mejoras futuras

> Reportadas en QA-RESULTADOS pero no críticas. Se mantienen aquí para
> seguimiento.

| ID      | Origen     | Caso                                                              | Estado          |
| ------- | ---------- | ----------------------------------------------------------------- | --------------- |
| FUT-01  | BUG-12     | Asistencia no tiene filtro por fecha o grupo.                    | Mejora futura   |
| FUT-02  | -          | Storage S3 backend (Supabase): hoy guarda en disco local de EC2. Plan: conectar el bucket S3 ya creado. | Mejora futura   |

---

## ✅ Definición de "QA aprobado"

Una iteración queda aprobada cuando:

1. Todos los casos de las secciones 1, 2, 3 están en estado **OK**.
2. Todos los casos de la sección 4 (despliegue AWS) están **OK** o **N/A** justificado.
3. La sección 5 de regresión P0 pasa sin defectos.
4. `npm run test:run` pasa al 100%.
5. Los defectos encontrados están documentados como BUG-NN en
   `QA-RESULTADOS.md` con su severidad y commit de corrección (si aplica).

---

_Última actualización: 2026-04-30. Sesiones previas y bugs corregidos en
[`QA-RESULTADOS.md`](QA-RESULTADOS.md)._
