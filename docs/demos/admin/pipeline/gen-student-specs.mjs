import { writeFileSync } from "node:fs";
const DIR = "C:/Temp/examlab-rec/modules";
const V = { name: "es-CO-GonzaloNeural", rate: "-4%" };
const card = (kicker, title, subtitle) => ({ kicker, title, subtitle });
// bufferMs alto en las carátulas: deja la tarjeta en pantalla ~2s extra tras la
// narración → da aire al unir clips y asegura el piso de 30s del estándar.
const intro = (title, narration) => ({ id: "intro", kind: "card", narration, card: card("ExamLab · Rol Estudiante", title, "Demo Global Corp"), bufferMs: 2200 });
const outro = (subtitle, narration) => ({ id: "outro", kind: "card", narration, card: card("ExamLab · Rol Estudiante", "Siguiente módulo", subtitle), bufferMs: 2200 });

// Escena de overview con DOS beats: (1) el ítem del sidebar ("estás aquí") y
// (2) el contenido de la página (firstcard). Narración de ~3 frases para que
// el módulo dure entre 30 y 60s, manteniendo el estándar de la serie.
const over = (narration, navPath, navTitle, navBody, cardTitle, cardBody, scale = 1.12) => ({
  id: "vista", kind: "platform", narration, bufferMs: 800,
  beats: [
    { target: `[data-tour-nav="${navPath}"]`, scale: 1.5, hold: 3600, side: "right", focus: { title: navTitle, body: navBody } },
    { target: "firstcard", scale, hold: 5500, side: "bottom", focus: { title: cardTitle, body: cardBody } },
  ],
});

const mk = (id, title, appPath, ready, scenes) => ({ id, title, series: "student", role: "Estudiante", appPath, readySelectors: ready, voice: V, scenes });
const nav = (path, text) => [`[data-tour-nav="${path}"]`, `text=${text}`];

const specs = [
  mk("modulo-s01", "Panel del Estudiante", "/app", ['[data-tour-id="role-switcher"]', "text=Próximas"], [
    intro("Panel del Estudiante", "Demostración del rol Estudiante en ExamLab, sobre la institución Demo Global Corp."),
    { id: "identidad", kind: "platform", narration: "El entorno mantiene la identidad de la institución. Ahora operamos como Estudiante: el menú muestra solo lo que el alumno necesita para aprender y mantenerse al día.", bufferMs: 800, beats: [
      { target: '[data-tour-id="role-switcher"]', scale: 1.6, hold: 4200, side: "right", focus: { title: "Tu rol", body: "Operás como Estudiante." } },
    ]},
    { id: "panel", kind: "platform", narration: "El panel de inicio reúne, en una sola vista, el calendario de eventos y la agenda con las próximas clases y exámenes. Es el punto de partida para saber, de un vistazo, qué tiene pendiente el estudiante.", bufferMs: 800, beats: [
      { target: "firstcard", scale: 1.12, hold: 4800, side: "bottom", focus: { title: "Tu panel", body: "Calendario y pendientes." } },
      { target: "text:Próximas", scale: 1.3, hold: 4500, side: "bottom", focus: { title: "Agenda", body: "Próximas clases y exámenes." } },
    ]},
    outro("Mis Cursos", "En el siguiente módulo: tus cursos."),
  ]),
  mk("modulo-s02", "Mis Cursos (Estudiante)", "/app/student/courses", nav("/app/student/courses", "Cursos"), [
    intro("Mis Cursos", "Tus cursos, desde el rol Estudiante."),
    over("Aquí el estudiante encuentra los cursos en los que está matriculado. Al entrar a un curso accede a su tablero, con el material de clase organizado por sesión. Desde ahí consulta documentos, videos y recursos que el docente comparte a lo largo del periodo.",
      "/app/student/courses", "Mis cursos", "Donde vive cada curso.", "Tus cursos", "Material y sesiones de cada curso."),
    outro("Exámenes", "En el siguiente módulo: tus exámenes."),
  ]),
  mk("modulo-s03", "Exámenes (Estudiante)", "/app/student/exams", nav("/app/student/exams", "Exámenes"), [
    intro("Exámenes", "Presentación de exámenes, desde el rol Estudiante."),
    over("El estudiante ve los exámenes que el docente le ha asignado, cada uno con su fecha y su duración. Cuando la evaluación está abierta, la presenta en un entorno controlado, con cronómetro y medidas de supervisión. Al terminar, puede consultar su resultado y la retroalimentación.",
      "/app/student/exams", "Exámenes", "Tus evaluaciones asignadas.", "Tus exámenes", "Presentación con cronómetro y supervisión.", 1.18),
    outro("Talleres", "En el siguiente módulo: los talleres."),
  ]),
  mk("modulo-s04", "Talleres (Estudiante)", "/app/student/workshops", nav("/app/student/workshops", "Talleres"), [
    intro("Talleres", "Entrega de talleres, desde el rol Estudiante."),
    over("Los talleres son actividades prácticas con entrega y calificación. El estudiante revisa las instrucciones, desarrolla su trabajo y lo entrega antes de la fecha límite. Después recibe su nota y la retroalimentación detallada del docente.",
      "/app/student/workshops", "Talleres", "Tus actividades prácticas.", "Tus talleres", "Entrega y retroalimentación.", 1.15),
    outro("Proyectos", "En el siguiente módulo: los proyectos."),
  ]),
  mk("modulo-s05", "Proyectos (Estudiante)", "/app/student/projects", nav("/app/student/projects", "Proyectos"), [
    intro("Proyectos", "Entrega de proyectos, desde el rol Estudiante."),
    over("Los proyectos son entregas más amplias, a menudo en grupo. El estudiante sube sus archivos y el enlace al repositorio de su trabajo. La nota final combina la calificación de la entrega con la sustentación ante el docente.",
      "/app/student/projects", "Proyectos", "Tus entregas mayores.", "Tus proyectos", "Entrega, repositorio y sustentación.", 1.15),
    outro("Mis Notas", "En el siguiente módulo: tus notas."),
  ]),
  mk("modulo-s06", "Mis Notas (Estudiante)", "/app/student/grades", nav("/app/student/grades", "Calificaciones"), [
    intro("Mis Notas", "Consulta de calificaciones, desde el rol Estudiante."),
    over("El estudiante consulta sus calificaciones de cada curso, organizadas por corte. La vista muestra el aporte de cada examen, taller y proyecto al consolidado. Y al final, la nota definitiva del curso, ponderada según el esquema de evaluación.",
      "/app/student/grades", "Calificaciones", "Tu desempeño por curso.", "Tus notas", "Consolidado por corte y nota final."),
    outro("Asistencia", "En el siguiente módulo: la asistencia."),
  ]),
  mk("modulo-s07", "Asistencia (Estudiante)", "/app/student/attendance", nav("/app/student/attendance", "Asistencia"), [
    intro("Asistencia", "Registro de asistencia, desde el rol Estudiante."),
    over("El estudiante revisa las sesiones de clase de cada uno de sus cursos. Cuando el docente abre el check-in, se marca presente escaneando un código que rota cada pocos segundos. Así su asistencia queda registrada al instante, sin pasar lista manual.",
      "/app/student/attendance", "Asistencia", "Tus sesiones de clase.", "Tu asistencia", "Check-in con código rotativo."),
    outro("Encuestas", "En el siguiente módulo: las encuestas."),
  ]),
  mk("modulo-s08", "Encuestas (Estudiante)", "/app/student/polls", nav("/app/student/polls", "Encuestas"), [
    intro("Encuestas", "Participación en encuestas, desde el rol Estudiante."),
    over("El estudiante participa en las dinámicas que propone el docente. Puede votar en consultas de opinión, reservar un horario disponible o responder a los juegos tipo concurso en tiempo real. Es una forma ágil de participar durante la clase.",
      "/app/student/polls", "Encuestas", "Tu participación en clase.", "Tus encuestas", "Opinión, reservas y concursos."),
    outro("Pizarras", "En el siguiente módulo: las pizarras."),
  ]),
  mk("modulo-s09", "Pizarras (Estudiante)", "/app/student/whiteboards", nav("/app/student/whiteboards", "Pizarras"), [
    intro("Pizarras", "Pizarras compartidas, desde el rol Estudiante."),
    over("Cuando el docente comparte una pizarra en vivo, el estudiante la ve actualizarse en tiempo real. Y si la pizarra es colaborativa, también puede dibujar en ella. Es un espacio para resolver ejercicios y explicar ideas en conjunto durante la clase.",
      "/app/student/whiteboards", "Pizarras", "Espacios de dibujo.", "Pizarras compartidas", "Colaboración en vivo con el docente."),
    outro("Tutor IA", "En el siguiente módulo: el tutor con inteligencia artificial."),
  ]),
  mk("modulo-s10", "Tutor IA (Estudiante)", "/app/student/tutor", nav("/app/student/tutor", "Tutor"), [
    intro("Tutor IA", "El tutor con inteligencia artificial, desde el rol Estudiante."),
    over("El estudiante elige uno de sus cursos y conversa con un tutor de inteligencia artificial. El tutor conoce el material de ese curso, así que responde dudas y explica conceptos apoyándose en los contenidos que el docente compartió. Es un acompañamiento disponible en todo momento.",
      "/app/student/tutor", "Tutor IA", "Tu acompañante de estudio.", "Tutor del curso", "Responde con base en el material del curso."),
    outro("Certificados", "En el siguiente módulo: los certificados."),
  ]),
  mk("modulo-s11", "Certificados (Estudiante)", "/app/student/certificates", nav("/app/student/certificates", "Certificados"), [
    intro("Certificados", "Certificados de los cursos, desde el rol Estudiante."),
    over("Cuando el estudiante completa un curso que contempla certificación, su certificado aparece en esta sección. Desde aquí puede descargarlo en formato digital. Cada certificado incluye un código que permite verificar su autenticidad.",
      "/app/student/certificates", "Certificados", "Tus logros acreditados.", "Tus certificados", "Descarga y verificación."),
    outro("Calendario", "En el siguiente módulo: el calendario."),
  ]),
  mk("modulo-s12", "Calendario (Estudiante)", "/app/student/calendar", nav("/app/student/calendar", "Calendario"), [
    intro("Calendario", "El calendario de eventos, desde el rol Estudiante."),
    over("El calendario reúne, en una sola vista, todas las fechas relevantes del estudiante. Clases, exámenes y entregas aparecen diferenciadas por tipo y color. Así el estudiante planifica su trabajo y no pierde de vista ningún compromiso.",
      "/app/student/calendar", "Calendario", "Tus fechas en un vistazo.", "Tu calendario", "Clases, exámenes y entregas.", 1.1),
    outro("Cuenta y Sesión", "En el último módulo del rol Estudiante: tu cuenta y la sesión."),
  ]),
  mk("modulo-s13", "Cuenta y Sesión (Estudiante)", "/app", ['[data-tour-id="role-switcher"]', '[data-tour-nav="/app/student/exams"]'], [
    intro("Cuenta y Sesión", "Último módulo del rol Estudiante: tu cuenta y la sesión."),
    { id: "cuenta", kind: "platform", narration: "Al pie del menú vive tu cuenta. El selector de rol cambia entre tus perfiles disponibles. La campana muestra las notificaciones; el sobre, los mensajes con tus docentes. Y al cerrar sesión, el contexto de la institución se limpia por completo.", bufferMs: 900, beats: [
      { target: '[data-tour-id="role-switcher"]', scale: 1.7, hold: 4800, side: "right", focus: { title: "Selector de rol", body: "Cambia entre tus perfiles disponibles." } },
      { target: '[data-tour-id="notifications-bell"]', scale: 1.9, hold: 4000, side: "right", focus: { title: "Notificaciones", body: "Avisos de tus cursos y entregas." } },
      { target: '[data-tour-id="messages-bell"]', scale: 1.9, hold: 4000, side: "right", focus: { title: "Mensajes", body: "Comunicación con tus docentes." } },
      { target: '[data-tour-id="logout"]', scale: 1.9, hold: 4500, side: "right", focus: { title: "Cerrar sesión", body: "Limpia por completo el contexto de la institución." } },
    ]},
    { id: "outro", kind: "card", narration: "Con esto concluye el recorrido del rol Estudiante en ExamLab.", card: card("ExamLab · Serie de demostración", "Fin del recorrido", "Rol Estudiante · Demo Global Corp"), bufferMs: 800 },
  ]),
];

// Nombre de archivo con prefijo "module-" (convención del driver); id interno "modulo-".
for (const s of specs) writeFileSync(`${DIR}/${s.id.replace("modulo-", "module-")}.json`, JSON.stringify(s, null, 2) + "\n");
console.log(`Escritos ${specs.length} specs:`, specs.map((s) => s.id.replace("modulo-", "")).join(", "));
