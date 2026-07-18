# Manual — Estudiante

Bienvenido a ExamLab. Como estudiante, aquí aprendes con el material de tus cursos, presentas tus evaluaciones (exámenes, talleres y proyectos), registras tu asistencia, participas en retos en vivo y haces seguimiento a tus notas y certificados. Esta guía recorre, módulo por módulo, qué hace cada sección y cómo usarla en el día a día. Varias funciones se apoyan en **inteligencia artificial**: un **Tutor del curso** que responde con base en el material de tu curso, la calificación automática de tus entregas y la detección de fraude — todo se resalta a lo largo del manual.

Ingresa desde **https://examlab.lovable.app/auth** con el correo y la contraseña que te entregó tu institución. Si es tu primer ingreso con una contraseña temporal, la app te pedirá cambiarla antes de continuar.

> **🎬 Recorrido en video:** mira el [recorrido completo del rol Estudiante](../student/serie-student-completa.mp4) — todos los módulos de este manual unidos en un solo video.

---

### Panel

Es tu pantalla de inicio: un vistazo rápido a lo que tienes pendiente y lo que viene.

- Revisa los cuatro indicadores de arriba: próximos exámenes, próximos talleres, próximos proyectos y conversaciones por responder.
- Usa el **calendario de eventos** (izquierda) y la **agenda** (próximas clases y próximos exámenes, derecha) para no perder fechas.
- Haz clic en cualquier indicador o evento para ir directo a esa actividad.

![Panel](screenshots/estudiante/01-dashboard.png)

### Calendario

Vista mensual con todas tus actividades del curso para que organices tu estudio.

- Cambia de mes con las flechas y observa los puntos de color que marcan cada tipo de evento (clase, examen, taller, proyecto).
- Haz clic en un día para ver el detalle de lo que ocurre y abrir la actividad correspondiente.
- Solo aparecen actividades vigentes; lo que el docente elimina deja de mostrarse automáticamente.

![Calendario](screenshots/estudiante/02-student_calendar.png)

### Mis cursos

El tablero de cada curso: aquí encuentras el material de clase organizado por sesión.

- Abre un curso y recorre sus sesiones para ver documentos, presentaciones, imágenes y PDF. Cada curso tiene su propio nombre (puede diferir del nombre de la asignatura oficial).
- Visualiza imágenes y PDF **dentro de la app** (sin descargar) y descarga lo que necesites.
- Ejecuta archivos de código (Java, Python, JavaScript) con el botón **Ejecutar**, o abre notebooks `.ipynb` con **Abrir notebook** para correr todo el código de una vez.
- El código y los notebooks se abren en un editor de práctica: puedes modificarlos y ejecutarlos para experimentar, pero esos cambios no se guardan (es solo un espacio para probar).

![Mis cursos](screenshots/estudiante/03-student_courses.png)

### Exámenes

Lista de tus exámenes para presentarlos y, después, revisar resultados.

- Entra a un examen disponible y respóndelo; el sistema **guarda tu avance automáticamente** cada pocos segundos, así que no pierdes lo escrito aunque se cierre la pestaña.
- Atiende las reglas de cada examen. Según cómo lo configuró el docente:
  - **Tiempo límite:** un cronómetro cuenta el tiempo restante; al llegar a cero se entrega automáticamente.
  - **Navegación secuencial o libre:** en modo secuencial avanzas pregunta por pregunta sin poder regresar (se te confirma antes de pasar a la siguiente); en modo libre puedes ir y volver entre preguntas.
  - **Pantalla completa y antifraude (proctoring):** el examen puede forzar pantalla completa. Si sales de la pantalla del examen, cambias de pestaña o abandonas el modo pantalla completa, se registra una **advertencia**. Al acumular varias advertencias el examen se marca como sospechoso.
- **Preguntas de código:** cuando una pregunta es de programación, puedes ejecutar tu código en el momento. Si un compilador falla o tarda, usa el **selector de compilador** de la pregunta para cambiar a otra opción, y el botón **Cancelar** para detener una ejecución que se demora y volver a intentarla.
- **Modo sin conexión:** si te quedas sin internet durante el examen, la app sigue guardando tus respuestas localmente y las **sincroniza** cuando la conexión regresa.
- Al entregar, muchas preguntas se califican con **IA** y luego puedes ver tu nota y la retroalimentación en la revisión de resultados.

> **Consejo:** antes de entregar, revisa las preguntas en blanco. Si dejas alguna sin responder, la app te pide confirmar para que no entregues por error.

![Exámenes](screenshots/estudiante/04-student_exams.png)

### Tutor del curso

Un asistente con **inteligencia artificial** que responde tus dudas usando el material real de tu curso.

- Escribe tu pregunta y recibe la respuesta en vivo; el tutor lee el contenido publicado por el docente (documentos, presentaciones, notebooks, código), no solo los títulos.
- Escribe `#` para **referenciar un archivo** del curso y enfocar la respuesta en ese material concreto; aparece un buscador con los archivos disponibles.
- Úsalo para repasar antes de un examen, aclarar conceptos o entender un ejemplo de clase.

![Tutor del curso](screenshots/estudiante/05-student_tutor.png)

### Talleres

Actividades prácticas con preguntas que entregas para calificación.

- Abre el taller, responde y entrega; si el docente lo configuró como **trabajo en grupo**, verás una tarjeta con tu grupo y todos sus integrantes compartirán una sola entrega y recibirán la misma nota.
- Si dejas respuestas en blanco, la app te pide confirmar antes de entregar.
- Tus respuestas pueden calificarse con **IA** y la retroalimentación queda disponible al terminar.

![Talleres](screenshots/estudiante/06-student_workshops.png)

### Pizarras

Espacio de dibujo y diagramas para colaborar en clase cuando el docente lo habilita.

- Aparece el botón **Pizarra** en tus sesiones solo cuando el docente activa la pizarra compartida.
- Dibuja y edita junto a tu profesor y compañeros: los cambios se sincronizan **en vivo**.
- Útil para flujos, diagramas UML o estructuras de datos durante la sesión.

![Pizarras](screenshots/estudiante/07-student_whiteboards.png)

### Proyectos

Entregas más grandes que combinan archivos, código y, a veces, sustentación.

- Sube tus entregables (documentos, diagramas y, si aplica, tu código completo en un `.zip`) y agrega el **enlace al repositorio** cuando se solicite (es obligatorio y debe empezar por `https://...`).
- Si el docente activó el **trabajo en grupo**, tu grupo comparte una sola entrega y la misma nota.
- Al entregar, la **IA** califica tu trabajo y deja una nota preliminar.
- La **nota final** se confirma tras la **sustentación**; mientras tanto verás "Falta sustentación". La nota final combina la nota de la entrega con el resultado de tu sustentación.

![Proyectos](screenshots/estudiante/08-student_projects.png)

### Calificaciones

Tu boletín por curso: cómo van tus notas corte por corte.

- Selecciona el curso para ver el desglose por corte y por actividad (exámenes, talleres, proyectos y asistencia).
- Recuerda que las actividades sin nota cuentan como cero hasta que se califiquen, así que entrega a tiempo.
- Si una vista no carga, usa **Reintentar** para volver a consultarla.

![Calificaciones](screenshots/estudiante/09-student_grades.png)

### Asistencia

Registra tu presencia en clase de forma autónoma, sin que el docente llame uno por uno.

- Cuando el profesor abre el check-in, aparece la tarjeta **Check-in disponible**: escanea el **código QR** con la cámara o ingresa el **código de 6 dígitos** manualmente.
- El código rota cada cierto tiempo; ingrésalo mientras esté visible (hay una pequeña gracia entre rotaciones).
- Si escaneas el QR con la cámara de tu celular, el **enlace te lleva directo** a la app y registra tu asistencia automáticamente.
- Desde cada sesión también puedes abrir los **snippets de código** que preparó el docente para verlos o ejecutarlos.

![Asistencia](screenshots/estudiante/10-student_attendance.png)

### Certificaciones

Consulta y descarga los certificados que te emite la institución.

- Revisa la lista de tus certificados disponibles por curso o programa.
- Descarga el documento cuando lo necesites para trámites o tu portafolio.
- Cada certificado incluye un código de verificación público, para que quien lo reciba pueda confirmar que es auténtico.
- Usa el buscador y la paginación si tienes varios certificados acumulados.

![Certificaciones](screenshots/estudiante/11-student_certificates.png)

### Encuestas

Participa en encuestas y votaciones del curso, incluida la reserva de horarios tipo Doodle.

- Abre una encuesta activa, elige tu opción (o tu cupo de horario) y envía tu respuesta.
- Si la encuesta lo permite, puedes **cambiar tu respuesta** o usar **Quitar mi respuesta** mientras siga abierta.
- También puedes llegar directo a una encuesta mediante el enlace que comparta el docente.

![Encuestas](screenshots/estudiante/12-student_polls.png)

### Reto en vivo

Retos tipo trivia en vivo que el docente proyecta en clase: respondes preguntas contra el reloj y compites por el puntaje más alto. Ganas más puntos si aciertas rápido.

- **Desde tu cuenta:** cuando hay un reto en vivo en alguno de tus cursos, en la parte superior de **Encuestas** aparece una tarjeta de **Reto en vivo**. Escribe el **PIN de 6 dígitos** que el docente proyecta y toca **Unirme**. Si ya estabas dentro de un reto, verás un botón para **reconectarte** sin volver a escribir el PIN.
- **Escaneando el QR:** apunta la cámara al código QR que proyecta el docente; el enlace te lleva directo al reto.
- **Sin iniciar sesión (enlace público):** si te comparten el enlace público del reto o escaneas su QR, aterrizas en una pantalla donde solo ingresas tu **correo institucional** para participar — no necesitas iniciar sesión. Solo pueden jugar los correos matriculados en el curso, y hay un jugador por correo.
- **Durante el juego:** verás una cuenta regresiva de "¡Prepárate!" antes de cada pregunta, y luego las opciones como formas de colores. Toca tu respuesta (o marca varias y confirma, si la pregunta lo permite) antes de que se acabe el tiempo.
- **Sonido:** hay un botón para **activar o silenciar** los efectos de sonido cuando quieras.
- **Podio y posición:** entre pregunta y pregunta ves tu posición en el marcador, y al final aparece el **podio** con los ganadores y tu puesto.

<!-- screenshot sugerido: pantalla del jugador en un Reto en vivo (opciones de colores + cronómetro) -->

### Asistente IA

Un chat de **ayuda de uso de la app**, disponible desde el menú. A diferencia del **Tutor del curso** (que responde sobre el material de tu curso), el Asistente IA te explica **cómo usar ExamLab**: cómo entregar un taller, ver tus notas, registrar tu asistencia, unirte a un reto en vivo, etc.

- Ábrelo desde **Asistente IA** en el menú y pregunta con tus palabras.
- Adapta las respuestas a tu rol: como estudiante, te guía en lo que **tú** puedes hacer.
- Si algo no está en la documentación, te sugiere a quién consultar.

### Mensajes (pie de página)

La mensajería con tus docentes y compañeros vive en el **ícono de mensajes** del pie de página, junto a la campana de notificaciones. El badge te marca los no leídos.

- **Chat 1-a-1** con tus docentes (y, según permisos, con compañeros): puedes escribir, adjuntar archivos y buscar dentro de la conversación.
- **Avisos del docente**: cuando un profesor envía una difusión a todo el curso, te llega como **notificación**, **correo** y un mensaje en tu conversación con él (así puedes responderle directo si tienes dudas).
- Tu profesor a veces incluye enlaces con `#` a un examen, taller o archivo del curso; al tocarlos te llevan directo a esa actividad.
- Puedes **eliminar una conversación** de tu lista; si el otro te vuelve a escribir, la conversación reaparece con los mensajes nuevos.

### Foros del curso

Cuando tu docente abre un **foro de discusión** dentro de un curso, lo verás desde el tablero del curso. Sirven para debate asincrónico — preguntas, hilos colaborativos, discusión guiada por una pregunta del profesor.

- Cada foro tiene una **ventana** (apertura y cierre): solo puedes participar mientras esté abierto.
- Abre un hilo (o responde uno existente) y revisa las respuestas. Las notificaciones te avisan cuando alguien responde en un hilo donde participaste.
