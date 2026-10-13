/**
 * Actividades del estudiante con el MISMO nombre en cursos distintos.
 *
 * Origen: una cohorte que cursa dos asignaturas tenía dos talleres distintos
 * llamados igual («Taller Corte 1 (Clases 1 a 4)»), uno por materia. Un
 * estudiante entregó el de una materia creyendo que era «el» taller del corte,
 * y el de la otra cerró sin entrega: contó 0. La tarjeta solo distinguía la
 * materia con el nombre del curso en gris tenue.
 *
 * La comparación usa el MISMO normalizador del buscador (minúsculas, sin tildes
 * ni espacios repetidos): dos normalizadores distintos harían que el mismo par se
 * marcara en una pantalla y en otra no. Dos actividades del MISMO curso con el
 * mismo nombre no se marcan: ahí el curso no ayuda a distinguirlas y el aviso
 * diría algo falso («en este mismo curso hay otra»). Tampoco se cuentan los
 * cursos FINALIZADOS: las listas del estudiante incluyen semestres pasados, y
 * «Parcial 1» repetido en el curso viejo marcaría cada tarjeta vigente con un
 * aviso inútil, que enseña a ignorarlo.
 */
import { normalizeForSearch } from "@/modules/search/search-text";

export interface ActividadConCurso {
  id: string;
  title: string | null | undefined;
  courseId: string | null | undefined;
  courseName: string | null | undefined;
  /** `courses.status`; con `finalizado` la actividad no entra en la comparación. */
  courseStatus?: string | null;
}

/**
 * Para cada actividad que tiene una homónima en OTRO curso, los nombres de esos
 * otros cursos (sin repetir, en el orden en que aparecen). Las demás no figuran.
 */
export function homonimasEnOtrosCursos(items: readonly ActividadConCurso[]): Map<string, string[]> {
  const porTitulo = new Map<string, ActividadConCurso[]>();
  for (const it of items) {
    if (it.courseStatus === "finalizado") continue;
    const clave = normalizeForSearch(it.title);
    if (!clave) continue;
    const grupo = porTitulo.get(clave);
    if (grupo) grupo.push(it);
    else porTitulo.set(clave, [it]);
  }
  const out = new Map<string, string[]>();
  for (const grupo of porTitulo.values()) {
    if (new Set(grupo.map((g) => g.courseId ?? "")).size < 2) continue;
    for (const it of grupo) {
      const otros = [
        ...new Set(
          grupo
            .filter((g) => (g.courseId ?? "") !== (it.courseId ?? ""))
            .map((g) => (g.courseName ?? "").trim())
            .filter(Boolean),
        ),
      ];
      if (otros.length) out.set(it.id, otros);
    }
  }
  return out;
}
