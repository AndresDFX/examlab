/**
 * Las pantallas que recorre la Fase 1, por rol. Los datos son los de la institución de
 * demostración (Demo Global Corp), que tiene curso, proyectos, talleres, sesiones y
 * certificados para la cuenta multi-rol de las pruebas.
 */
import type { Page } from "@playwright/test";

export type Rol = "Estudiante" | "Docente" | "Admin";

export interface Pantalla {
  /** Estable: es parte de la clave de la línea base. No cambiarlo sin regenerarla. */
  id: string;
  nombre: string;
  /** `null` = página pública, sin sesión. */
  rol: Rol | null;
  ruta: string;
  /** Lo que hay que hacer para llegar a la vista con datos (elegir un curso). */
  preparar?: (page: Page) => Promise<void>;
}

/** Curso de demostración con datos en todas las pantallas del docente. */
const CURSO_DEMO = "Fundamentos de Programación — Grupo A";

/**
 * Asistencia abre pidiendo un curso con atajos (`SelectionRequired`); el libro de notas
 * elige uno solo, que puede ser cualquiera. Para medir siempre la misma tabla se elige el
 * de demostración: con los atajos, o abriendo el selector que lo ofrezca.
 */
async function elegirCurso(page: Page): Promise<void> {
  const atajo = page.getByRole("button", { name: CURSO_DEMO }).first();
  // El libro de notas es la pantalla más pesada: puede seguir en «Cargando…» cuando la
  // espera general ya se rindió. Hasta que aparezca un atajo o un selector no hay qué elegir.
  await atajo
    .or(page.locator("main").getByRole("combobox"))
    .first()
    .waitFor({ state: "visible", timeout: 45_000 });
  if (await atajo.isVisible().catch(() => false)) {
    await atajo.click();
    return;
  }
  const selectores = page.locator("main").getByRole("combobox");
  const cantidad = await selectores.count();
  for (let i = 0; i < cantidad; i++) {
    const selector = selectores.nth(i);
    if ((await selector.textContent())?.includes(CURSO_DEMO)) return;
    await selector.click();
    const opcion = page.getByRole("option", { name: CURSO_DEMO });
    const ofrece = await opcion
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (ofrece) {
      await opcion.click();
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error(`[e2e] Ningún selector ofrece el curso «${CURSO_DEMO}».`);
}

export const PANTALLAS: Pantalla[] = [
  { id: "publica-portada", nombre: "Portada", rol: null, ruta: "/" },
  { id: "publica-ingreso", nombre: "Inicio de sesión", rol: null, ruta: "/auth" },
  {
    id: "publica-certificado",
    nombre: "Verificación de certificado",
    rol: null,
    ruta: "/verify/2VRRLPYDB24Z",
  },
  {
    id: "publica-encuesta",
    nombre: "Encuesta por enlace (enlace vencido)",
    rol: null,
    ruta: "/encuesta/00000000000000000000000000000000",
  },
  { id: "publica-reto", nombre: "Reto en vivo (PIN inexistente)", rol: null, ruta: "/reto/000000" },

  { id: "est-inicio", nombre: "Estudiante · Inicio", rol: "Estudiante", ruta: "/app" },
  {
    id: "est-proyectos",
    nombre: "Estudiante · Proyectos",
    rol: "Estudiante",
    ruta: "/app/student/projects",
  },
  {
    id: "est-talleres",
    nombre: "Estudiante · Talleres",
    rol: "Estudiante",
    ruta: "/app/student/workshops",
  },
  {
    id: "est-notas",
    nombre: "Estudiante · Mis notas",
    rol: "Estudiante",
    ruta: "/app/student/grades",
  },
  {
    id: "est-asistencia",
    nombre: "Estudiante · Asistencia",
    rol: "Estudiante",
    ruta: "/app/student/attendance",
  },
  {
    id: "est-firmas",
    nombre: "Estudiante · Firmas",
    rol: "Estudiante",
    ruta: "/app/student/signatures",
  },

  { id: "doc-inicio", nombre: "Docente · Inicio", rol: "Docente", ruta: "/app" },
  {
    id: "doc-proyectos",
    nombre: "Docente · Proyectos",
    rol: "Docente",
    ruta: "/app/teacher/projects",
  },
  {
    id: "doc-talleres",
    nombre: "Docente · Talleres",
    rol: "Docente",
    ruta: "/app/teacher/workshops",
  },
  {
    id: "doc-libro",
    nombre: "Docente · Libro de notas",
    rol: "Docente",
    ruta: "/app/teacher/gradebook",
    preparar: elegirCurso,
  },
  {
    id: "doc-asistencia",
    nombre: "Docente · Asistencia",
    rol: "Docente",
    ruta: "/app/teacher/attendance",
    preparar: elegirCurso,
  },

  { id: "adm-usuarios", nombre: "Admin · Usuarios", rol: "Admin", ruta: "/app/admin/users" },
  { id: "adm-cursos", nombre: "Admin · Cursos", rol: "Admin", ruta: "/app/admin/courses" },
];
