/**
 * Llamadas a las RPC de grupos armados por estudiantes (mig 20262830000000).
 * Aparte de `grupos-estudiante.ts` para que las reglas puras se prueben sin red.
 */
import { supabase } from "@/integrations/supabase/client";
import type {
  EstadoDeGrupo,
  ResumenDeGrupo,
  TipoActividadGrupal,
} from "@/modules/grupos/grupos-estudiante";

// Las RPC todavía no están en `types.ts` (se regenera aparte).
type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;
const rpc: Rpc = (fn, args) => (supabase as unknown as { rpc: Rpc }).rpc(fn, args);

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
    const { data, error } = await rpc("grupos_estudiante_resumen", {
      _tipo: tipo,
      _actividades: actividadIds,
    });
    if (error) throw error;
    return (data ?? {}) as Record<string, ResumenDeGrupo>;
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
  return data as EstadoDeGrupo;
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
