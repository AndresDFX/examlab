/**
 * Llamadas a las RPC de grupos armados por estudiantes (mig 20262830000000).
 * Aparte de `grupos-estudiante.ts` para que las reglas puras se prueben sin red.
 */
import { supabase } from "@/integrations/supabase/client";
import { logEvent } from "@/shared/lib/audit";
import {
  armadoPorElDocente,
  type EstadoDeGrupo,
  type ResumenDeGrupo,
  type TipoActividadGrupal,
} from "@/modules/grupos/grupos-estudiante";

// Las RPC todavía no están en `types.ts` (se regenera aparte).
type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;
const rpc: Rpc = (fn, args) => (supabase as unknown as { rpc: Rpc }).rpc(fn, args);

/**
 * Cuáles de estos grupos los armó el docente (`armadoPorElDocente`). Se lee de
 * la tabla y no de la RPC, que no lo devuelve; el estudiante puede leer los
 * grupos de su institución. Si la lectura falla, no se marca ninguno: lo peor
 * que pasa es el aviso de «por debajo del mínimo» de antes.
 */
async function gruposDelDocente(tipo: TipoActividadGrupal, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try {
    const { data, error } =
      tipo === "proyecto"
        ? await supabase.from("project_groups").select("id, created_by").in("id", ids)
        : await supabase.from("workshop_groups").select("id, created_by").in("id", ids);
    if (error) throw error;
    return new Set((data ?? []).filter(armadoPorElDocente).map((g) => g.id));
  } catch (e) {
    console.warn("[grupos] no se pudo saber quién armó el grupo", e);
    return new Set();
  }
}

/**
 * Resumen de grupos de varias actividades, para las tarjetas de la lista. Si
 * falla (por ejemplo, la pantalla llegó antes que la migración) devuelve vacío:
 * la tarjeta queda como antes, sin sección de grupo, y la lista no se cae.
 */
export async function cargarResumenDeGrupos(
  tipo: TipoActividadGrupal,
  actividadIds: string[],
): Promise<Record<string, ResumenDeGrupo>> {
  if (actividadIds.length === 0) return {};
  try {
    const pedir = () =>
      rpc("grupos_estudiante_resumen", { _tipo: tipo, _actividades: actividadIds });
    let { data, error } = await pedir();
    // Un reintento: un corte de red o un timeout de la base no deben dejar la
    // tarjeta sin «Armar grupo» (la lista usa además `resumenDeRespaldo`).
    if (error) {
      await new Promise((r) => setTimeout(r, 800));
      ({ data, error } = await pedir());
    }
    if (error) {
      void logEvent({
        action: "grupos.resumen_failed",
        category: "system",
        severity: "warning",
        metadata: { tipo, actividades: actividadIds.length, error: String((error as { message?: string }).message ?? error) },
      });
      throw error;
    }
    const resumen = (data ?? {}) as Record<string, ResumenDeGrupo>;
    // Solo importa para el aviso de «por debajo del mínimo»: se consulta nada más
    // por los grupos que lo están (casi siempre ninguno).
    const cortos = Object.values(resumen)
      .filter((r) => r.grupo && r.grupo.integrantes < r.minimo)
      .map((r) => r.grupo!);
    const delDocente = await gruposDelDocente(
      tipo,
      cortos.map((g) => g.id),
    );
    for (const g of cortos) g.armado_por_docente = delDocente.has(g.id);
    return resumen;
  } catch (e) {
    console.warn("[grupos] resumen no disponible", e);
    return {};
  }
}

export async function cargarEstadoDeGrupo(
  tipo: TipoActividadGrupal,
  actividadId: string,
): Promise<EstadoDeGrupo> {
  const { data, error } = await rpc("grupo_estudiante_estado", {
    _tipo: tipo,
    _actividad: actividadId,
  });
  if (error) throw error;
  const estado = data as EstadoDeGrupo;
  if (estado.grupo && estado.grupo.integrantes.length < estado.minimo) {
    const delDocente = await gruposDelDocente(tipo, [estado.grupo.id]);
    estado.grupo.armado_por_docente = delDocente.has(estado.grupo.id);
  }
  return estado;
}

export async function crearGrupo(
  tipo: TipoActividadGrupal,
  actividadId: string,
  nombre: string,
  companeros: string[],
): Promise<string> {
  const { data, error } = await rpc("grupo_estudiante_crear", {
    _tipo: tipo,
    _actividad: actividadId,
    _nombre: nombre,
    _companeros: companeros,
  });
  if (error) throw error;
  return data as string;
}

export async function agregarAGrupo(
  tipo: TipoActividadGrupal,
  grupoId: string,
  companeros: string[],
): Promise<number> {
  const { data, error } = await rpc("grupo_estudiante_agregar", {
    _tipo: tipo,
    _grupo: grupoId,
    _companeros: companeros,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function salirDelGrupo(tipo: TipoActividadGrupal, grupoId: string): Promise<void> {
  const { error } = await rpc("grupo_estudiante_salir", { _tipo: tipo, _grupo: grupoId });
  if (error) throw error;
}
