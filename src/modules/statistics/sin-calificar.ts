/**
 * Cuánto falta por calificar, desglosado por CORTE.
 *
 * Responde la pregunta con la que el docente entra a Estadísticas cuando se
 * acerca el cierre de un corte: «del Corte 1, ¿qué porcentaje de mis
 * estudiantes todavía no tiene nota?». Hasta ahora la pantalla mostraba el
 * promedio por corte, que dice cómo le va al que YA tiene nota y calla
 * justamente lo que hay que hacer.
 *
 * ── Qué cuenta como «sin calificar», y por qué ────────────────────────
 *
 * El denominador son las ENTREGAS ESPERADAS del corte: una por estudiante
 * matriculado y por actividad del corte. No las entregas existentes. La
 * diferencia es todo el punto: si el denominador fueran las entregas, un
 * estudiante que no entregó nada desaparecería de la cuenta y el corte se
 * vería «100% calificado» teniendo media clase sin nota. Es el mismo criterio
 * con el que `computeWeightedGrade` cuenta como cero lo que no se entregó.
 *
 * Una entrega está calificada cuando `effectiveGrade` devuelve un número. Ese
 * helper ya sabe lo que hay que saber: en un taller con sustentación la nota
 * NO es `ai_grade` mientras falte registrarla, y tratarla como final daría por
 * calificado algo que todavía no lo está.
 *
 * ── Las externas SÍ cuentan ───────────────────────────────────────────
 *
 * Una actividad externa (presencial, otra plataforma) también necesita que
 * alguien cargue la nota, y mientras no esté el estudiante no la tiene. Se
 * excluyen del promedio en otros cálculos porque no las produjo la plataforma;
 * acá lo que se mide es trabajo pendiente, y ese trabajo existe igual.
 *
 * Sin React ni consultas: consume el `CourseDataset` que la pantalla ya carga.
 */
import { effectiveGrade, type Cut, type SubmissionLike } from "@/shared/lib/statistics";

/** Lo que falta calificar en un corte. */
export interface PendientesDeCorte {
  cutId: string;
  cutName: string;
  /** Entregas esperadas: estudiantes × actividades del corte. */
  esperadas: number;
  /** De esas, cuántas ya tienen nota. */
  calificadas: number;
  /** Porcentaje SIN calificar, 0..100. `null` si el corte no tiene actividades. */
  pctSinCalificar: number | null;
  /** Cuántos estudiantes no tienen NINGUNA nota en el corte. */
  estudiantesSinNingunaNota: number;
}

/**
 * Una actividad del corte, ya resuelta para el curso. Solo se necesita su id y
 * su corte: el resto lo aportan las entregas.
 */
export interface ActividadDeCorte {
  id: string;
  cut_id: string | null;
}

/**
 * Desglose por corte de lo que falta calificar.
 *
 * `actividades` son las del curso (exámenes + talleres + proyectos, ya
 * achatadas). `entregas` son todas las entregas del curso. `estudiantes` es la
 * cantidad de matriculados — el denominador por actividad.
 */
export function pendientesPorCorte(
  cuts: readonly Cut[],
  actividades: readonly ActividadDeCorte[],
  entregas: readonly SubmissionLike[],
  estudiantes: number,
): PendientesDeCorte[] {
  return cuts.map((cut) => {
    const delCorte = actividades.filter((a) => a.cut_id === cut.id);
    const idsDelCorte = new Set(delCorte.map((a) => a.id));
    const esperadas = delCorte.length * Math.max(0, estudiantes);

    // Una entrega por (actividad, estudiante). Se deduplica porque un examen
    // con varios intentos tiene varias filas y la nota es una sola.
    const calificadasPorPar = new Set<string>();
    const conNotaPorAlumno = new Set<string>();
    for (const s of entregas) {
      if (!idsDelCorte.has(s.ref_id)) continue;
      if (effectiveGrade(s) == null) continue;
      calificadasPorPar.add(`${s.ref_id}|${s.user_id}`);
      conNotaPorAlumno.add(s.user_id);
    }
    const calificadas = Math.min(calificadasPorPar.size, esperadas);

    return {
      cutId: cut.id,
      cutName: cut.name,
      esperadas,
      calificadas,
      pctSinCalificar:
        esperadas === 0 ? null : Math.round(((esperadas - calificadas) / esperadas) * 1000) / 10,
      estudiantesSinNingunaNota:
        delCorte.length === 0 ? 0 : Math.max(0, estudiantes - conNotaPorAlumno.size),
    };
  });
}

/**
 * Suma varios cursos en un solo desglose, agrupando por NOMBRE de corte.
 *
 * Se agrupa por nombre y no por id porque cada curso tiene sus propios cortes:
 * el «Corte 1» de Bases de Datos y el de Seminario son filas distintas de
 * `grade_cuts`, y la pregunta del docente —«¿cómo viene el Corte 1 de todo el
 * periodo?»— los trata como el mismo. El nombre se normaliza sin distinguir
 * mayúsculas ni espacios de más, que es como difieren en la práctica.
 */
export function unirPorNombreDeCorte(
  porCurso: ReadonlyArray<readonly PendientesDeCorte[]>,
): PendientesDeCorte[] {
  const acc = new Map<string, PendientesDeCorte>();
  for (const lista of porCurso) {
    for (const p of lista) {
      const clave = p.cutName.trim().toLowerCase();
      const previo = acc.get(clave);
      if (!previo) {
        acc.set(clave, { ...p, cutId: clave });
        continue;
      }
      previo.esperadas += p.esperadas;
      previo.calificadas += p.calificadas;
      previo.estudiantesSinNingunaNota += p.estudiantesSinNingunaNota;
      previo.pctSinCalificar =
        previo.esperadas === 0
          ? null
          : Math.round(((previo.esperadas - previo.calificadas) / previo.esperadas) * 1000) / 10;
    }
  }
  // Orden por nombre: «Corte 1», «Corte 2»… con numérico para que 10 no vaya
  // antes que 2.
  return [...acc.values()].sort((a, b) =>
    a.cutName.localeCompare(b.cutName, "es", { numeric: true }),
  );
}
