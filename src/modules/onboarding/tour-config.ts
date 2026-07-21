/**
 * Configuración del tour guiado de bienvenida por rol.
 *
 * Cada paso tiene un selector CSS que ancla el popover a un elemento
 * real de la UI (típicamente un ítem del sidebar). El componente
 * `OnboardingTour` los recorre en orden con driver.js.
 *
 * Convenciones:
 *   - Los selectores para items del sidebar usan **`data-tour-module="<key>"`**
 *     (preferido) — matchea por `module_key` estable. Sobrevive a:
 *       - Renombres de path (ej. `/app/admin/ai-cron` → `/app/admin/cron`).
 *       - Renombres de labels visibles (es ↔ en).
 *       - Reordenamiento del sidebar por `display_order`.
 *     Los module keys los define `NAV_PATH_TO_MODULE` en AppLayout.tsx
 *     y los expone via `data-tour-module={moduleForNav(item.to)}`.
 *   - Para items SIN module_key (ej. `/app/admin/users`, `/app/admin/errors`,
 *     `/app/admin/settings`) caemos a `data-tour-nav="<ruta>"`. Es el
 *     fallback histórico — funcionando pero no resiliente a renombres.
 *   - `data-tour-id="<nombre>"` para elementos específicos no-nav (brand,
 *     selector de rol, footer, botones "Nuevo X").
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
  /** Si está presente, el tour navega a esa ruta ANTES de intentar
   *  mostrar el step. Útil para los flujos "cómo crear X": el step de
   *  Exámenes navega a `/app/teacher/exams`, después highlight el
   *  botón "Nuevo examen". */
  route?: string;
  /** Si está presente, hace click programático en este selector ANTES
   *  de intentar mostrar el step (después del route si ambos están).
   *  Útil para abrir dialogs y luego highlight de sus fields. */
  clickBefore?: string;
  /** Si true, dispara Esc keydown ANTES de las otras acciones — cierra
   *  cualquier Dialog/Popover abierto. Útil al pasar de un flujo de
   *  creación al siguiente (el dialog del paso anterior queda abierto). */
  escapeBefore?: boolean;
  /** Cuántos ms esperar el `element` en el DOM después de las acciones
   *  (route + clickBefore). Default 3000ms. Subilo para módulos
   *  lentos (ej. dashboards con muchas queries). */
  waitMs?: number;
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
    element: '[data-tour-module="dashboard"]',
    route: "/app",
    title: "Dashboard",
    description:
      "Tu vista general: stats de cursos, usuarios y entregas; cursos recientes; actividad del sistema. Es el primer lugar al que conviene volver cada mañana.",
    side: "right",
  },

  // ─── Cursos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-module="courses"]',
    route: "/app/admin/courses",
    title: "Cursos",
    description:
      "Acá <strong>creás y administrás los cursos</strong> de tu institución. Cada curso vive su propia vida: tiene docentes, cortes con pesos, estudiantes matriculados y todo el contenido pedagógico adentro.",
    side: "right",
  },
  // ─── Demo INTERACTIVA del modal "Nuevo curso" ───────────────────────
  // 5 sub-steps: intro + nombre + periodo + asignatura + fechas + cortes.
  {
    element: '[data-tour-id="dialog-course"]',
    clickBefore: '[data-tour-id="create-course"]',
    waitMs: 400,
    title: "Crear un curso",
    description:
      "Te muestro los <strong>campos clave</strong> del formulario en los próximos pasos. Avanzá con <em>Siguiente</em>.",
    side: "left",
    align: "center",
  },
  {
    element: '[data-tour-id="course-field-name"]',
    title: "Nombre",
    description:
      "El nombre del curso como lo verán los alumnos. Sé específico — incluye periodo si vas a tener varios grupos: <em>“Cálculo II — Grupo A”</em>.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="course-field-period"]',
    title: "Periodo académico",
    description:
      "El periodo al que pertenece este curso (ej. 2026-1). Si tu institución gestiona periodos centralmente, elegís del dropdown — el código se sincroniza automáticamente.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="course-field-subject"]',
    title: "Asignatura del plan",
    description:
      "La asignatura es la <strong>fuente de verdad</strong> para programa + semestre. Al elegirla, ambos se heredan — no tenés que duplicar la info.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="course-field-dates"]',
    title: "Fechas del curso",
    description:
      "Desde cuándo arranca y cuándo termina. Estas fechas marcan el rango activo del curso — afectan el dashboard del alumno y los certificados.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="course-field-cuts"]',
    title: "Cortes evaluativos",
    description:
      "Definí cuántos cortes tiene (1er parcial, 2do, final). Cada uno suma a la nota final con su peso (ej. 30/30/40). Los pesos por tipo (exámenes/talleres/proyectos) se editan adentro de cada corte.",
    side: "left",
    align: "start",
  },

  // ─── Académico ──────────────────────────────────────────────────────
  {
    element: '[data-tour-module="academic"]',
    route: "/app/admin/academic",
    // Cierra el dialog "Nuevo curso" abierto en el step anterior.
    escapeBefore: true,
    title: "Académico",
    description:
      "Definís de qué se compone tu institución: <strong>programas</strong> (Ingeniería, Diseño…), <strong>periodos</strong> (2026-I, 2026-II) y <strong>asignaturas</strong>. Se configura una vez al año y los docentes reutilizan todo al crear sus cursos.",
    side: "right",
  },

  // ─── Contenidos ─────────────────────────────────────────────────────
  {
    element: '[data-tour-module="contents"]',
    route: "/app/teacher/contents",
    title: "Contenidos",
    description:
      "Todo el <strong>material de estudio</strong> que producen los docentes (presentaciones, guías, ejercicios). Acá podés revisar lo que se está generando con IA y verificar la calidad antes de que llegue a los alumnos.",
    side: "right",
  },

  // ─── Videos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-module="videos"]',
    route: "/app/videos",
    title: "Videos",
    description:
      "Un solo lugar para todos los <strong>videos del curso</strong> (YouTube, Vimeo, MP4 subidos). Los docentes los enlazan a sus talleres y proyectos. Una vez subido, se reutiliza en cuantos cursos quieras.",
    side: "right",
  },

  // ─── Prompts IA ─────────────────────────────────────────────────────
  {
    element: '[data-tour-module="ai_prompts"]',
    route: "/app/admin/ai-prompts",
    title: "Prompts IA",
    description:
      "Acá decidís <strong>cómo califica la IA</strong> en tu institución: el tono, los criterios y qué tan estricta es. Lo definís una vez y aplica a todos los docentes. Cada docente puede ajustarlo para su propio curso.",
    side: "right",
  },

  // ─── Cola / Cron ────────────────────────────────────────────────────
  {
    element: '[data-tour-module="ai_cron"]',
    route: "/app/admin/ai-cron",
    title: "Cola de IA",
    description:
      "Acá ves <strong>todo lo que la IA está haciendo</strong>: qué entregas está calificando, qué materiales está generando y qué se trabó. Si algo falla, lo reintentás con un click. Útil cuando un docente avisa que su nota no llegó.",
    side: "right",
  },

  // ─── Estadísticas ───────────────────────────────────────────────────
  {
    element: '[data-tour-module="statistics"]',
    route: "/app/admin/statistics",
    title: "Estadísticas",
    description:
      "El pulso de la institución de un vistazo: <strong>cuántos cursos están activos</strong>, cómo va el rendimiento general y qué cursos tienen estudiantes en riesgo de perder. Datos listos para mostrarle a tu rector.",
    side: "right",
  },

  // ─── Certificados ───────────────────────────────────────────────────
  {
    element: '[data-tour-module="certificates"]',
    route: "/app/certificates",
    title: "Certificaciones",
    description:
      "Plantillas y emisiones de certificados de finalización. Definís el diseño una vez (logo, firma, texto) y se aplica a los alumnos que aprueben el curso.",
    side: "right",
  },

  // ─── Informes ───────────────────────────────────────────────────────
  {
    element: '[data-tour-module="reports"]',
    route: "/app/admin/report-templates",
    title: "Informes",
    description:
      "Plantillas para generar actas, boletines y reportes en PDF. Cada plantilla define columnas, agrupaciones y filtros — los docentes la usan desde su pestaña Informes.",
    side: "right",
  },

  // ─── Usuarios ───────────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/users"]',
    route: "/app/admin/users",
    title: "Usuarios",
    description:
      "<p>Creá y gestionás los <strong>usuarios</strong> de tu institución: docentes, estudiantes y otros administradores. Asignás roles y los matriculás en cursos. En los próximos pasos te muestro las dos formas de crearlos.",
    side: "right",
  },
  // ─── Demo INTERACTIVA: crear un usuario ─────────────────────────────
  {
    element: '[data-tour-id="dialog-user"]',
    clickBefore: '[data-tour-id="create-user"]',
    waitMs: 400,
    title: "Crear un usuario",
    description:
      "<p>Click en <em>Nuevo usuario</em> abre este modal.</p><ol><li>Email + nombre completo.</li><li>Rol(es): Estudiante, Docente, Admin (o varios).</li><li>Contraseña temporal — el usuario la cambia en su primer login.</li><li>Si es Estudiante, podés asignarle código institucional.</li></ol>",
    side: "left",
    align: "center",
  },
  // ─── Bulk import: CSV ───────────────────────────────────────────────
  {
    element: '[data-tour-id="bulk-import-users"]',
    escapeBefore: true,
    title: "Importar usuarios en lote",
    description:
      "<p>Para crear <strong>muchos usuarios a la vez</strong>:</p><ol><li>Abrí el menú <em>Datos</em>.</li><li>Click <em>Descargar plantilla</em> — bajás un CSV de ejemplo.</li><li>Llenala con los usuarios (email, nombre, rol, código).</li><li>Click <em>Importar desde CSV</em> y subí el archivo.</li></ol><p>Se crea uno cada ~500ms para no saturar la API.</p>",
    side: "bottom",
    align: "end",
  },

  // ─── Auditoría (incluye Errores como tab) ───────────────────────────
  // El módulo de Errores se unificó adentro de Auditoría como tab
  // `?tab=errors`. Si el step de Errores se mantenía aparte, su
  // selector ya no existía en el DOM (filtrado silenciosamente).
  // Ahora un único paso cubre los dos flujos.
  {
    element: '[data-tour-module="audit_logs"]',
    route: "/app/admin/audit-logs",
    title: "Auditoría",
    description:
      "El <strong>quién hizo qué y cuándo</strong> de la plataforma. Te sirve para responder reclamos (“yo nunca recibí esa nota”) y para investigar incidentes. Adentro hay una tab de <strong>Errores</strong> con todo lo que falló — útil para soporte.",
    side: "right",
  },

  // ─── Papelera (NUEVO) ───────────────────────────────────────────────
  {
    element: '[data-tour-module="trash"]',
    route: "/app/trash",
    title: "Papelera",
    description:
      "¿Un docente borró un examen por error? Acá lo recuperás. Todo lo que se elimina (cursos, exámenes, talleres, proyectos…) queda <strong>30 días</strong> antes de borrarse para siempre. Click en <em>Restaurar</em> y vuelve a aparecer como si nada.",
    side: "right",
  },

  // ─── Soporte (NUEVO 2026-06) ────────────────────────────────────────
  // Canal directo Admin → SuperAdmin (PQRS). Solo Admin / SuperAdmin.
  // Docente y Estudiante no tienen el módulo.
  {
    element: '[data-tour-module="support"]',
    route: "/app/admin/support",
    title: "Soporte (PQRS)",
    description:
      "Tu canal directo con el <strong>SuperAdmin</strong> de la plataforma. Abrí un ticket con tu <em>petición, queja, reclamo o sugerencia</em> — podés adjuntar archivos y mantener la conversación dentro del ticket. Recibís notificación cuando te respondan o cambien el estado. Casos típicos: errores de plataforma, solicitudes de cuota, reportes de bugs, dudas operativas.",
    side: "right",
  },

  // ─── Configuración ──────────────────────────────────────────────────
  {
    element: '[data-tour-nav="/app/admin/settings"]',
    route: "/app/admin/settings",
    title: "Configuración",
    description:
      "El panel de control de tu institución: cambiás el <strong>logo y los colores</strong> (branding), ajustás cuántos usuarios pueden tener cada rol, y decidís <strong>qué módulos ve cada uno</strong>. Los cambios se aplican al instante.",
    side: "right",
  },

  // ─── Configuración → Modelo IA (CRÍTICO en primer login) ────────────
  // Cada institución DEBE configurar su propia API key. Sin ella, la
  // calificación con IA, la generación de contenidos y la detección de
  // copia no funcionan. El step abre la tab "Modelo IA" via click y la
  // resalta para que el Admin la encuentre rápido en el primer onboarding.
  {
    element: '[data-tour-id="settings-ai-tab"]',
    route: "/app/admin/settings",
    clickBefore: '[data-tour-id="settings-ai-tab"]',
    title: "Configurá tu API key de IA",
    description:
      "<p><strong>Importante:</strong> tu institución necesita su propia API key para usar la calificación con IA, generación de contenidos y detección de copia.</p><ol><li>Entrá a esta pestaña <em>Modelo IA</em>.</li><li>Elegí proveedor: <em>Google Gemini</em> (recomendado, hay tier gratuito) u <em>OpenAI</em>.</li><li>Pegá la API key generada en tu cuenta del proveedor.</li><li>Guardá.</li></ol><p>El costo se cobra a tu cuenta del proveedor — no a ExamLab. Sin esta key, las funciones de IA no funcionan en tu institución.</p>",
    side: "bottom",
    waitMs: 4000,
  },

  // ─── Configuración → Correos ────────────────────────────────────────
  // Sub-tab "Correos" de Configuración. Tiene el kill switch global +
  // toggles por categoría. Destacamos especialmente el toggle de
  // "Bienvenida" porque es el único que NO viene activado por defecto
  // en algunos flujos (SSO, distribución manual de contraseñas).
  {
    element: '[data-tour-id="settings-email-tab"]',
    route: "/app/admin/settings",
    clickBefore: '[data-tour-id="settings-email-tab"]',
    title: "Configurá los correos",
    description:
      "<p>Tab <em>Correos</em>: prendés / apagás el envío de emails por categoría (calificaciones, mensajes, encuestas...).</p><ol><li><strong>Interruptor global</strong>: lo apagás y NO sale ningún correo (notif in-app sigue).</li><li><strong>Bienvenida</strong>: el correo automático al crear usuarios nuevos. Apágalo si repartís contraseñas a mano o usás SSO.</li></ol>",
    side: "bottom",
    waitMs: 3000,
  },
  {
    element: '[data-tour-id="email-kind-welcome"]',
    route: "/app/admin/settings",
    clickBefore: '[data-tour-id="settings-email-tab"]',
    title: "Bienvenida (nuevos usuarios)",
    description:
      "Este toggle controla el correo de <em>“Define tu contraseña”</em> que se envía al crear un usuario nuevo (form individual o bulk CSV). Apágalo cuando ya entregás las claves por otro canal — evita inundar bandejas con links que nadie usa.",
    side: "left",
    align: "center",
    waitMs: 3000,
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
// DOCENTE — tour INTERACTIVO de "cómo crear X".
//
// A diferencia de un tour pasivo que solo describe los módulos, este
// tour DRIVE-EA la UI: navega a cada módulo, hace click en "Nuevo X",
// abre el dialog de creación, muestra los campos clave, cierra el
// dialog, y pasa al siguiente flujo. El docente sale del tour habiendo
// VISTO concretamente cómo se crea cada entidad — examen, taller,
// proyecto, sesión, encuesta.
//
// Mecánica:
//   - `route`: el tour navega antes de mostrar el step.
//   - `clickBefore`: el tour clickea programáticamente antes del step
//     (típicamente el botón "Nuevo X" para abrir el dialog).
//   - `escapeBefore`: dispara Esc keydown ANTES del step (cierra el
//     dialog del paso anterior).
//   - El OnboardingTour wrapper espera 3s a que cada elemento aparezca
//     antes de avanzar; suficiente para queries lentas + render del dialog.
// ──────────────────────────────────────────────────────────────────────
export const TEACHER_TOUR: TourStep[] = [
  // ─── Bienvenida ─────────────────────────────────────────────────────
  {
    element: '[data-tour-id="brand"]',
    title: "¡Bienvenido a ExamLab!",
    description:
      "Te voy a guiar a través de los flujos principales: cómo crear un <strong>examen</strong>, un <strong>taller</strong>, un <strong>proyecto</strong>, una <strong>sesión</strong> de clase y una <strong>encuesta</strong>. ¡Vamos!",
    side: "right",
    align: "start",
  },

  // ─── Dashboard ──────────────────────────────────────────────────────
  {
    element: '[data-tour-module="dashboard"]',
    route: "/app",
    title: "Dashboard",
    description:
      "Vista general de tu día: notas pendientes de calificar, sesiones de hoy, próximos exámenes, conversaciones sin responder. El punto de partida cada vez que entrás.",
    side: "right",
  },

  // ─── Cursos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-module="courses"]',
    route: "/app/teacher/courses",
    title: "Mis cursos",
    description:
      "Los cursos que dictás. Desde acá entrás a su tablero (asistencia, contenidos, gradebook) y a las listas de exámenes/talleres/proyectos del curso.",
    side: "right",
  },

  // ─── Contenidos ─────────────────────────────────────────────────────
  {
    element: '[data-tour-module="contents"]',
    route: "/app/teacher/contents",
    title: "Contenidos",
    description:
      "<p>Material de estudio para tus alumnos (PPTX, MD, PDF, ZIP).</p><strong>Tenés dos caminos:</strong><ol><li><em>Nuevo contenido</em> → la IA lo genera a partir de un tema + syllabus.</li><li><em>Subir externo</em> → cargás un archivo tuyo (ya hecho) y le ponés la misma metadata pedagógica (tema, modo, tags, idioma) para que se vea junto al resto.</li></ol>",
    side: "right",
  },
  // ─── Demo INTERACTIVA del modal "Subir externo" ─────────────────────
  // El refactor 2026-06 hizo que "Subir externo" pidiera la MISMA
  // metadata pedagógica del flujo IA (tema, modo, tags, idioma, n_classes,
  // release-after-session, instrucciones, autor). Antes era un dropzone
  // pelado. El paso destaca esa nueva flexibilidad para que el docente
  // sepa que su material subido se trata igual que el generado con IA.
  // NOTA: la rama "extender con IA un material subido" está marcada
  // como TODO en el header del dialog — la edge `generate-contents`
  // todavía no soporta `extend=true`. Por ahora solo subida pura.
  {
    element: '[data-tour-id="dialog-upload-external"]',
    clickBefore: '[data-tour-id="upload-external-content"]',
    waitMs: 500,
    title: "Subir contenido externo",
    description:
      "<p>Cargás un archivo ya hecho (PDF / PPTX / DOCX / MD / ZIP) y completás la MISMA metadata que el flujo de IA: tema, modo (curso completo o individual), tags, idioma, instrucciones.</p><p>Así tu material queda con todos los filtros y búsquedas funcionando — sin gastar créditos de IA.</p>",
    side: "left",
    align: "center",
  },

  // ─── Banco de preguntas ─────────────────────────────────────────────
  {
    element: '[data-tour-module="question_bank"]',
    route: "/app/teacher/question-bank",
    title: "Banco de preguntas",
    description:
      "Tu <strong>biblioteca de preguntas reutilizables</strong> por curso. Una vez que armás una buena pregunta, la guardás acá y la importás desde cualquier examen/taller/proyecto en vez de reescribirla.",
    side: "right",
  },
  // ─── Demo INTERACTIVA del modal "Nueva pregunta" ────────────────────
  {
    element: '[data-tour-id="dialog-question"]',
    clickBefore: '[data-tour-id="create-question"]',
    waitMs: 400,
    title: "Crear una pregunta",
    description: "Te muestro los <strong>campos clave</strong>. Avanzá con <em>Siguiente</em>.",
    side: "left",
    align: "center",
  },
  {
    element: '[data-tour-id="question-field-type"]',
    title: "Tipo de pregunta",
    description:
      "Selección única, múltiple, abierta, código (con runner), java_gui, python_gui, diagrama. El tipo determina cómo entrega el alumno y cómo la IA califica.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="question-field-content"]',
    title: "Enunciado",
    description:
      "La pregunta como la verá el alumno. Admite formato markdown (negrita, listas, código). Sé claro y específico — la IA usa esto + la rúbrica para evaluar.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="question-field-rubric"]',
    title: "Rúbrica esperada",
    description:
      "Lo que esperás como respuesta ideal: <strong>la IA califica usando esto</strong>. Definí criterios concretos (no solo “bien explicado”) para que las notas sean consistentes. No aplica para preguntas cerradas.",
    side: "left",
    align: "start",
  },

  // ─── Exámenes ───────────────────────────────────────────────────────
  {
    element: '[data-tour-module="exams"]',
    route: "/app/teacher/exams",
    // Cierra el dialog "Nueva pregunta" abierto en el demo anterior.
    escapeBefore: true,
    title: "Exámenes",
    description:
      "Tus <strong>exámenes</strong>. Cada uno tiene su ventana de tiempo, sus preguntas (selección, abierta, código…) y opcionalmente proctoring para que el alumno no haga trampa.",
    side: "right",
  },
  // ─── Demo INTERACTIVA del modal "Nuevo examen" ──────────────────────
  // 5 sub-steps que recorren los campos clave del modal. clickBefore
  // del primero abre el dialog; los siguientes navegan internamente
  // (mismo dialog ya abierto). El último siguiente step de tour
  // (Talleres) lleva escapeBefore para cerrar el dialog.
  {
    element: '[data-tour-id="dialog-exam"]',
    clickBefore: '[data-tour-id="create-exam"]',
    waitMs: 400,
    title: "Crear un examen",
    description:
      "Te muestro los <strong>campos clave</strong> del formulario en los próximos pasos. Avanzá con <em>Siguiente</em>.",
    side: "left",
    align: "center",
  },
  {
    element: '[data-tour-id="exam-field-external"]',
    title: "Actividad externa (opcional)",
    description:
      "Si el examen ya pasó <strong>fuera de la plataforma</strong> (presencial o en otra herramienta), activá este toggle. Quedan solo los campos para registrar notas y se ocultan duración/proctoring/preguntas.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="exam-field-title"]',
    title: "Título",
    description:
      "El nombre del examen como lo verá el alumno. Sé descriptivo: <em>“Parcial 1 — Recursión y árboles”</em> es mejor que <em>“Parcial 1”</em>.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="exam-field-courses"]',
    title: "Curso(s)",
    description:
      "A qué curso pertenece. Si seleccionás <strong>varios</strong>, el examen se publica idéntico en todos (útil cuando dictás la misma materia a 2 grupos).",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="exam-field-dates"]',
    title: "Ventana de fechas",
    description:
      "Desde cuándo está <strong>disponible</strong> hasta cuándo el alumno puede entregar. La duración (minutos) se auto-calcula al elegir Fin, pero podés ajustarla manualmente. Después del cierre, no se aceptan más intentos.",
    side: "left",
    align: "start",
  },

  // ─── Talleres ───────────────────────────────────────────────────────
  {
    element: '[data-tour-module="workshops"]',
    route: "/app/teacher/workshops",
    escapeBefore: true,
    title: "Talleres",
    description:
      "Los <strong>talleres</strong> son tareas más relajadas que un examen: el alumno tiene días/semanas para entregar, puede ser individual o en grupo. La IA califica las respuestas automáticamente.",
    side: "right",
  },
  // ─── Demo INTERACTIVA del modal "Nuevo taller" ──────────────────────
  {
    element: '[data-tour-id="dialog-workshop"]',
    clickBefore: '[data-tour-id="create-workshop"]',
    waitMs: 400,
    title: "Crear un taller",
    description: "Te muestro los <strong>campos clave</strong>. Avanzá con <em>Siguiente</em>.",
    side: "left",
    align: "center",
  },
  {
    element: '[data-tour-id="workshop-field-external"]',
    title: "Actividad externa (opcional)",
    description:
      "Si el taller pasó <strong>fuera de la plataforma</strong> (presencial), activá el toggle. Solo quedará el campo de notas — sin preguntas ni IA.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="workshop-field-group-mode"]',
    title: "Modo de trabajo",
    description:
      "Individual, grupal (todos en grupo) o mixto (quien tenga grupo entrega en grupo, los demás solos). Los grupos los administrás desde el botón <em>Grupos</em> del grid.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="workshop-field-title"]',
    title: "Título",
    description:
      "Nombre del taller como lo verá el alumno (ej. <em>“Taller 3 — POO en Python”</em>).",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="workshop-field-courses"]',
    title: "Curso(s)",
    description:
      "Curso(s) donde aplica. Podés asociarlo a varios — un solo registro de taller que viven N alumnos de distintos cursos.",
    side: "left",
    align: "start",
  },

  // ─── Proyectos ──────────────────────────────────────────────────────
  {
    element: '[data-tour-module="projects"]',
    route: "/app/teacher/projects",
    escapeBefore: true,
    title: "Proyectos",
    description:
      "Los <strong>proyectos</strong> son entregas finales más grandes. El alumno sube archivos + link al repo, vos lo sustentás en persona y le ponés un factor (0-1) que multiplica la nota.",
    side: "right",
  },
  // ─── Demo INTERACTIVA del modal "Nuevo proyecto" ────────────────────
  {
    element: '[data-tour-id="dialog-project"]',
    clickBefore: '[data-tour-id="create-project"]',
    waitMs: 400,
    title: "Crear un proyecto",
    description: "Te muestro los <strong>campos clave</strong>. Avanzá con <em>Siguiente</em>.",
    side: "left",
    align: "center",
  },
  {
    element: '[data-tour-id="project-field-external"]',
    title: "Actividad externa (opcional)",
    description:
      "Si el proyecto pasó <strong>fuera de la plataforma</strong> (presentación presencial, etc.), activá el toggle. Solo registras notas y observaciones por alumno.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="project-field-group-mode"]',
    title: "Modo de trabajo",
    description:
      "Individual, grupal o mixto. Los proyectos típicamente son grupales — definí grupos desde el botón <em>Grupos</em> del grid antes de la fecha de entrega.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="project-field-title"]',
    title: "Título",
    description:
      "Nombre del proyecto. Sé específico — <em>“Proyecto Final — Sistema de Inventario en Java”</em> es mejor que <em>“Proyecto Final”</em>.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="project-field-description"]',
    title: "Descripción (importante para la IA)",
    description:
      "Esta es la <strong>descripción global del proyecto</strong>. La IA la usa al calificar CADA entrega como contexto — sin esto califica las preguntas aisladas y pierde sentido del conjunto. Definí propósito + alcance + restricciones en 3-6 oraciones.",
    side: "left",
    align: "start",
  },

  // ─── Calificaciones (gradebook) ─────────────────────────────────────
  {
    element: '[data-tour-module="gradebook"]',
    route: "/app/teacher/gradebook",
    // Cierra el dialog "Nuevo proyecto" abierto en el demo anterior.
    escapeBefore: true,
    title: "Calificaciones",
    description:
      "El <strong>boletín consolidado</strong> de cada curso. Ves todas las notas de tus alumnos (exámenes, talleres, proyectos y asistencia) agrupadas por corte. Acá editás notas de actividades que hiciste por fuera (presencial) y bajás un CSV para subir al sistema de la institución.",
    side: "right",
  },

  // ─── Asistencia ─────────────────────────────────────────────────────
  {
    element: '[data-tour-module="attendance"]',
    route: "/app/teacher/attendance",
    title: "Asistencia",
    description:
      "Tu <strong>tablero de asistencia</strong>: una columna por sesión, una fila por alumno. Tenés <strong>3 modos</strong> de crear sesiones: una sola, programar varias automáticas (días de la semana), o importar de CSV. Cada sesión es además el contenedor de pizarra, snippets y encuestas en vivo.",
    side: "right",
  },
  // ─── Dialog "Nueva sesión" — demo interactiva ───────────────────────
  // Mostramos el dialog "Nueva sesión" (la opción más simple). Los
  // otros 2 modos (Programar, Importar CSV) los nombramos en la
  // descripción para no abrir 3 dialogs distintos.
  {
    element: '[data-tour-id="dialog-session"]',
    clickBefore: '[data-tour-id="create-session"]',
    waitMs: 400,
    title: "Crear una sesión",
    description:
      "Una sesión = una clase. Te muestro los campos clave del modal — para crear MUCHAS sesiones a la vez podés usar <em>Programar sesiones</em> o <em>Importar CSV</em> desde el botón al lado.",
    side: "left",
    align: "center",
  },
  {
    element: '[data-tour-id="session-field-date"]',
    title: "Fecha",
    description: "El día de la clase. Usá el calendar picker — respeta zona horaria de Bogotá.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="session-field-time"]',
    title: "Hora inicio + Hora fin",
    description:
      "Ahora marcás <strong>hora de inicio</strong> y <strong>hora de fin</strong> (zona horaria local). La duración se calcula sola y se usa para sincronizar con Google Calendar a la hora real. Si dejás ambas vacías, queda como sesión sin horario fijo.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="session-field-title"]',
    title: "Título (opcional)",
    description:
      "Descripción corta de la clase (ej. <em>“Clase 5 — Recursión”</em>, <em>“Lab 2”</em>). Si lo dejás vacío, aparece como <em>“Clase del DD-MM-YYYY”</em>.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="session-field-cut"]',
    title: "Corte",
    description:
      "A qué corte aporta la asistencia. Si dejás <em>Sin corte</em>, la sesión queda visible pero no cuenta para la nota. Reasignable después desde la columna <em>Corte</em> del tablero.",
    side: "left",
    align: "start",
  },

  // ─── Pizarras ───────────────────────────────────────────────────────
  {
    element: '[data-tour-module="whiteboards"]',
    route: "/app/teacher/whiteboards",
    // Cierra el dialog "Nueva sesión" abierto en el demo anterior.
    escapeBefore: true,
    title: "Pizarras",
    description:
      "Tus <strong>pizarras digitales</strong> (Excalidraw embebido). Las usás para explicar conceptos en clase, dejar diagramas que los alumnos puedan consultar, o trabajar con ellos en tiempo real.",
    side: "right",
  },
  // ─── Demo INTERACTIVA del modal "Nueva pizarra" ─────────────────────
  {
    element: '[data-tour-id="dialog-whiteboard"]',
    clickBefore: '[data-tour-id="create-whiteboard"]',
    waitMs: 400,
    title: "Crear una pizarra",
    description: "Te muestro los <strong>campos clave</strong>. Avanzá con <em>Siguiente</em>.",
    side: "left",
    align: "center",
  },
  {
    element: '[data-tour-id="whiteboard-field-name"]',
    title: "Nombre",
    description:
      "Cómo se va a llamar la pizarra. Sé descriptivo — vas a tener varias por curso (<em>“Clase 3 — Recursión”</em>, <em>“Diagrama BD final”</em>).",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="whiteboard-field-description"]',
    title: "Descripción (opcional)",
    description:
      "Notas internas para vos: contexto, qué temas cubre, etc. Los alumnos NO la ven — es solo para que vos te ubiques cuando tengas muchas.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="whiteboard-field-course"]',
    title: "Curso (opcional)",
    description:
      "Si la asociás a un curso, podés <strong>compartirla con sus alumnos</strong> en modo read-only desde la pizarra. Sin curso, la pizarra es privada — solo vos la ves.",
    side: "left",
    align: "start",
  },

  // ─── Encuestas ──────────────────────────────────────────────────────
  {
    element: '[data-tour-module="polls"]',
    route: "/app/teacher/polls",
    escapeBefore: true,
    title: "Encuestas",
    description:
      "Cuatro tipos en un solo lugar: <strong>opción única</strong> o <strong>múltiple</strong> para votar en clase, <strong>cupo (Doodle)</strong> para coordinar fechas, y <strong>retos en vivo</strong> — un quiz gamificado en tiempo real. Desde el menú de cada fila podés <strong>duplicarla</strong>, <strong>compartir un enlace único</strong> y en <em>Ver resultados</em> ver <strong>qué eligió cada alumno</strong>. Tip: clic en el encabezado de una columna ordena el grid.",
    side: "right",
  },
  // ─── Demo INTERACTIVA del modal "Nueva encuesta" ────────────────────
  {
    element: '[data-tour-id="dialog-poll"]',
    clickBefore: '[data-tour-id="create-poll"]',
    waitMs: 400,
    title: "Crear una encuesta",
    description: "Te muestro los <strong>campos clave</strong>. Avanzá con <em>Siguiente</em>.",
    side: "left",
    align: "center",
  },
  {
    element: '[data-tour-id="poll-field-title"]',
    title: "Título",
    description:
      "La pregunta o tema central. Sé directo — <em>“¿Quedó claro el concepto?”</em>, <em>“Elegí tu fecha de sustentación”</em>.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="poll-field-courses"]',
    title: "Curso(s)",
    description:
      "Podés asociar la encuesta a <strong>uno o varios cursos</strong>. Los alumnos matriculados en cualquiera pueden votar. Útil si dictás la misma materia a varios grupos.",
    side: "left",
    align: "start",
  },
  {
    element: '[data-tour-id="poll-field-type"]',
    title: "Tipo de encuesta",
    description:
      "<strong>Opción única</strong> (una respuesta), <strong>múltiple</strong> (varias), <strong>cupo (Doodle)</strong> — cada opción tiene cupo limitado, ideal para repartir slots de sustentación — y <strong>Reto en vivo</strong>, un quiz gamificado en tiempo real (más abajo te muestro cómo funciona).",
    side: "left",
    align: "start",
  },
  // ─── Kahoot: crear quiz + hostear en vivo ───────────────────────────
  // El flujo Kahoot vive en la MISMA pantalla de Encuestas: se crea un
  // poll tipo "kahoot", sus preguntas se editan en un editor aparte
  // (manual o con IA), y se hostea en vivo desde el menú de la fila. Esas
  // acciones del menú NO tienen anchors dedicados, así que el paso se
  // ancla al botón "Nueva encuesta" (selector único, no colisiona con el
  // clickBefore del demo) y explica el flujo completo con <ol>.
  {
    element: '[data-tour-id="create-poll"]',
    route: "/app/teacher/polls",
    escapeBefore: true,
    title: "Reto en vivo: quiz gamificado",
    description:
      "<p>Un reto en vivo es un juego de preguntas en tiempo real:</p><ol><li>Creá una encuesta tipo <em>Reto en vivo</em>.</li><li>En su menú, abrí <em>Preguntas</em> y armá el cuestionario — a mano o <strong>con IA</strong> (única o varias respuestas correctas).</li><li>Click <em>Hospedar en vivo</em>: se genera un <strong>PIN</strong> + <strong>QR</strong> que proyectás.</li><li>Los alumnos entran con el PIN/QR y esperan en la sala.</li><li>Avanzás pregunta por pregunta viendo el puntaje acumulado.</li></ol>",
    side: "bottom",
    align: "end",
  },

  // ─── Calendario ─────────────────────────────────────────────────────
  {
    element: '[data-tour-module="calendar"]',
    route: "/app/teacher/calendar",
    // Cierra el dialog "Nueva encuesta" abierto en el demo anterior.
    escapeBefore: true,
    title: "Calendario",
    description:
      "Vista de calendario con sesiones, fechas de exámenes/talleres/proyectos. Sincronizable a Google Calendar y exportable a .ics. El <strong>foro</strong> del curso vive dentro de cada curso, no como módulo aparte.",
    side: "right",
  },

  // ─── Estadísticas ───────────────────────────────────────────────────
  {
    element: '[data-tour-module="statistics"]',
    route: "/app/teacher/statistics",
    title: "Estadísticas",
    description:
      "El <strong>pulso de cada uno de tus cursos</strong>: cómo va el promedio, qué alumnos están en riesgo de perder, cuántos no entregan. Mejor revisar esto a mitad de corte que enterarte cuando ya es tarde.",
    side: "right",
  },

  // ─── Prompts IA ─────────────────────────────────────────────────────
  {
    element: '[data-tour-module="ai_prompts"]',
    route: "/app/teacher/ai-prompts",
    title: "Prompts IA",
    description:
      "¿No te gusta cómo la IA está calificando? Acá <strong>ajustás el tono y los criterios</strong> para TUS cursos. Por ejemplo: más estricta con la sintaxis en Programación I, más flexible con redacción en Ética. Cada curso puede tener su receta.",
    side: "right",
  },

  // ─── Videos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-module="videos"]',
    route: "/app/videos",
    title: "Videos",
    description:
      "Tu <strong>biblioteca de videos</strong> (YouTube, Vimeo, MP4 propios). Los enlazás en talleres y proyectos como recurso obligatorio o de apoyo. Subís uno y lo reutilizás en todos los cursos donde lo necesites.",
    side: "right",
  },

  // ─── Certificados ───────────────────────────────────────────────────
  {
    element: '[data-tour-module="certificates"]',
    route: "/app/certificates",
    title: "Certificaciones",
    description:
      "Cuando un alumno aprueba el curso, acá podés <strong>ver el certificado emitido</strong> y reenviárselo si lo perdió. El diseño lo define la institución, vos solo confirmás que lleguen.",
    side: "right",
  },

  // ─── Cola IA ────────────────────────────────────────────────────────
  {
    element: '[data-tour-module="ai_cron"]',
    route: "/app/teacher/ai-cron",
    title: "Cola IA",
    description:
      "¿Un alumno pregunta dónde está su nota? Acá ves <strong>qué está calificando la IA</strong> en este momento, qué se terminó y qué se trabó. Si algo falló, lo reintentás con un click — no hace falta llamar a soporte.",
    side: "right",
  },

  // ─── Reportes ───────────────────────────────────────────────────────
  {
    element: '[data-tour-module="reports"]',
    route: "/app/teacher/reports",
    title: "Informes",
    description:
      "Generás <strong>actas, boletines y reportes</strong> en PDF a partir de plantillas pre-armadas. Eligís curso + corte + periodo y descargás. Lo que te ahorra rellenar el formato del consejo académico a mano cada semestre.",
    side: "right",
  },

  // ─── Estudiantes (docente) ──────────────────────────────────────────
  {
    element: '[data-tour-module="teacher_students"]',
    route: "/app/teacher/students",
    title: "Mis estudiantes",
    description:
      "El <strong>directorio de tus alumnos</strong> con su rendimiento de un vistazo. Si querés saber qué ve un alumno exactamente (porque te dice que no le aparece algo), usás <em>Ver como</em> y entrás a su vista por un rato.",
    side: "right",
  },

  // ─── Auditoría ──────────────────────────────────────────────────────
  {
    element: '[data-tour-module="audit_logs"]',
    route: "/app/teacher/audit-logs",
    title: "Auditoría",
    description:
      "El historial de <strong>todo lo que pasó en tus cursos</strong>: qué creaste, qué entregaron tus alumnos, qué calificó la IA y cuándo. Útil cuando un alumno reclama una nota y necesitás reconstruir qué pasó.",
    side: "right",
  },

  // ─── Papelera (NUEVO) ───────────────────────────────────────────────
  {
    element: '[data-tour-module="trash"]',
    route: "/app/trash",
    title: "Papelera",
    description:
      "¿Borraste un examen por error? Acá lo recuperás. Todo lo que eliminás (cursos, exámenes, talleres, proyectos…) queda <strong>30 días</strong> antes de borrarse para siempre. Click en <em>Restaurar</em> y vuelve a aparecer como si nada.",
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
      "Chat 1-a-1 con alumnos y otros docentes. Acá llegan mensajes nuevos. El badge rojo indica cuántas conversaciones no leídas tenés.",
    side: "right",
    align: "end",
  },
  // ─── Difundir a curso (botón header /app/messages) ──────────────────
  {
    element: '[data-tour-id="broadcast-messages"]',
    route: "/app/messages",
    title: "Difundir a curso(s)",
    description:
      "<p>Desde Mensajes podés <strong>enviar un aviso a TODO un curso</strong> (o a varios) de una sola vez.</p><ol><li>Click <em>Enviar a todos los estudiantes</em>.</li><li>Seleccioná uno o varios cursos.</li><li>Escribí asunto + cuerpo. Etiquetá talleres/exámenes con <code>#</code>.</li><li>Enviar ahora o <em>programar</em> para más tarde.</li></ol><p>Cada alumno recibe notif in-app + correo BCC.</p>",
    side: "bottom",
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
    element: '[data-tour-module="dashboard"]',
    route: "/app",
    title: "Dashboard",
    description:
      "Tu inicio: exámenes pendientes, talleres por entregar, próximas clases. Si algo está por vencer, lo ves acá primero.",
    side: "right",
  },

  // ─── Cursos ─────────────────────────────────────────────────────────
  {
    element: '[data-tour-module="courses"]',
    route: "/app/student/courses",
    title: "Mis cursos",
    description:
      "Los cursos donde estás matriculado. Click en uno abre su tablero: contenidos por sesión, asistencia, calificaciones, foro.",
    side: "right",
  },

  // ─── Exámenes ───────────────────────────────────────────────────────
  {
    element: '[data-tour-module="exams"]',
    route: "/app/student/exams",
    title: "Exámenes",
    description:
      "<strong>Para entregar un examen:</strong><ol><li>Esperá la ventana de tiempo definida por el docente.</li><li>Click <em>Comenzar</em>.</li><li>Respondé las preguntas (modo proctoring si el docente lo activó: pantalla completa, no copia/pega).</li><li>Click <em>Entregar</em>.</li></ol> La IA califica las preguntas abiertas y de código automáticamente.",
    side: "right",
  },

  // ─── Talleres ───────────────────────────────────────────────────────
  {
    element: '[data-tour-module="workshops"]',
    route: "/app/student/workshops",
    title: "Talleres",
    description:
      "<strong>Para entregar un taller:</strong><ol><li>Abrí el taller pendiente.</li><li>Respondé cada pregunta (código, abierta, diagrama, ZIP de archivos...).</li><li>Click <em>Entregar</em> antes de la fecha límite.</li></ol> Si el taller es en <em>grupo</em>, cualquier miembro puede editar la misma entrega.",
    side: "right",
  },

  // ─── Proyectos ──────────────────────────────────────────────────────
  {
    element: '[data-tour-module="projects"]',
    route: "/app/student/projects",
    title: "Proyectos",
    description:
      "<strong>Para entregar un proyecto:</strong><ol><li>Subí los archivos esperados (README, diagrama, ZIP de código).</li><li>Pegá el link a tu repo (Git, Drive...).</li><li>Click <em>Entregar</em>.</li><li>La nota final llega <em>después</em> de tu sustentación con el docente.</li></ol>",
    side: "right",
  },

  // ─── Calificaciones ─────────────────────────────────────────────────
  {
    element: '[data-tour-module="grades"]',
    route: "/app/student/grades",
    title: "Calificaciones",
    description:
      "Tu boletín: notas por corte y curso. Click en cada nota muestra el desglose (qué examen, qué taller, peso de cada uno). Si algo falta, aparece como <em>—</em>.",
    side: "right",
  },

  // ─── Asistencia ─────────────────────────────────────────────────────
  {
    element: '[data-tour-module="attendance"]',
    route: "/app/student/attendance",
    title: "Asistencia",
    description:
      "Tu historial de asistencia por curso.<br><strong>Para hacer check-in en vivo:</strong> cuando el docente abra el QR, click <em>Escanear QR</em> con tu cámara o tipeá el código de 6 dígitos. También verás los <em>snippets de código</em> y <em>pizarras compartidas</em> de cada sesión.",
    side: "right",
  },

  // ─── Encuestas ──────────────────────────────────────────────────────
  {
    element: '[data-tour-module="polls"]',
    route: "/app/student/polls",
    title: "Encuestas",
    description:
      "Votás encuestas del docente (única, múltiple o por cupo tipo Doodle). Si lo permite, podés <strong>cambiar</strong> o <strong>quitar</strong> tu respuesta.<br><strong>Para unirte a un reto en vivo:</strong><ol><li>Cuando el docente lo inicie, aparece arriba una tarjeta de juego.</li><li>Escaneá el <strong>QR</strong> o tipeá el <strong>PIN</strong> que él proyecta.</li><li>Esperá en la <em>sala</em> a que arranque.</li><li>Respondé cada pregunta a tiempo — ganás puntos por acertar rápido.</li></ol>",
    side: "right",
  },

  // ─── Pizarras compartidas ───────────────────────────────────────────
  {
    element: '[data-tour-module="whiteboards"]',
    route: "/app/student/whiteboards",
    title: "Pizarras",
    description:
      "Las pizarras que tu docente comparte con el curso. Read-only — podés ver los diagramas que él explicó en clase y volver a consultarlos cuando estudies.",
    side: "right",
  },

  // ─── Calendario ─────────────────────────────────────────────────────
  {
    element: '[data-tour-module="calendar"]',
    route: "/app/student/calendar",
    title: "Calendario",
    description:
      "Tu calendario unificado: clases, fechas de exámenes/talleres/proyectos. Exportable a Google Calendar (.ics) — instalá la suscripción y se sincroniza solo.",
    side: "right",
  },

  // ─── Certificados ───────────────────────────────────────────────────
  {
    element: '[data-tour-module="certificates"]',
    route: "/app/student/certificates",
    title: "Certificaciones",
    description:
      "Cuando apruebes un curso, su certificado aparece acá. Descargable en PDF, con código de verificación pública. Los <strong>foros</strong> de cada curso viven dentro del curso, no como módulo aparte.",
    side: "right",
  },

  // ─── Asistente de IA (plataforma + tutores por curso) ───────────────
  {
    element: '[data-tour-module="tutor"]',
    route: "/app/student/tutor",
    title: "Asistente de IA",
    description:
      "Todo tu apoyo con IA en un solo lugar. Arriba, el <strong>Asistente de la plataforma</strong> (resuelve dudas de cómo usar ExamLab). Debajo, un <strong>tutor por cada curso</strong> que lee los materiales que subió tu docente (guías, presentaciones, lecturas) y responde anclado a su contenido — pedile que te explique un concepto o te guíe en un ejercicio.",
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

// ──────────────────────────────────────────────────────────────────────
// Metadata por tour. Hoy solo guarda la URL del video introductorio
// (producido con HeyGen — ver docs/heygen/<rol>.md + el recorder
// Playwright en scripts/record-tour.ts). Cuando se setea, el primer
// step del tour muestra un botón "Ver video introductorio" que abre
// la URL en pestaña nueva.
//
// Para activar el video:
//   1. Generar el MP4 final con HeyGen (avatar + screencast).
//   2. Hospedar en YouTube unlisted / Vimeo / Cloudflare Stream.
//   3. Pegar la URL acá.
//
// Mientras esté `null`, el botón no aparece (UX limpia).
// ──────────────────────────────────────────────────────────────────────
export interface TourMeta {
  /** URL al video introductorio del rol. Si null, no se muestra el CTA. */
  videoUrl: string | null;
}

export const ADMIN_TOUR_META: TourMeta = {
  videoUrl: null, // TODO: pegar aquí el URL del video HeyGen para Admin.
};

export const TEACHER_TOUR_META: TourMeta = {
  videoUrl: null, // TODO: pegar aquí el URL del video HeyGen para Docente.
};

export const STUDENT_TOUR_META: TourMeta = {
  videoUrl: null, // TODO: pegar aquí el URL del video HeyGen para Estudiante.
};

export function getTourMetaForRole(role: "Admin" | "Docente" | "Estudiante"): TourMeta {
  switch (role) {
    case "Admin":
      return ADMIN_TOUR_META;
    case "Docente":
      return TEACHER_TOUR_META;
    case "Estudiante":
      return STUDENT_TOUR_META;
    default:
      return { videoUrl: null };
  }
}
