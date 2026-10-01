import { supabase } from "@/integrations/supabase/client";

/** Un grupo con entrega: su nombre y los ids de sus integrantes. */
export type GrupoDeEntrega = { nombre: string; integrantes: string[] };

/**
 * Nombre e integrantes de los grupos que tienen una entrega en la lista.
 *
 * Una entrega de grupo es UNA fila compartida (`group_id`) y su `user_id` es
 * solo quien la editó por última vez. Sin esto, el diálogo de calificación
 * mostraba «la entrega de Ana» y el docente calificaba sin saber que esa nota
 * es la de los cuatro integrantes.
 *
 * Es solo para MOSTRAR: si la consulta falla, devuelve lo que pudo y el
 * diálogo sigue funcionando como antes (con el nombre de quien entregó).
 */
export async function cargarGruposDeEntregas(
  tipo: "workshop" | "project",
  entregas: readonly { group_id?: string | null }[],
): Promise<Map<string, GrupoDeEntrega>> {
  const ids = Array.from(new Set(entregas.map((e) => e.group_id).filter((x): x is string => !!x)));
  const out = new Map<string, GrupoDeEntrega>();
  if (ids.length === 0) return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const [tablaGrupos, tablaMiembros] =
    tipo === "workshop"
      ? ["workshop_groups", "workshop_group_members"]
      : ["project_groups", "project_group_members"];
  const [{ data: gs }, { data: ms }] = await Promise.all([
    db.from(tablaGrupos).select("id, name").in("id", ids),
    db.from(tablaMiembros).select("group_id, user_id").in("group_id", ids),
  ]);
  for (const g of (gs ?? []) as { id: string; name: string }[]) {
    out.set(g.id, { nombre: g.name, integrantes: [] });
  }
  for (const m of (ms ?? []) as { group_id: string; user_id: string }[]) {
    out.get(m.group_id)?.integrantes.push(m.user_id);
  }
  return out;
}
