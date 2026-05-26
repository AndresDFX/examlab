/**
 * AssignUsersToTenantDialog — el SuperAdmin gestiona qué usuarios
 * pertenecen a una institución (agregar y quitar en la misma vista).
 *
 * Flow:
 *   1. Carga TODOS los profiles cross-tenant (SuperAdmin bypassa RLS).
 *   2. Filtra/busca por nombre o correo.
 *   3. Cada fila tiene un checkbox "pertenece a esta institución"
 *      precargado con el estado actual:
 *        - checked = miembro actual del tenant
 *        - unchecked = pertenece a otra institución o a ninguna
 *   4. El SuperAdmin marca/desmarca; calculamos el diff contra el
 *      estado inicial:
 *        - newly checked  → UPDATE tenant_id = tenant.id
 *        - newly unchecked → UPDATE tenant_id = NULL
 *   5. El trigger tg_check_profile_tenant_change bloquea si el user
 *      tiene cursos activos en su tenant viejo. Mostramos el error y
 *      seguimos con los demás (no abortamos el batch).
 *   6. Si hay quitados, pedimos confirmación destructive antes.
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
import { Save, Users } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
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
  /** Callback tras un cambio exitoso (refresh de la lista del padre). */
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
  // Estado deseado: set de IDs que el SuperAdmin quiere que estén en
  // ESTE tenant. Inicia poblado con los miembros actuales.
  const [desiredMembers, setDesiredMembers] = useState<Set<string>>(new Set());
  // Estado inicial guardado para diff. Mismo contenido que desiredMembers
  // al cargar; no cambia hasta el siguiente load.
  const [initialMembers, setInitialMembers] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();

  // Reset al abrir / cerrar.
  useEffect(() => {
    if (!open || !tenant) return;
    setSearch("");
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
        setDesiredMembers(new Set());
        setInitialMembers(new Set());
      } else {
        const rows = (data ?? []) as ProfileRow[];
        setProfiles(rows);
        const current = new Set(
          rows.filter((r) => r.tenant_id === tenant.id).map((r) => r.id),
        );
        setDesiredMembers(new Set(current));
        setInitialMembers(current);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tenant]);

  const tenantNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tenants) m.set(t.id, t.name);
    return m;
  }, [tenants]);

  const filtered = useMemo(() => {
    if (!tenant) return [];
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (!q) return true;
      return (
        p.full_name.toLowerCase().includes(q) ||
        p.institutional_email.toLowerCase().includes(q)
      );
    });
  }, [profiles, search, tenant]);

  const { toAdd, toRemove } = useMemo(() => {
    const adds: string[] = [];
    const removes: string[] = [];
    for (const id of desiredMembers) {
      if (!initialMembers.has(id)) adds.push(id);
    }
    for (const id of initialMembers) {
      if (!desiredMembers.has(id)) removes.push(id);
    }
    return { toAdd: adds, toRemove: removes };
  }, [desiredMembers, initialMembers]);

  const hasChanges = toAdd.length > 0 || toRemove.length > 0;

  const toggle = (id: string) => {
    setDesiredMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    if (!tenant || !hasChanges) return;

    if (toRemove.length > 0) {
      const ok = await confirm({
        title: `Quitar ${toRemove.length} usuario${toRemove.length === 1 ? "" : "s"} de ${tenant.name}`,
        description: `Estos usuarios dejarán de pertenecer a la institución y quedarán sin tenant. Si tienen cursos activos en ${tenant.name}, el servidor rechazará el cambio.`,
        tone: "destructive",
        confirmLabel: "Quitar",
      });
      if (!ok) return;
    }

    setSaving(true);
    const results: Array<{
      id: string;
      kind: "add" | "remove";
      ok: boolean;
      error?: string;
    }> = [];

    for (const id of toAdd) {
      const { error } = await db
        .from("profiles")
        .update({ tenant_id: tenant.id })
        .eq("id", id);
      results.push({
        id,
        kind: "add",
        ok: !error,
        error: error ? friendlyError(error) : undefined,
      });
    }
    for (const id of toRemove) {
      const { error } = await db
        .from("profiles")
        .update({ tenant_id: null })
        .eq("id", id);
      results.push({
        id,
        kind: "remove",
        ok: !error,
        error: error ? friendlyError(error) : undefined,
      });
    }

    setSaving(false);

    const addedOk = results.filter((r) => r.kind === "add" && r.ok).length;
    const removedOk = results.filter((r) => r.kind === "remove" && r.ok).length;
    const failed = results.filter((r) => !r.ok);

    if (addedOk > 0) {
      toast.success(
        `${addedOk} usuario${addedOk === 1 ? "" : "s"} agregado${addedOk === 1 ? "" : "s"} a ${tenant.name}`,
      );
    }
    if (removedOk > 0) {
      toast.success(
        `${removedOk} usuario${removedOk === 1 ? "" : "s"} quitado${removedOk === 1 ? "" : "s"} de ${tenant.name}`,
      );
    }
    if (failed.length > 0) {
      const sample = failed.slice(0, 3);
      for (const f of sample) {
        const p = profiles.find((x) => x.id === f.id);
        toast.error(`${p?.full_name ?? f.id}: ${f.error ?? "error"}`, {
          duration: 8000,
        });
      }
      if (failed.length > sample.length) {
        toast.error(
          `Y ${failed.length - sample.length} más con error similar.`,
        );
      }
    }

    if (addedOk + removedOk > 0) {
      onAssigned?.();
      onOpenChange(false);
    }
  };

  if (!tenant) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-violet-500" />
            Gestionar usuarios de {tenant.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Marca los usuarios que pertenecen a esta institución. Desmarca para
            quitarlos. El trigger del servidor rechaza el cambio si el usuario
            tiene cursos activos en su institución actual — en ese caso debe
            desmatricularse primero.
          </p>

          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar por nombre o correo…"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              {filtered.length} usuario{filtered.length === 1 ? "" : "s"}
              {hasChanges && (
                <>
                  {" · "}
                  {toAdd.length > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      +{toAdd.length}
                    </span>
                  )}
                  {toAdd.length > 0 && toRemove.length > 0 && " · "}
                  {toRemove.length > 0 && (
                    <span className="text-destructive">−{toRemove.length}</span>
                  )}
                </>
              )}
            </span>
            {hasChanges && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setDesiredMembers(new Set(initialMembers))}
                disabled={saving}
              >
                Descartar cambios
              </Button>
            )}
          </div>

          <div className="max-h-[50vh] overflow-y-auto rounded-md border divide-y">
            {loading ? (
              <SectionLoader text="Cargando usuarios…" />
            ) : filtered.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {search ? "Sin coincidencias." : "No hay usuarios."}
              </p>
            ) : (
              filtered.map((p) => {
                const isMember = desiredMembers.has(p.id);
                const wasMember = initialMembers.has(p.id);
                const willChange = isMember !== wasMember;
                const otherTenant =
                  p.tenant_id && p.tenant_id !== tenant.id
                    ? tenantNameById.get(p.tenant_id) ?? "otra institución"
                    : null;
                return (
                  <label
                    key={p.id}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer"
                  >
                    <Checkbox
                      checked={isMember}
                      onCheckedChange={() => toggle(p.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {p.full_name}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {p.institutional_email}
                      </div>
                    </div>
                    {willChange && isMember && (
                      <Badge
                        variant="outline"
                        className="text-[10px] shrink-0 border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                      >
                        Agregar
                      </Badge>
                    )}
                    {willChange && !isMember && (
                      <Badge
                        variant="outline"
                        className="text-[10px] shrink-0 border-destructive/50 text-destructive"
                      >
                        Quitar
                      </Badge>
                    )}
                    {!willChange && wasMember && (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        Miembro
                      </Badge>
                    )}
                    {!willChange && !wasMember && otherTenant && (
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {otherTenant}
                      </Badge>
                    )}
                    {!willChange && !wasMember && !otherTenant && (
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        sin institución
                      </Badge>
                    )}
                  </label>
                );
              })
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !hasChanges}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            Guardar
            {hasChanges && ` (${toAdd.length + toRemove.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
