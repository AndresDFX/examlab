import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";
import {
  normalizarTextoPendiente,
  siguientePosicion,
  type PendienteSesion,
} from "./pendientes-sesion";

const COLUMNAS = "id, session_id, body, done_at, position, created_at";

// La tabla es nueva (mig 20262640000000) y todavía no está en types.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tabla = () => (supabase as any).from("session_pending_items");

export interface PendientesDeSesiones {
  items: PendienteSesion[];
  cargando: boolean;
  /** Error de la CARGA. Las mutaciones devuelven el suyo. */
  error: string | null;
  recargar: () => void;
  agregar: (sessionId: string, texto: string) => Promise<string | null>;
  /** Varios de una vez (el campo del check-in). Textos ya normalizados. */
  agregarVarios: (sessionId: string, textos: readonly string[]) => Promise<string | null>;
  alternar: (item: PendienteSesion) => Promise<string | null>;
  editar: (item: PendienteSesion, texto: string) => Promise<string | null>;
  borrar: (item: PendienteSesion) => Promise<string | null>;
}

/**
 * Los pendientes de TODAS las sesiones de un curso, cargados una vez: la
 * pantalla los necesita juntos para pintar el aviso de cada columna.
 *
 * Las mutaciones son optimistas y se revierten si la base las rechaza; cada una
 * devuelve `null` si salió bien o el mensaje que hay que mostrar.
 */
export function usePendientesDeSesiones(sessionIds: readonly string[]): PendientesDeSesiones {
  const [items, setItems] = useState<PendienteSesion[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // La clave estable: la lista llega como un arreglo nuevo en cada render.
  const clave = [...sessionIds].sort().join(",");

  useEffect(() => {
    let cancelled = false;
    // Sin sesiones no se consulta: `.in("session_id", [])` en PostgREST
    // devuelve TODAS las filas visibles, no ninguna.
    if (!clave) {
      setItems([]);
      setError(null);
      setCargando(false);
      return;
    }
    setCargando(true);
    void (async () => {
      const { data, error: err } = await tabla().select(COLUMNAS).in("session_id", clave.split(","));
      if (cancelled) return;
      setCargando(false);
      if (err) {
        setError(friendlyError(err));
        return;
      }
      setError(null);
      setItems((data ?? []) as PendienteSesion[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [clave, nonce]);

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  const agregar = useCallback(
    async (sessionId: string, texto: string) => {
      const body = normalizarTextoPendiente(texto);
      if (!body) return null;
      const { data, error: err } = await tabla()
        .insert({ session_id: sessionId, body, position: siguientePosicion(items, sessionId) })
        .select(COLUMNAS)
        .single();
      if (err) return friendlyError(err);
      setItems((prev) => [...prev, data as PendienteSesion]);
      return null;
    },
    [items],
  );

  const agregarVarios = useCallback(
    async (sessionId: string, textos: readonly string[]) => {
      if (textos.length === 0) return null;
      const desde = siguientePosicion(items, sessionId);
      const { data, error: err } = await tabla()
        .insert(textos.map((body, i) => ({ session_id: sessionId, body, position: desde + i })))
        .select(COLUMNAS);
      if (err) return friendlyError(err);
      setItems((prev) => [...prev, ...((data ?? []) as PendienteSesion[])]);
      return null;
    },
    [items],
  );

  /** Aplica un cambio parcial a un pendiente del estado local. */
  const aplicar = (id: string, cambio: Partial<PendienteSesion>) =>
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...cambio } : p)));

  const alternar = useCallback(async (item: PendienteSesion) => {
    const done_at = item.done_at ? null : new Date().toISOString();
    aplicar(item.id, { done_at });
    // `.select()` para distinguir "guardado" de "la RLS lo filtró": un UPDATE
    // que no toca ninguna fila no da error, devuelve 204 igual.
    const { data, error: err } = await tabla().update({ done_at }).eq("id", item.id).select("id");
    if (err || !data?.length) {
      aplicar(item.id, { done_at: item.done_at });
      return err ? friendlyError(err) : i18n.t("pendientesSesion.saveFailed");
    }
    return null;
  }, []);

  const editar = useCallback(async (item: PendienteSesion, texto: string) => {
    const body = normalizarTextoPendiente(texto);
    if (!body || body === item.body) return null;
    aplicar(item.id, { body });
    const { data, error: err } = await tabla().update({ body }).eq("id", item.id).select("id");
    if (err || !data?.length) {
      aplicar(item.id, { body: item.body });
      return err ? friendlyError(err) : i18n.t("pendientesSesion.saveFailed");
    }
    return null;
  }, []);

  const borrar = useCallback(async (item: PendienteSesion) => {
    setItems((prev) => prev.filter((p) => p.id !== item.id));
    const { data, error: err } = await tabla().delete().eq("id", item.id).select("id");
    if (err || !data?.length) {
      setItems((prev) => (prev.some((p) => p.id === item.id) ? prev : [...prev, item]));
      return err ? friendlyError(err) : i18n.t("pendientesSesion.deleteFailed");
    }
    return null;
  }, []);

  return { items, cargando, error, recargar, agregar, agregarVarios, alternar, editar, borrar };
}
