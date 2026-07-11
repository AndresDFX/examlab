# ExamLab — Insumos para "Generar con IA" · Administración de Sistemas Operativos de Servidor

Guía para generar en **ExamLab** (https://examlab.lovable.app) el curso, sus sesiones y sus evaluaciones, como **Docente** en el tenant **FESNA / La Nueva América**.

> **Cómo se usa este archivo.** Es una guía operativa: la generación con IA la disparas **tú, autenticado como Docente** desde la UI. Desde el entorno de desarrollo solo hay clave anon — **no se escribe nada en producción** al preparar esta guía.
>
> **Esta versión está verificada contra el código real de ExamLab** (edge `generate-contents`, `src/routes/app.teacher.contents.tsx`, tipos de taller). La guía original tenía varios desajustes con la plataforma que habrían hecho que el resultado no fuera el esperado al pegarla — se corrigen abajo, con evidencia.

---

## 0) Correcciones frente a la guía original (por qué cambió)

| # | La guía original decía | Realidad en ExamLab | Evidencia |
|---|---|---|---|
| C1 | Se genera desde "Contenidos → **Generar con IA**". | El módulo es **Contenidos** (`/app/teacher/contents`), pero la acción es: botón **"Nuevo contenido"** → llenar el formulario → botón **"Generar contenido"** (muestra "Generando…"). No existe un botón llamado "Generar con IA". | `app.teacher.contents.tsx:1868` `t("contents.submit")="Generar contenido"` · `es.json:1168` |
| C2 | Modo `curso_completo`. | ✅ Correcto. Label visible: **"Curso completo"**. | `app.teacher.contents.tsx:126,1680` · `es.json:1129` |
| **C3** ⚠️ | "ExamLab generará por cada clase: presentación · guía docente · taller práctico · ejercicio · examen." | **Dos matices críticos.** (1) Lo generado son **archivos descargables** (`.pptx`-fuente y `.md`), **NO entidades** de la plataforma: el "taller" y el "examen" generados son **documentos didácticos**, no un Taller/Examen funcional. (2) Qué bloques se producen depende del control **"Tipos de contenido"** (tags). Por defecto solo vienen **Teórico + Práctico** → presentación, guía docente, taller práctico y ejercicio (enunciado + solución). **El examen SOLO se genera si marcas además el tipo "Examen".** | edge `generate-contents/index.ts:492-521, 680-731` (sube a Storage + JSONB `files`, cero INSERT a `workshops`/`exams`); tags default `["teorico","practico"]` en `app.teacher.contents.tsx:430` |
| C4 | Campo "Nombre (display_name)". | El label visible es **"Nombre del contenido"** (columna DB `display_name`). Input, máx. 120, único por docente. | `app.teacher.contents.tsx:1633-1642` · `es.json:7622` |
| C5 | "Nº de clases / sesiones". | Label real **"Cantidad de clases"** (`n_classes`), numérico 1–40, **solo visible en modo Curso completo**. | `app.teacher.contents.tsx:1693-1706` · `es.json:1133` |
| C6 | "Duración por clase" 105 min. | ✅ Existe el campo **"Duración por clase (min)"**, rango 10–480, paso 5; 105 es válido. Es **un único valor uniforme** para todas las clases. | `app.teacher.contents.tsx:1708-1727` · `es.json:1134` |
| C7 | Pegar el bloque largo en "topic". | ✅ El campo **"Tema"** es un textarea sin límite: el bloque entra. (Recomendado: partir el texto — ver Paso 1.) | `app.teacher.contents.tsx:1655-1661` |
| C8 | "Asignar a sesiones" para enlazar bloques a las 6 clases. | ✅ Existe: acción de fila **"Asignar a sesiones del curso"** (solo cuando el contenido está *listo* y tiene curso). El **6 no es una constante**: es tu valor "Cantidad de clases". | `app.teacher.contents.tsx:1508-1514, 3080-3137` · `es.json:1276` |
| **C9** ⚠️ | Talleres de "archivo/entrega (capturas de terminal online)"; "red consola" no aplica. | (a) ✅ `red_consola` es consola **Cisco IOS de redes** (no shell de SO): correcto descartarlo. (b) ❌ **NO existe un tipo de pregunta para subir imágenes/capturas en NINGÚN flujo** (talleres, proyectos ni exámenes). El único tipo por subida de archivo es `codigo_zip` — y tanto en talleres como en proyectos está restringido por *whitelist* a **código fuente** (java/py/js/…): una **captura `.png/.jpg` sería rechazada**. La ruta correcta para evidencia de terminal es **pregunta abierta**: el alumno **pega la salida del comando como texto**. | tipos en `WorkshopQuestions.tsx:81-91, 752-765` y `projects/ProjectFiles.tsx:857-863`; whitelist `shared/lib/code-upload.ts:16-31,59-65`; `network/README.md` |
| C10 | Referencia a `Clases/`, `Guiones/`, `Contexto.MD`. | ✅ Esos archivos **no viven en este repo** (ExamLab es la plataforma; los materiales están en otro repo). | glob/grep sin resultados |

---

## 1) Generar el material del curso

**Ruta:** ExamLab → rol **Docente** → módulo **Contenidos** (`/app/teacher/contents`) → botón **"Nuevo contenido"**.

En el diálogo **"Nuevo contenido"** llena, **con estos nombres reales**:

| Campo (label real) | Valor |
|---|---|
| **Nombre del contenido** *(obligatorio)* | `Administración de Sistemas Operativos de Servidor` |
| **Tema** *(obligatorio, textarea)* | El bloque de sesiones (ver abajo). |
| **Modo** | **Curso completo** |
| **Cantidad de clases** *(solo en Curso completo)* | `6` |
| **Duración por clase (min)** | `105` |
| **Tipos de contenido** ⚠️ | **Marca los tres: Teórico + Práctico + Examen.** (Por defecto solo vienen Teórico y Práctico → sin el tercero **no se genera el examen**.) |
| **Curso (opcional)** | El curso de FESNA (créalo antes en **Cursos** si no existe). Necesario para "Asignar a sesiones" y "Materializar" del Paso 2. |
| **Idioma** | Español |
| **Autor** | `Julian Andrés Castaño Espinosa` |
| **Instrucciones** *(opcional pero recomendado)* | Pega aquí las **REGLAS OBLIGATORIAS** (ver bloque separado). |

> **Reparto sugerido del texto:** el **cuadro de sesiones** va en **Tema**; las **REGLAS OBLIGATORIAS** van en **Instrucciones**. Ambos campos alimentan el prompt. Si prefieres, puedes pegar todo junto en "Tema" (el textarea no tiene límite).

Luego pulsa **"Generar contenido"** (mostrará "Generando…").

### Tema (pega en el campo **Tema**)

```
Administración de Sistemas Operativos de Servidor — Ingeniería de Sistemas (FESNA / La Nueva América). 6 clases de 105 minutos cada una (TODAS la misma duración). Curso tipo D (Coursera). Referencia: curso interno "Sistemas Operativos" adaptado a servidores (Linux y Windows Server).

Sesiones:
1. Administración por Consola del Servidor — CLI vs GUI (headless), jerarquía del sistema de archivos (FHS de Linux y unidades de Windows), navegación y manipulación de archivos, administración remota (SSH, PowerShell Remoting/RDP). Nivel 1 (Identificar).
2. Usuarios, Grupos y Permisos del Servidor — usuarios/grupos, permisos rwx y octales (chmod/chown), sudo, permisos NTFS, mínimo privilegio. Nivel 1.
3. Gestión de Software y Servicios — paquetes y repositorios (apt/dnf/winget), servicios/daemons con systemd (systemctl) y servicios de Windows; enable vs start. Nivel 2 (Analizar).
4. Almacenamiento del Servidor — sistemas de archivos (ext4/xfs/NTFS), particiones y montaje (mount/fstab), LVM y RAID, monitoreo de espacio (df/du). Nivel 2.
5. Procesos, Recursos y Tareas Programadas — procesos y señales (ps/top/kill), CPU/memoria/carga, prioridades, automatización (cron, systemd timers, Programador de tareas). Nivel 3 (Evaluar).
6. Redes, Logs, Respaldos y Troubleshooting — red del servidor (ip/ping/ss), logs (journalctl/Visor de eventos), respaldos (tar/rsync, regla 3-2-1), firewall y hardening, método de troubleshooting. Nivel 3.
```

### REGLAS OBLIGATORIAS (pega en el campo **Instrucciones**)

```
- Práctica SIN instalar nada y SIN Cisco Packet Tracer. Usar SIEMPRE terminales de servidor EN LÍNEA: JSLinux (bellard.org/jslinux), Webminal (webminal.org), DistroSea (distrosea.com) y PowerShell/CMD nativo para Windows. Los entregables, diagramas y la ruta de aprendizaje van en ExamLab. (ExamLab NO simula terminal de SO: la práctica de comandos es en los terminales online / terminal real.)
- Evaluación (mostrar SOLO en la presentación del curso —la portada INTRO_CURSO—, NUNCA en las diapositivas de sesión): Progreso del curso en Coursera 90% · Asistencia 10%. Opcionales: participación +0.3, Reto en vivo 🥇+0.5/🥈+0.4/🥉+0.3. Licencias Coursera activas hasta el día hábil posterior al cierre (9:00 AM).
- Diapositivas de SESIÓN: NO incluir "Recordemos la asignatura" ni "¿Cómo trabajaremos hoy?". No recordar cómo se califica en las sesiones. 9 diapositivas por sesión: Portada, El propósito de hoy, 4 de contenido, Trabajo autónomo, ¿Qué logramos hoy?, Cierre.
- Guía docente: escrita asumiendo que el docente NO SABE NADA del tema (fundamento teórico exhaustivo desde cero, con analogías, ejemplos de comandos con su salida y tablas), luego plan por fases (15·25·25·25·10 = 100 min) + actividad individual de 15 min.
- Tutor: Julian Andrés Castaño Espinosa (Líder Técnico · Ingeniero de Sistemas · Candidato a MsC en IA · julian.castano@lanuevaamerica.edu.co).
```

> **Nota de marca.** La instrucción de "Barlow / naranja #FD531E" influye en el **tono textual**, pero **el aspecto visual real de las diapositivas** (colores, logo, nombre de la universidad) sale de la configuración de marca institucional (`content_brand_config`), no del texto del Tema/Instrucciones. Si el PPTX no sale con la marca esperada, ajústala en la configuración de marca del tenant, no aquí.

### Qué produce (y qué NO)

Con **Teórico + Práctico + Examen** marcados, la IA genera, **como archivos descargables** (`.pptx`-fuente convertible + `.md`), sufijados `_CLASE_N`:

- **Una vez, portada del curso:** `INTRO_CURSO.PPTX` (objetivos, justificación, cronograma de las 6 clases) — aquí es donde va la evaluación 90/10.
- **Por cada clase (×6):** `PRESENTACION` · `GUIA_DOCENTE` · `TALLER_PRACTICO` · `EJERCICIO_ESTUDIANTE` + `EJERCICIO_SOLUCION` · `EXAMEN`.

**No** son un Taller ni un Examen funcionales de la plataforma — son documentos para el docente. Para volverlos evaluables, ver **Paso 2** (Materializar) y **Paso 3** (talleres reales).

> **Sync vs async.** En FESNA `processing_mode = sync`, así que la generación corre **inline** (no pide código). Si estuviera en `async`, el job se **encola** (aparece en *Cola IA → Generaciones*) hasta que un admin lo procese o se use un código de IA inmediata.

---

## 2) Convertir el material en sesiones y evaluaciones reales

Una vez el contenido esté en estado **listo** (y tenga curso asignado), en su fila del grid de Contenidos aparecen tres acciones (menú de la fila):

1. **"Programar sesiones del curso"** *(ícono calendario +)* — crea las `N` sesiones de asistencia con fechas.
2. **"Asignar a sesiones del curso"** *(ícono calendario rango)* — abre "Asignar contenido a sesiones": por cada sesión eliges a qué **Clase 1..6** del contenido se enlaza.
3. **"Materializar curso"** *(ícono varita, solo Curso completo)* — crea **evaluaciones reales por corte**: inserta `workshops` / `exams` / `projects` (en estado **borrador**), tomando el **peso** de cada corte (`grade_cuts`) y como **descripción** el texto de las clases que caen en el rango de fechas del corte. **Requisitos:** el curso debe tener **cortes con fechas** y las sesiones deben estar **asignadas** (paso 2). El wizard propone título editable + checkbox por evaluación.

> Importante: "Materializar" crea el **cascarón** de la evaluación (título, descripción, peso, corte). **No genera preguntas** — esas se agregan después en cada Examen/Taller. Para talleres con preguntas concretas, ver Paso 3.

---

## 3) Talleres funcionales (uno por sesión)

Crea cada taller en **Talleres → Nuevo** (o parte del cascarón que dejó "Materializar"). **Corrección de entrega:** ExamLab **no tiene ningún tipo de pregunta para subir capturas de pantalla** (ni en talleres, ni en proyectos, ni en exámenes). Por eso, para la evidencia de comandos usa:

- **Pregunta abierta** — el alumno **pega la salida del comando como texto** (la ruta recomendada y única fiable para esta práctica). Calificable a mano o con IA. Los enunciados de abajo ya están redactados para pedir "pega la salida".
- Si necesitas **entregar archivos de código** (no imágenes), existe `codigo_zip`, pero solo acepta código fuente por *whitelist* de extensión — una captura `.png/.jpg` sería rechazada. No sirve para screenshots.
- La parte **visual** (jerarquía `/`, diagramas) va en la **pizarra de ExamLab** (Pizarras), que sí es nativa.

> `red_consola` / `red_gui` (tipos "Red (consola)" / "Red (diagrama)") son para **redes Cisco IOS**, no para shell de SO — **no** los uses aquí.

| Sesión | Taller | Enunciado |
|---|---|---|
| 1 | Primer recorrido por el servidor | En JSLinux/Webminal: `pwd`, recorre `/`, entra a `/etc` y `/var/log`, crea `~/practica/dia1`, copia y renombra un archivo; **pega la salida de** `pwd` + `ls -l`; diagrama la jerarquía `/` en la pizarra de ExamLab. |
| 2 | Usuarios, grupos y permisos 640 | Crea grupo `proyecto` y usuario `ana`, agrégalo al grupo; crea `informe.txt` con permisos **640**; verifica con `ls -l` (pega la salida) y explica por qué 640 sirve para un archivo confidencial compartido con el grupo. |
| 3 | Instala y enciende un servicio | `apt update` + instala una utilidad ligera (tree/nano) y verifica; `systemctl status` de un servicio (cron/ssh); explica la diferencia entre `start` y `enable`. |
| 4 | Radiografía del almacenamiento | `df -h` (identifica el FS de `/` y su espacio) y `du -sh /var/*` (carpeta más pesada); explica con tus palabras la diferencia entre partición y punto de montaje. |
| 5 | Cazador de procesos + cron | Con `ps`/`top` identifica el proceso que más consume; lanza y termina un proceso con `kill`; escribe una línea de `cron` diaria y explica sus 5 campos. |
| 6 | Detective del servidor | `ip a` + `ping`, `ss -tlnp` (puertos), lee un log con `journalctl -xe`, propón un `tar` para respaldar `/etc` y aplica el método de troubleshooting al caso "el servicio web no responde". |

---

## 4) Notas

- El material generado por ExamLab es **independiente** de los `.pptx`/guiones ya entregados en el repo de materiales (`Clases/`, `Guiones/`) — que **no viven en este repo**. Es la versión editable dentro de la plataforma.
- Si el curso **NO** usa Coursera, cambia la evaluación a tipo A (Destreza 50 / Prueba 40 / Asistencia 10) en el bloque de **Instrucciones**.
- Para **regenerar solo una clase** (sin rehacer todo), usa la regeneración parcial del contenido (`target_class`) desde el diálogo de regenerar; deja las demás clases intactas.
```
