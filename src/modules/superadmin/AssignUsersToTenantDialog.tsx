/**
 * AssignUsersToTenantDialog — el SuperAdmin asigna usuarios a una
 * institución desde el panel de tenants.
 *
 * Flow:
 *   1. Carga TODOS los profiles cross-tenant (SuperAdmin bypassa RLS).
 *   2. Filtra/busca por nombre o email.
 *   3. Marca con badge los que YA pertenecen al tenant destino.
 *   4. Checkbox para los que NO pertenecen → al confirmar, UPDATE
 *      profiles SET tenant_id = <tenant> para todos.
 *   5. El trigger tg_check_profile_tenant_change bloquea si el user
 *      tiene cursos activos en el tenant viejo. Mostramos el error
 *      friendly y seguimos con los demás (no abortamos el batch entero).
 *
 * Diseño: NO movemos masivamente sin revisar caso por caso — cada error
 * de trigger se muestra; los exitosos se aplican y se reflejan al
 * recargar al cerrar el dialog.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchInput } from "@/components/ui/search-input";
import { SectionLoader } from "@/components/ui/loaders";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { Save, UserPlus } from "lucide-react";
import type { Tenant } from "@/modules/tenants/tenant";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface ProfileRow {
  id: string;
  full_name: string;
  institutional_email: string;
  tenant_id: string | null;
}

interface Props {
  tenant: Tenant | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lista de tenants para mostrar el origen actual de cada user. */
  tenants: Tenant[];
  /** Callback tras un assign exitoso (refresh de la lista del padre). */
  onAssigned?: () => void;
}

export function AssignUsersToTenantDialog({
  tenant,
  open,
  onOpenChange,
  tenants,
  onAssigned,
}: Props) {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Reset al abrir / cerrar.
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelectedIds(new Set());
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data, error } = await db
        .from("profiles")
        .select("id, full_name, institutional_email, tenant_id")
        .order("full_name");
      if (cancelled) return;
      if (error) {
        toast.error(friendlyError(error, "No pudimos cargar usuarios"));
        setProfiles([]);
      } else {
        setProfiles((data ?? []) as ProfileRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const tenantNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tenants) m.set(t.id, t.name);
    return m;
  }, [tenants]);

  const filtered = useMemo(() => {
    if (!tenant) return [];
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      // Excluimos los que YA están en el tenant — el dialog es para
      // ASIGNAR nuevos miembros. Si quisieran reasignar (mover de
      // tenant A → B), el flujo correcto es editar el user desde
      // /app/admin/users (donde el SuperAdmin tiene dropdown de tenant
      // en el form de edit).
      if (p.tenant_id === tenant.id) return false;
      if (!q) return true;
      return (
        p.full_name.toLowerCase().includes(q) ||
        p.institutional_email.toLowerCase().includes(q)
      );
    });
  }, [profiles, search, tenant]);

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(filtered.map((p) => p.id)));
  };

  const clearAll = () => setSelectedIds(new Set());

  const assign = async () => {
    if (!tenant || selectedIds.size === 0) return;
    setSaving(true);
    const ids = [...selectedIds];
    // UPDATE uno-a-uno porque el trigger tg_check_profile_tenant_change
    // puede rechazar individualmente (user con cursos activos en otro
    // tenant). Si fueramos via WHERE id IN (...), el primer rechazo
    // anularía todo el batch.
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of ids) {
      const { error } = await db
        .from("profiles")
        .update({ tenant_id: tenant.id })
        .eq("id", id);
      results.push({
        id,
        ok: !error,
        error: error ? friendlyError(error) : undefined,
      });
    }
    setSaving(false);
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    if (okCount > 0) {
      toast.success(`${okCount} usuario${okCount === 1 ? "" : "s"} asignado${okCount === 1 ? "" : "s"} a ${tenant.name}`);
      onAssigned?.();
    }
    if (failCount > 0) {
      // Mostramos los primeros errores como toast detallado. Si hay
      // muchos, agrupamos para no saturar.
      const failed = results.filter((r) => !r.ok);
      const sample = failed.slice(0, 3);
      for (const f of sample) {
        const p = profiles.find((x) => x.id === f.id);
        toast.error(`${p?.full_name ?? f.id}: ${f.error ?? "error"}`, {
          duration: 8000,
        });
      }
      if (failed.length > sample.length) {
        toast.error(`Y ${failed.length - sample.length} más con error similar.`);
      }
    }
    if (okCount > 0) onOpenChange(false);
  };

  if (!tenant) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-violet-500" />
            Asignar usuarios a {tenant.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Solo se muestran usuarios que NO pertenecen aún a esta institución.
            El trigger del servidor rechaza la asignación si un usuario tiene
            cursos activos en su institución actual — en ese caso debe
            desmatricularse primero.
          </p>

          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar por nombre o correo…"
          />

          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {filtered.length} disponible{filtered.length === 1 ? "" : "s"}
              {selectedIds.size > 0 && ` · ${selectedIds.size} seleccionado${selectedIds.size === 1 ? "" : "s"}`}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={selectAll}
                disabled={filtered.length === 0}
              >
                Seleccionar todos
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={clearAll}
                disabled={selectedIds.size === 0}
              >
                Limpiar
              </Button>
            </div>
          </div>

          <div className="max-h-[50vh] overflow-y-auto rounded-md border divide-y">
            {loading ? (
              <SectionLoader text="Cargando usuarios…" />
            ) : filtered.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {search
                  ? "Sin coincidencias."
                  : "Todos los usuarios ya pertenecen a esta institución."}
              </p>
            ) : (
              filtered.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedIds.has(p.id)}
                    onCheckedChange={() => toggle(p.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{p.full_name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {p.institutional_email}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {p.tenant_id
                      ? tenantNameById.get(p.tenant_id) ?? "otra institución"
                      : "sin institución"}
                  </Badge>
                </label>
              ))
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={assign} disabled={saving || selectedIds.size === 0}>
            {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Asignar {selectedIds.size > 0 ? `(${selectedIds.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
