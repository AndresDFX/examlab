/**
 * Configuración del tour guiado de bienvenida por rol.
 *
 * Cada paso tiene un selector CSS que ancla el popover a un elemento
 * real de la UI (típicamente un ítem del sidebar). El componente
 * `OnboardingTour` los recorre en orden con driver.js.
 *
 * Convenciones:
 *   - Los selectores usan `data-tour-nav="<ruta>"` para items del sidebar,
 *     o `data-tour-id="<nombre>"` para elementos específicos (brand,
 *     selector de rol, footer).
 *   - El campo `description` admite HTML (driver.js lo inserta vía
 *     `innerHTML`). Lo aprovechamos para listas ordenadas "Cómo crear X"
 *     en los módulos donde hace falta detalle pedagógico.
 *   - Cada description queda bajo ~350 caracteres en texto plano —
 *     popups más largos cansan; si hace falta más, se enlaza al módulo
 *     y el docente explora desde ahí.
 *   - SuperAdmin NO tiene tour propio (operación cross-tenant, ya conoce
 *     la plataforma). Si entra con rol activo SuperAdmin, no se dispara.
 *
 * Pasos de creación: marcamos con <ol> los flujos críticos:
 *   - Admin: crear curso, crear usuarios (single + import CSV).
 *   - Docente: crear examen, taller, proyecto, sesión, pizarra,
 *     encuesta y snippet de código en sesión.
 *   - Estudiante: entregar examen, entregar taller/proyecto, check-in
 *     de asistencia y responder encuesta.
 */

export interface TourStep {
  /** Selector CSS del elemento a anclar. Si el elemento no existe en
   *  el DOM, driver.js avanza al siguiente paso silenciosamente. */
  element: string;
  /** Título del popover (3-6 palabras). */
  title: string;
  /** Descripción. Admite HTML simple (<strong>, <em>, <ol>, <ul>, <li>,
   *  <code>). Mantener bajo ~350 chars en texto plano. */
  description: string;
  /** Posición del popover. Auto-detecta si no se especifica.
   *  Para items del sidebar conviene 'right' (sidebar es izquierdo).
   *  Para items del footer del sidebar, 'right' también. */
  side?: "top" | "right" | "bottom" | "left" | "over";
  /** Alineación dentro del lado: 'start' | 'center' | 'end'. */
  align?: "start" | "center" | "end";
}

// ──────────────────────────────────────────────────────────────────────
// ADMIN — tour completo. Cubre la operación cross-curso del Admin de
// la institución: gestión de usuarios, cursos, contenidos y la
// configuración global de la plataforma (prompts, cola IA, branding).
// ──────────────────────────────────────────────────────────────────────
export const ADMIN_TOUR: TourStep[] = [
  // ─── Header del sidebar ─────────────────────────────────────────────
  {
    element: '[data-tour-id="brand"]',
    title: "Bienvenido a ExamLab",
    description:
      "Acá ves el nombre de tu institución. Cada institución gestiona su propio universo de usuarios, cursos y configuración — sin mezclarse con otras.",
    side: "right",
    align: "start",
  },
  {
    element: '[data-tour-id="role-switcher"]',
    title: "Selector de rol",
    description:
      "Si tenés más de un rol (ej. Admin + Docente), lo cambiás acá. Como <strong>Administrador</strong> tenés control total de la institución.",
    side: "right",
    align: "start",
  },

  // ─── Dashboard ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app"]',
    title: "Dashboard",
    description:
      "Tu vista general: stats de cursos, usuarios y entregas; cursos recientes; actividad del sistema. Es el primer lugar al que conviene volver cada mañana.",
    side: "right",
  },

  // ─── Cursos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/courses"]',
    title: "Cursos",
    description:
      "<p>Creá y administrás los cursos de tu institución.</p><strong>Para crear uno:</strong><ol><li>Click <em>Nuevo curso</em> arriba a la derecha.</li><li>Nombre, periodo, idioma y ciclo lectivo.</li><li>Asigná docente(s) principal(es).</li><li>Definí los <em>cortes</em> (1er parcial, 2do, etc.) con sus pesos.</li><li>Matriculá estudiantes uno por uno o por CSV.</li></ol>",
    side: "right",
  },

  // ─── Académico ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/academic"]',
    title: "Académico",
    description:
      "Plan de estudios institucional: <strong>programas</strong> (Ingeniería, Diseño...), <strong>periodos académicos</strong> (2026-I) y <strong>asignaturas</strong>. Lo configurás una vez por año y se reutiliza al crear cursos.",
    side: "right",
  },

  // ─── Contenidos ─────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/contents"]',
    title: "Contenidos",
    description:
      "Biblioteca de material de estudio (PPTX, MD, PDF). Los docentes lo crean para sus cursos y desde acá podés revisar todo lo que produce la institución. Incluye generación con IA a partir de un syllabus.",
    side: "right",
  },

  // ─── Videos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/videos"]',
    title: "Biblioteca de videos",
    description:
      "Registro centralizado de URLs (YouTube/Vimeo) y archivos MP4 subidos. Los proyectos, talleres y módulos los referencian por ID — un solo lugar de verdad.",
    side: "right",
  },

  // ─── Prompts IA ─────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/ai-prompts"]',
    title: "Prompts IA",
    description:
      "Personalizá los <em>system prompts</em> que la IA usa al calificar entregas (taller, examen, proyecto, archivo de código, pregunta abierta). El override aplica a TODA la institución; los docentes pueden override por curso.",
    side: "right",
  },

  // ─── Cola / Cron ────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/ai-cron"]',
    title: "Cola de IA + Cron",
    description:
      "Cola de calificaciones con IA, cola de generaciones con IA y <strong>jobs de pg_cron</strong>. Reintentá fallos, procesá manualmente, pausá schedules. Útil para diagnosticar latencias o errores transitorios.",
    side: "right",
  },

  // ─── Estadísticas ───────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/statistics"]',
    title: "Estadísticas",
    description:
      "Métricas agregadas de la institución: cursos activos, rendimiento promedio, distribución de notas y uso de la IA. Para presentar a directivos o detectar cursos en riesgo.",
    side: "right",
  },

  // ─── Certificados ───────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/certificates"]',
    title: "Certificados",
    description:
      "Plantillas y emisiones de certificados de finalización. Definís el diseño una vez (logo, firma, texto) y se aplica a los alumnos que aprueben el curso.",
    side: "right",
  },

  // ─── Informes ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/report-templates"]',
    title: "Informes",
    description:
      "Plantillas para generar actas, boletines y reportes en PDF. Cada plantilla define columnas, agrupaciones y filtros — los docentes la usan desde su pestaña Informes.",
    side: "right",
  },

  // ─── Usuarios ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/users"]',
    title: "Usuarios",
    description:
      "<p>Creá y gestionás los usuarios de la institución.</p><strong>Para crear uno solo:</strong><ol><li>Click <em>Nuevo usuario</em>.</li><li>Email, nombre, rol(es).</li><li>Contraseña temporal (el usuario la cambia en su primer login).</li></ol><strong>Para crear muchos:</strong> usá el botón <em>Importar CSV</em> con la plantilla descargable.",
    side: "right",
  },

  // ─── Errores ────────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/errors"]',
    title: "Errores",
    description:
      "Eventos de error reportados desde el navegador del usuario. Útil para diagnosticar bugs que los docentes no reportan explícito. Estados: nuevo, en revisión, resuelto, ignorado.",
    side: "right",
  },

  // ─── Auditoría ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/audit-logs"]',
    title: "Auditoría",
    description:
      "Historial completo de acciones del sistema: quién, qué, cuándo. Filtrá por entidad (examen, usuario, curso), por severidad o por categoría. Esencial para soporte y cumplimiento.",
    side: "right",
  },

  // ─── Papelera (NUEVO) ───────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/trash"]',
    title: "Papelera",
    description:
      "Lo que vos o tus docentes <em>borran</em> queda acá <strong>30 días</strong> antes de purgarse para siempre. Cualquier item de cursos, exámenes, talleres, proyectos, sesiones, pizarras, contenidos o encuestas se puede <strong>Restaurar</strong> o <strong>Eliminar definitivo</strong> uno por uno o en bulk.",
    side: "right",
  },

  // ─── Configuración ──────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/settings"]',
    title: "Configuración",
    description:
      "Ajustes de la institución: cuotas de IA, branding (logo, colores), dominio de email, integraciones, visibilidad de módulos por rol. Cambios aplican al instante.",
    side: "right",
  },

  // ─── Footer del sidebar ──────────────────────────────────────────────
  {
    element: '[data-tour-id="user-info"]',
    title: "Tu cuenta",
    description:
      "Tu identidad dentro de la plataforma. El menú de tres puntos (a la derecha) tiene editar perfil, cambiar contraseña, preferencias y este tour.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="notifications-bell"]',
    title: "Notificaciones",
    description:
      "Avisos del sistema y de tus usuarios. El badge rojo indica cuántas no leídas tenés. Click para abrir el popover con la lista.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="messages-bell"]',
    title: "Mensajes",
    description:
      "Mensajería interna 1-a-1 con docentes, estudiantes y otros administradores. También se usa para difusiones masivas a un curso.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="more-options"]',
    title: "Más opciones",
    description:
      "Editar perfil, cambiar contraseña, preferencias de notificación, tema claro/oscuro, idioma. Y desde acá podés <strong>volver a ver este tour</strong> cuando quieras.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="logout"]',
    title: "Cerrar sesión",
    description:
      "Cuando termines, cerrá sesión desde acá. ¡Listo! Si volvés a necesitar el tour, está en el menú de Más opciones.",
    side: "right",
    align: "end",
  },
];

// ──────────────────────────────────────────────────────────────────────
// DOCENTE — tour completo. Cubre el flujo diario del docente: crear
// material (examen, taller, proyecto, contenido, sesiones), revisar
// entregas, comunicarse con alumnos y gestionar pizarras/encuestas.
// ──────────────────────────────────────────────────────────────────────
export const TEACHER_TOUR: TourStep[] = [
  // ─── Header ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-id="brand"]',
    title: "Bienvenido a ExamLab",
    description:
      "Tu institución educativa. Acá vas a crear y gestionar todo lo de tus cursos: exámenes, talleres, proyectos, asistencia, calificaciones y comunicación con los alumnos.",
    side: "right",
    align: "start",
  },
  {
    element: '[data-tour-id="role-switcher"]',
    title: "Selector de rol",
    description:
      "Si tenés más de un rol (ej. Docente + Admin), lo cambiás acá. El menú del sidebar se adapta al rol activo.",
    side: "right",
    align: "start",
  },

  // ─── Dashboard ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app"]',
    title: "Dashboard",
    description:
      "Vista general de tu día: notas pendientes de calificar, sesiones de hoy, próximos exámenes, conversaciones sin responder. El punto de partida cada vez que entrás.",
    side: "right",
  },

  // ─── Cursos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/courses"]',
    title: "Mis cursos",
    description:
      "Los cursos que dictás. Desde acá entrás a su tablero (asistencia, contenidos, gradebook) y a las listas de exámenes/talleres/proyectos del curso.",
    side: "right",
  },

  // ─── Contenidos ─────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/contents"]',
    title: "Contenidos",
    description:
      "<p>Material de estudio para tus alumnos (PPTX, MD, PDF).</p><strong>Para crear uno:</strong><ol><li>Click <em>Generar con IA</em> (a partir de un syllabus) o <em>Subir</em> archivos propios.</li><li>Asocialo al curso.</li><li>Asignalo a una sesión (opcional) — el alumno lo verá en el día de esa clase.</li></ol>",
    side: "right",
  },

  // ─── Banco de preguntas ─────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/question-bank"]',
    title: "Banco de preguntas",
    description:
      "<p>Preguntas reutilizables del curso. Al crear un examen/taller/proyecto las importás del banco en lugar de re-escribir.</p><strong>Para añadir:</strong><ol><li>Click <em>Nueva pregunta</em>.</li><li>Tipo (selección, código, abierta, java_gui, python_gui...).</li><li>Enunciado + rúbrica.</li><li>Generación con IA disponible — pasale el tópico.</li></ol>",
    side: "right",
  },

  // ─── Exámenes ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/exams"]',
    title: "Exámenes",
    description:
      "<strong>Para crear un examen:</strong><ol><li>Click <em>Nuevo examen</em>.</li><li>Curso, corte, ventana de fechas, duración.</li><li>Tipo: <em>normal</em> o <em>externo</em> (ya pasó offline).</li><li>Añadí preguntas — manualmente o importando del banco.</li><li>Configurá proctoring (anti-copia, fullscreen, navegación secuencial).</li></ol>",
    side: "right",
  },

  // ─── Talleres ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/workshops"]',
    title: "Talleres",
    description:
      "<strong>Para crear un taller:</strong><ol><li>Click <em>Nuevo taller</em>.</li><li>Curso, corte, fecha límite.</li><li>Activá <em>trabajo en grupo</em> si querés que entreguen de a varios.</li><li>Añadí preguntas (código, código ZIP, abierta, diagrama...).</li></ol> La IA califica las entregas automáticamente.",
    side: "right",
  },

  // ─── Proyectos ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/projects"]',
    title: "Proyectos",
    description:
      "<strong>Para crear un proyecto:</strong><ol><li>Click <em>Nuevo proyecto</em>.</li><li>Curso, corte, fecha límite, link al repo obligatorio.</li><li>Definí los <em>archivos esperados</em> (1 a N): un README, un diagrama, un ZIP de código...</li></ol> Después de entregar, el alumno sustenta y vos pones el <strong>factor</strong> (0–1) que multiplica su nota.",
    side: "right",
  },

  // ─── Calificaciones (gradebook) ─────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/gradebook"]',
    title: "Calificaciones",
    description:
      "Gradebook consolidado por curso. Notas de exámenes + talleres + proyectos + asistencia, agrupadas por corte. Editás notas externas (presencial) y exportás CSV para llevar al sistema institucional.",
    side: "right",
  },

  // ─── Asistencia ─────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/attendance"]',
    title: "Asistencia",
    description:
      "<strong>Para crear sesiones:</strong><ol><li><em>Nueva sesión</em>: una sola con fecha, hora, duración.</li><li><em>Programar sesiones</em>: N sesiones desde fecha de inicio + días de la semana.</li><li><em>Importar CSV</em>: cuando el cronograma ya existe en una planilla.</li></ol> En cada sesión podés activar <strong>check-in con QR rotativo</strong>, abrir la <strong>pizarra</strong>, crear <strong>snippets de código</strong>, lanzar <strong>encuestas</strong> en vivo.",
    side: "right",
  },

  // ─── Pizarras ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/whiteboards"]',
    title: "Pizarras",
    description:
      "<p>Pizarras Excalidraw standalone (no atadas a una sesión).</p><strong>Para crear una:</strong><ol><li>Click <em>Nueva pizarra</em>.</li><li>Nombre y curso (opcional).</li><li>Activá <em>compartida con el curso</em> para que los alumnos la vean.</li></ol> Soporta <strong>multi-hoja</strong> (dibujo o texto), librerías pre-cargadas (flowchart, UML, estructuras de datos) y modo fullscreen.",
    side: "right",
  },

  // ─── Encuestas ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/polls"]',
    title: "Encuestas",
    description:
      "<strong>Para crear una encuesta:</strong><ol><li>Click <em>Nueva encuesta</em>.</li><li>Curso(s) + sesión asociada (opcional).</li><li>Tipo: <em>opción única</em>, <em>múltiple</em> o <em>cupo por opción (Doodle)</em>.</li><li>En tipo cupo: generador automático de slots de tiempo a partir de fechas + ventana horaria. El cupo se auto-calcula para que todos quepan.</li></ol>",
    side: "right",
  },

  // ─── Calendario ─────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/calendar"]',
    title: "Calendario",
    description:
      "Vista de calendario con sesiones, fechas de exámenes/talleres/proyectos. Sincronizable a Google Calendar y exportable a .ics. El <strong>foro</strong> del curso vive dentro de cada curso, no como módulo aparte.",
    side: "right",
  },

  // ─── Estadísticas ───────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/statistics"]',
    title: "Estadísticas",
    description:
      "Métricas por curso: rendimiento promedio, distribución de notas, asistencia, uso de la IA. Útil para detectar alumnos en riesgo antes del cierre del corte.",
    side: "right",
  },

  // ─── Prompts IA ─────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/ai-prompts"]',
    title: "Prompts IA",
    description:
      "Personalizá los prompts que la IA usa al calificar TUS entregas. Override por curso del default que define el Admin. Útil cuando necesitás criterios específicos por materia.",
    side: "right",
  },

  // ─── Videos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/videos"]',
    title: "Biblioteca de videos",
    description:
      "Registro central de URLs (YouTube/Vimeo) y MP4 subidos. Los proyectos y talleres los referencian por ID — agregá una vez, reutilizá en muchos cursos.",
    side: "right",
  },

  // ─── Certificados ───────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/certificates"]',
    title: "Certificados",
    description:
      "Certificados emitidos a tus alumnos al aprobar el curso. El Admin define la plantilla; vos verificás la lista de emisiones y reenvíos.",
    side: "right",
  },

  // ─── Cola IA ────────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/ai-cron"]',
    title: "Cola IA",
    description:
      "Cola de calificaciones con IA + generaciones. Reintentá fallos, mirá el estado y los logs. Útil cuando una entrega quedó en <em>pendiente</em> por más de unos minutos.",
    side: "right",
  },

  // ─── Reportes ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/reports"]',
    title: "Informes",
    description:
      "Generá actas, boletines y reportes en PDF a partir de las plantillas que define el Admin. Filtrás por curso, corte y periodo.",
    side: "right",
  },

  // ─── Estudiantes (docente) ──────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/students"]',
    title: "Mis estudiantes",
    description:
      "Listado de tus estudiantes con su rendimiento. Opción <em>Ver como</em> para entrar a la vista del alumno (impersonación acotada) y verificar qué le aparece exactamente.",
    side: "right",
  },

  // ─── Auditoría ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/teacher/audit-logs"]',
    title: "Auditoría",
    description:
      "Historial de acciones en TUS cursos: qué se creó, qué se entregó, qué calificó la IA. Útil para responder reclamos de alumnos o investigar incidencias.",
    side: "right",
  },

  // ─── Papelera (NUEVO) ───────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/trash"]',
    title: "Papelera",
    description:
      "Lo que <em>borrás</em> queda acá <strong>30 días</strong>. Cualquier item de cursos, exámenes, talleres, proyectos, sesiones, pizarras, contenidos o encuestas se puede <strong>Restaurar</strong> uno por uno o en bulk. Si lo borraste por error, ¡siempre podés recuperarlo!",
    side: "right",
  },

  // ─── Footer del sidebar ──────────────────────────────────────────────
  {
    element: '[data-tour-id="user-info"]',
    title: "Tu cuenta",
    description:
      "Tu identidad. Desde el menú de tres puntos podés editar perfil, cambiar contraseña, preferencias de notificación y volver a ver este tour.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="notifications-bell"]',
    title: "Notificaciones",
    description:
      "Avisos: entregas pendientes de calificar, mensajes nuevos, foros con respuestas. El badge rojo indica cuántas no leídas tenés.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="messages-bell"]',
    title: "Mensajes",
    description:
      "Chat 1-a-1 con alumnos y otros docentes. También <em>difundís</em> mensajes a uno o varios cursos (con etiquetas para vincular contenido relevante).",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="more-options"]',
    title: "Más opciones",
    description:
      "Perfil, contraseña, preferencias, tema e idioma. Y desde acá podés <strong>volver a ver este tour</strong> cuando quieras.",
    side: "right",
    align: "end",
  },
];

// ──────────────────────────────────────────────────────────────────────
// ESTUDIANTE — tour breve. Cubre el flujo de uso: ver cursos, entregar
// trabajos, ver notas, marcar asistencia y comunicarse.
// ──────────────────────────────────────────────────────────────────────
export const STUDENT_TOUR: TourStep[] = [
  {
    element: '[data-tour-id="brand"]',
    title: "Bienvenido a ExamLab",
    description:
      "Acá ves el nombre de tu institución. Desde el sidebar accedés a tus cursos, exámenes, talleres y todo lo que el docente publique.",
    side: "right",
    align: "start",
  },

  // ─── Dashboard ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app"]',
    title: "Dashboard",
    description:
      "Tu inicio: exámenes pendientes, talleres por entregar, próximas clases. Si algo está por vencer, lo ves acá primero.",
    side: "right",
  },

  // ─── Cursos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/courses"]',
    title: "Mis cursos",
    description:
      "Los cursos donde estás matriculado. Click en uno abre su tablero: contenidos por sesión, asistencia, calificaciones, foro.",
    side: "right",
  },

  // ─── Exámenes ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/exams"]',
    title: "Exámenes",
    description:
      "<strong>Para entregar un examen:</strong><ol><li>Esperá la ventana de tiempo definida por el docente.</li><li>Click <em>Comenzar</em>.</li><li>Respondé las preguntas (modo proctoring si el docente lo activó: pantalla completa, no copia/pega).</li><li>Click <em>Entregar</em>.</li></ol> La IA califica las preguntas abiertas y de código automáticamente.",
    side: "right",
  },

  // ─── Talleres ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/workshops"]',
    title: "Talleres",
    description:
      "<strong>Para entregar un taller:</strong><ol><li>Abrí el taller pendiente.</li><li>Respondé cada pregunta (código, abierta, diagrama, ZIP de archivos...).</li><li>Click <em>Entregar</em> antes de la fecha límite.</li></ol> Si el taller es en <em>grupo</em>, cualquier miembro puede editar la misma entrega.",
    side: "right",
  },

  // ─── Proyectos ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/projects"]',
    title: "Proyectos",
    description:
      "<strong>Para entregar un proyecto:</strong><ol><li>Subí los archivos esperados (README, diagrama, ZIP de código).</li><li>Pegá el link a tu repo (Git, Drive...).</li><li>Click <em>Entregar</em>.</li><li>La nota final llega <em>después</em> de tu sustentación con el docente.</li></ol>",
    side: "right",
  },

  // ─── Calificaciones ─────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/grades"]',
    title: "Calificaciones",
    description:
      "Tu boletín: notas por corte y curso. Click en cada nota muestra el desglose (qué examen, qué taller, peso de cada uno). Si algo falta, aparece como <em>—</em>.",
    side: "right",
  },

  // ─── Asistencia ─────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/attendance"]',
    title: "Asistencia",
    description:
      "Tu historial de asistencia por curso.<br><strong>Para hacer check-in en vivo:</strong> cuando el docente abra el QR, click <em>Escanear QR</em> con tu cámara o tipeá el código de 6 dígitos. También verás los <em>snippets de código</em> y <em>pizarras compartidas</em> de cada sesión.",
    side: "right",
  },

  // ─── Encuestas ──────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/polls"]',
    title: "Encuestas",
    description:
      "Encuestas del docente: opción única, múltiple o por cupo (estilo Doodle para elegir fecha de sustentación). Tu voto queda registrado y, si el docente lo permite, podés cambiarlo.",
    side: "right",
  },

  // ─── Pizarras compartidas ───────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/whiteboards"]',
    title: "Pizarras compartidas",
    description:
      "Las pizarras que tu docente comparte con el curso. Read-only — podés ver los diagramas que él explicó en clase y volver a consultarlos cuando estudies.",
    side: "right",
  },

  // ─── Calendario ─────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/calendar"]',
    title: "Calendario",
    description:
      "Tu calendario unificado: clases, fechas de exámenes/talleres/proyectos. Exportable a Google Calendar (.ics) — instalá la suscripción y se sincroniza solo.",
    side: "right",
  },

  // ─── Certificados ───────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/certificates"]',
    title: "Certificados",
    description:
      "Cuando apruebes un curso, su certificado aparece acá. Descargable en PDF, con código de verificación pública. Los <strong>foros</strong> de cada curso viven dentro del curso, no como módulo aparte.",
    side: "right",
  },

  // ─── Tutor IA ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/student/tutor"]',
    title: "Tutor IA",
    description:
      "Chat con un asistente que conoce tus materiales del curso. Pedile que te explique un concepto, te ejemplifique un caso o te ayude a resolver un ejercicio.",
    side: "right",
  },

  // ─── Footer del sidebar ──────────────────────────────────────────────
  {
    element: '[data-tour-id="messages-bell"]',
    title: "Mensajes",
    description:
      "Chat con tus docentes y otros estudiantes. Acá llegan también los avisos masivos (📢) del docente.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="notifications-bell"]',
    title: "Notificaciones",
    description:
      "Avisos: tu examen fue calificado, hay una encuesta nueva, un foro tiene respuestas. El badge rojo indica cuántas no leídas tenés.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="more-options"]',
    title: "Más opciones",
    description:
      "Editá tu perfil, cambiá tu contraseña, ajustá preferencias de notificación o el idioma. Y desde acá podés <strong>volver a ver este tour</strong>.",
    side: "right",
    align: "end",
  },
];

export function getTourForRole(role: "Admin" | "Docente" | "Estudiante"): TourStep[] {
  switch (role) {
    case "Admin":
      return ADMIN_TOUR;
    case "Docente":
      return TEACHER_TOUR;
    case "Estudiante":
      return STUDENT_TOUR;
    default:
      return [];
  }
}
