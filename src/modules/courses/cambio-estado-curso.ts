/**
 * Qué se le dice a quien cambia el estado de un curso, antes de hacerlo.
 *
 * Cambiar el estado de un curso mueve mucho más que el curso: pasarlo a
 * borrador pasa a borrador su material (y las notas de lo que ya tenía
 * entregas dejan de contar), finalizarlo lo cierra, y ninguna de las dos cosas
 * se deshace al volver atrás (migs 20260991000000 y 20262690000000). Un «¿Seguro?»
 * genérico no alcanza: el diálogo tiene que decir QUÉ va a pasar, con números.
 *
 * Los números los da `impacto_cambio_estado_curso`, que cuenta con las mismas
 * funciones que usa la cascada, así lo que se anuncia y lo que pasa no pueden
 * diferir. Si esa consulta falla, el aviso se arma igual, sin números.
 *
 * Este módulo es puro: devuelve claves de traducción con sus parámetros y la
 * pantalla las traduce. Así se puede probar qué dice cada transición sin montar
 * el diálogo.
 */

import type { CourseStatus } from "./course-status";

/** Orden en que se enumera el material, de lo que más pesa a lo que menos. */
export const TIPOS_DE_MATERIAL = [
  "examenes",
  "talleres",
  "proyectos",
  "encuestas",
  "pizarras",
  "contenidos",
] as const;
export type TipoDeMaterial = (typeof TIPOS_DE_MATERIAL)[number];
export type ConteoDeMaterial = Partial<Record<TipoDeMaterial, number>>;

/** Lo que devuelve `impacto_cambio_estado_curso` (cada rama trae lo suyo). */
export interface ImpactoCambioEstado {
  estado_actual?: string | null;
  matriculados?: number;
  // → borrador
  a_borrador?: ConteoDeMaterial;
  con_entregas?: number;
  retos_en_vivo?: number;
  compartidos_siguen?: number;
  // → finalizado
  pendientes_calificar?: number;
  a_cerrar?: ConteoDeMaterial;
  // → en curso
  bienvenida?: boolean;
  en_borrador?: ConteoDeMaterial;
  cerrados?: ConteoDeMaterial;
}

export type ClaveDeCambio = "aBorrador" | "activar" | "reabrir" | "finalizar";

/**
 * Un párrafo del diálogo. Si trae `material`, la pantalla lo enumera y lo pasa
 * como `{{lista}}`.
 */
export interface Parrafo {
  clave: string;
  params?: Record<string, number>;
  material?: ConteoDeMaterial;
}

export interface AvisoDeCambio {
  clave: ClaveDeCambio;
  tono: "default" | "warning";
  parrafos: Parrafo[];
  /**
   * El cambio no se puede hacer (finalizar con entregas sin calificar): se
   * muestra el motivo y no se ofrece confirmar. La base lo rechazaría igual;
   * decirlo antes evita pedir una confirmación que no va a servir.
   */
  bloqueo?: Parrafo;
}

/** El material con cantidad, en el orden de `TIPOS_DE_MATERIAL`. */
export function partesDeMaterial(conteo: ConteoDeMaterial | null | undefined): { tipo: TipoDeMaterial; n: number }[] {
  if (!conteo) return [];
  return TIPOS_DE_MATERIAL.map((tipo) => ({ tipo, n: Number(conteo[tipo] ?? 0) })).filter(
    (p) => Number.isFinite(p.n) && p.n > 0,
  );
}

export function totalDeMaterial(conteo: ConteoDeMaterial | null | undefined): number {
  return partesDeMaterial(conteo).reduce((s, p) => s + p.n, 0);
}

const positivo = (n: number | null | undefined) => Number(n ?? 0) > 0;

/**
 * El aviso de pasar un curso de `actual` a `destino`. `null` si no hay cambio.
 */
export function avisoDeCambioDeEstado(
  actual: string | null | undefined,
  destino: CourseStatus,
  impacto: ImpactoCambioEstado | null,
): AvisoDeCambio | null {
  // `null` es un curso heredado, que se trata como en curso (igual que el grid).
  const desde = actual ?? "en_curso";
  if (desde === destino) return null;

  if (destino === "borrador") {
    const parrafos: Parrafo[] = [];
    if (!impacto) {
      parrafos.push({ clave: "cursoEstado.aBorrador.sinDatos" });
    } else if (totalDeMaterial(impacto.a_borrador) > 0) {
      parrafos.push({ clave: "cursoEstado.aBorrador.material", material: impacto.a_borrador });
    } else {
      parrafos.push({ clave: "cursoEstado.aBorrador.nada" });
    }
    if (impacto && positivo(impacto.con_entregas)) {
      parrafos.push({ clave: "cursoEstado.aBorrador.conEntregas", params: { count: Number(impacto.con_entregas) } });
    }
    if (impacto && positivo(impacto.retos_en_vivo)) {
      parrafos.push({ clave: "cursoEstado.aBorrador.retos", params: { count: Number(impacto.retos_en_vivo) } });
    }
    if (impacto && positivo(impacto.compartidos_siguen)) {
      parrafos.push({
        clave: "cursoEstado.aBorrador.compartidos",
        params: { count: Number(impacto.compartidos_siguen) },
      });
    }
    parrafos.push({ clave: "cursoEstado.aBorrador.regla" });
    return { clave: "aBorrador", tono: "warning", parrafos };
  }

  if (destino === "finalizado") {
    const parrafos: Parrafo[] = [{ clave: "course.actionFinalizeConfirmBody" }];
    if (impacto && totalDeMaterial(impacto.a_cerrar) > 0) {
      parrafos.push({ clave: "cursoEstado.finalizar.cierra", material: impacto.a_cerrar });
    }
    const aviso: AvisoDeCambio = { clave: "finalizar", tono: "warning", parrafos };
    if (impacto && positivo(impacto.pendientes_calificar)) {
      aviso.bloqueo = {
        clave: "cursoEstado.finalizar.pendientes",
        params: { count: Number(impacto.pendientes_calificar) },
      };
    }
    return aviso;
  }

  // destino === "en_curso"
  if (desde === "finalizado") {
    const parrafos: Parrafo[] = [{ clave: "course.actionReopenConfirmBody" }];
    if (impacto && totalDeMaterial(impacto.cerrados) > 0) {
      parrafos.push({ clave: "cursoEstado.reabrir.cerrados", material: impacto.cerrados });
    }
    return { clave: "reabrir", tono: "default", parrafos };
  }

  const parrafos: Parrafo[] = [{ clave: "cursoEstado.activar.visible" }];
  if (impacto && positivo(impacto.matriculados)) {
    parrafos.push(
      impacto.bienvenida === false
        ? { clave: "cursoEstado.activar.sinBienvenida" }
        : { clave: "cursoEstado.activar.bienvenida", params: { count: Number(impacto.matriculados) } },
    );
  }
  if (impacto && totalDeMaterial(impacto.en_borrador) > 0) {
    parrafos.push({ clave: "cursoEstado.activar.siguenEnBorrador", material: impacto.en_borrador });
  }
  return { clave: "activar", tono: "default", parrafos };
}
