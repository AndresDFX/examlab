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
 *   - Los textos son cortos (1-2 frases) — un tour de 20 pasos cansa
 *     rápido, por eso priorizamos brevedad sobre completitud.
 *   - SuperAdmin NO tiene tour (operación cross-tenant, ya conoce la
 *     plataforma). Si alguien con SuperAdmin como rol activo entra,
 *     useOnboarding no dispara nada.
 *
 * Los pasos del Estudiante y Docente se agregan en una próxima iteración
 * — primero validamos UX con Admin.
 */

export interface TourStep {
  /** Selector CSS del elemento a anclar. Si el elemento no existe en
   *  el DOM, driver.js avanza al siguiente paso silenciosamente. */
  element: string;
  /** Título del popover (3-6 palabras). */
  title: string;
  /** Descripción (1-2 frases, máx ~150 caracteres). */
  description: string;
  /** Posición del popover. Auto-detecta si no se especifica.
   *  Para items del sidebar conviene 'right' (sidebar es izquierdo).
   *  Para items del footer del sidebar, 'right' también. */
  side?: "top" | "right" | "bottom" | "left" | "over";
  /** Alineación dentro del lado: 'start' | 'center' | 'end'. */
  align?: "start" | "center" | "end";
}

/**
 * Tour del rol Admin — 20 pasos.
 * Cubre TODOS los módulos del sidebar (14) + brand + role switcher
 * + 4 elementos del footer.
 */
export const ADMIN_TOUR: TourStep[] = [
  // ─── Header del sidebar ─────────────────────────────────────────────
  {
    element: '[data-tour-id="brand"]',
    title: "Bienvenido a ExamLab",
    description:
      "Aquí ves el nombre de tu institución. Cada institución gestiona su propio universo de usuarios, cursos y configuración.",
    side: "right",
    align: "start",
  },
  {
    element: '[data-tour-id="role-switcher"]',
    title: "Selector de rol",
    description:
      "Si tienes más de un rol, lo cambias acá. Como Administrador tienes control total sobre la institución.",
    side: "right",
    align: "start",
  },

  // ─── Módulos del sidebar (orden visual) ──────────────────────────────
  {
    element: '[data-tour-nav="/app"]',
    title: "Dashboard",
    description:
      "Vista general: métricas clave, cursos recientes y actividad del sistema.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/courses"]',
    title: "Cursos",
    description:
      "Crea y administra los cursos. Asigna docentes y matricula estudiantes.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/contents"]',
    title: "Contenidos",
    description:
      "Biblioteca de material de estudio (clases, lecturas, recursos) que los docentes comparten en sus cursos.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/videos"]',
    title: "Videos",
    description:
      "Biblioteca de videos reutilizables. Se referencian desde proyectos, talleres y módulos.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/ai-prompts"]',
    title: "Prompts",
    description:
      "Personaliza los prompts que usa la IA para calificar entregas. Aplica a toda la institución.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/statistics"]',
    title: "Estadísticas",
    description:
      "Métricas agregadas: rendimiento de cursos, exámenes, talleres y entregas.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/academic"]',
    title: "Académico",
    description:
      "Plan de estudios: programas, periodos académicos y asignaturas.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/audit-logs"]',
    title: "Auditoría",
    description:
      "Historial completo de todas las acciones del sistema. Útil para soporte y cumplimiento.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/certificates"]',
    title: "Certificaciones",
    description:
      "Certificados emitidos a estudiantes al completar cursos. Define plantillas y firma institucional.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/ai-cron"]',
    title: "Cola",
    description:
      "Cola de calificación con IA + tareas programadas. Gestiona, reintenta o cancela jobs uno a uno.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/report-templates"]',
    title: "Informes",
    description:
      "Plantillas para generar actas, boletines y reportes en PDF.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/users"]',
    title: "Usuarios",
    description:
      "Crea y gestiona usuarios. Asigna roles, matricula a cursos e importa CSV masivos.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/errors"]',
    title: "Errores",
    description:
      "Eventos de error del sistema reportados por el cliente. Útil para diagnosticar problemas reportados por usuarios.",
    side: "right",
  },
  {
    element: '[data-tour-nav="/app/admin/settings"]',
    title: "Configuración",
    description:
      "Ajustes de la institución: cuotas, branding, dominio de email, configuración de la plataforma.",
    side: "right",
  },

  // ─── Footer del sidebar ──────────────────────────────────────────────
  {
    element: '[data-tour-id="user-info"]',
    title: "Tu cuenta",
    description:
      "Aquí ves tu identidad dentro de la plataforma. Usa el menú de tres puntos para editar tu perfil.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="notifications-bell"]',
    title: "Notificaciones",
    description:
      "Avisos del sistema y de tus usuarios. El número rojo indica cuántas no leídas tienes.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="messages-bell"]',
    title: "Mensajes",
    description:
      "Mensajería interna con docentes, estudiantes y otros administradores.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="more-options"]',
    title: "Más opciones",
    description:
      "Editar perfil, cambiar contraseña, preferencias de notificación, tema claro/oscuro e idioma. También puedes ver este tour de nuevo desde acá.",
    side: "right",
    align: "end",
  },
  {
    element: '[data-tour-id="logout"]',
    title: "Cerrar sesión",
    description:
      "Cuando termines, cierra sesión desde acá. ¡Listo! Si quieres volver a ver el tour, está en el menú de Más opciones.",
    side: "right",
    align: "end",
  },
];

/**
 * Tour del rol Docente — pendiente. Estructura similar a ADMIN_TOUR.
 */
export const TEACHER_TOUR: TourStep[] = [];

/**
 * Tour del rol Estudiante — pendiente.
 */
export const STUDENT_TOUR: TourStep[] = [];

export function getTourForRole(
  role: "Admin" | "Docente" | "Estudiante",
): TourStep[] {
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
