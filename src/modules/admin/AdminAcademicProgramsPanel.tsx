/**
 * Panel CRUD de Programas Académicos (Admin).
 *
 * Mantiene la lista de programas/carreras (Ingeniería de Sistemas,
 * Derecho, etc.). Cada curso se asocia a un programa vía
 * `courses.program_id` — esa asociación alimenta el header de los
 * informes institucionales y permite analytics por programa.
 *
 * Toggle `active`: programas inactivos no aparecen en el dropdown del
 * form de curso, pero NO se borran (preservan los cursos viejos).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { useTableSort } from "@/hooks/use-table-sort";
import { usePagination } from "@/hooks/use-pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ErrorState, TableEmpty } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { SearchInput } from "@/components/ui/search-input";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { GraduationCap, Plus, Pencil, Trash2, Copy } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface AcademicProgram {
  id: string;
  name: string;
  code: string | null;
  faculty: string | null;
  active: boolean;
  created_at: string;
}

interface Draft {
  id: string | null;
  name: string;
  code: string;
  faculty: string;
  active: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  code: "",
  faculty: "",
  active: true,
};

/** Filtro por vigencia del programa. Default 'all' para no cambiar el
 *  comportamiento previo del panel (mostraba activos e inactivos juntos). */
type ActiveFilter = "all" | "active" | "inactive";

export function AdminAcademicProgramsPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<AcademicProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Fila que se está eliminando — bloquea la acción (anti doble-submit) y
  // deja el ítem del menú deshabilitado mientras corre el DELETE.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Guard "cambios sin guardar" para el dialog crear/editar carrera. El form
  // ya es UN objeto (`draft`), así que se pasa directo al hook.
  const dirty = useDirtyDialog(open, draft);
  // `load()` se dispara desde el effect y desde cada handler; si el admin
  // navega mientras la query vuela, los setState caerían sobre un componente
  // desmontado. Guard estándar del repo.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await db
        .from("academic_programs")
        .select("id, name, code, faculty, active, created_at")
        .order("name");
      if (!mountedRef.current) return;
      if (error) {
        setLoadError(friendlyError(error, t("hc_modulesAdminAdminAcademicProgramsPanel.errLoad")));
        return;
      }
      setRows((data ?? []) as AcademicProgram[]);
    } catch (e) {
      // Un throw (red caída, sesión inválida) también debe dejar el
      // ErrorState con "Reintentar" — no una tabla vacía sin explicación.
      if (!mountedRef.current) return;
      setLoadError(friendlyError(e, t("hc_modulesAdminAdminAcademicProgramsPanel.errLoad")));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Flujo obligatorio del design system: filtrar → ORDENAR → paginar.
  const filtered = useMemo(() => {
    let result = rows;
    if (activeFilter !== "all") {
      const wantActive = activeFilter === "active";
      result = result.filter((r) => r.active === wantActive);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.code?.toLowerCase().includes(q) ?? false) ||
          (r.faculty?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [rows, search, activeFilter]);

  const sort = useTableSort(filtered, {
    columns: {
      name: (r) => r.name,
      code: (r) => r.code,
      faculty: (r) => r.faculty,
      // Boolean: el comparador del hook pone false antes que true en asc, así
      // que "asc" agrupa los inactivos arriba y "desc" los activos.
      active: (r) => r.active,
    },
    // Preserva el orden que traía la query (`.order("name")`).
    defaultSort: { key: "name", dir: "asc" },
    storageKey: "examlab_sort:admin_academic_programs",
  });

  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:admin_academic_programs",
    resetKey: `${search}|${activeFilter}|${sort.resetKey}`,
  });

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const openEdit = (r: AcademicProgram) => {
    setDraft({
      id: r.id,
      name: r.name,
      code: r.code ?? "",
      faculty: r.faculty ?? "",
      active: r.active,
    });
    setOpen(true);
  };

  /** Duplicar: pre-llena el form de creación (id=null) con los datos de la
   *  carrera origen. Una carrera es atómica (nombre/código/facultad), así que
   *  "qué copiar" es el propio formulario — el admin ajusta el nombre (se le
   *  sufija " (copia)" para no chocar con un índice único) antes de guardar.
   *  No se insertan asignaturas: pertenecen a la carrera por FK y duplicarlas
   *  en bloque es un caso aparte. */
  const duplicate = (r: AcademicProgram) => {
    setDraft({
      id: null,
      name: `${r.name} (copia)`,
      code: r.code ?? "",
      faculty: r.faculty ?? "",
      active: r.active,
    });
    setOpen(true);
  };

  const save = async () => {
    if (!user) return;
    if (saving) return; // anti doble-submit (Enter + click, doble click)
    const name = draft.name.trim();
    if (!name) {
      toast.error(i18n.t("academic.programs.toastNameRequired"));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name,
        code: draft.code.trim() || null,
        faculty: draft.faculty.trim() || null,
        active: draft.active,
        updated_by: user.id,
      };
      const { error } = draft.id
        ? await db.from("academic_programs").update(payload).eq("id", draft.id)
        : await db.from("academic_programs").insert(payload);
      if (error) {
        toast.error(friendlyError(error, t("hc_modulesAdminAdminAcademicProgramsPanel.errSave")));
        return;
      }
      void logEvent({
        action: draft.id ? "program.updated" : "program.created",
        category: "academic",
        severity: "info",
        entityType: "academic_program",
        entityId: draft.id ?? undefined,
        entityName: name,
        metadata: { code: payload.code, faculty: payload.faculty, active: payload.active },
      });
      toast.success(
        draft.id
          ? i18n.t("academic.programs.toastUpdated")
          : i18n.t("academic.programs.toastCreated"),
      );
      setOpen(false);
      void load();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesAdminAdminAcademicProgramsPanel.errSave")));
    } finally {
      // Sin este finally, un throw dejaba el botón deshabilitado para siempre.
      if (mountedRef.current) setSaving(false);
    }
  };

  const toggleActive = async (r: AcademicProgram) => {
    if (togglingId) return;
    setTogglingId(r.id);
    const next = !r.active;
    try {
      const { error } = await db
        .from("academic_programs")
        .update({ active: next })
        .eq("id", r.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "program.toggled",
        category: "academic",
        severity: "info",
        entityType: "academic_program",
        entityId: r.id,
        entityName: r.name,
        metadata: { active: next },
      });
      void load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      if (mountedRef.current) setTogglingId(null);
    }
  };

  const remove = async (r: AcademicProgram) => {
    if (deletingId) return;
    const ok = await confirm({
      title: i18n.t("academic.programs.confirmDeleteTitle", { name: r.name }),
      description: i18n.t("academic.programs.confirmDeleteDesc"),
      confirmLabel: i18n.t("academic.programs.confirmDeleteLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    setDeletingId(r.id);
    try {
      const { error } = await db.from("academic_programs").delete().eq("id", r.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "program.deleted",
        category: "academic",
        severity: "warning",
        entityType: "academic_program",
        entityId: r.id,
        entityName: r.name,
      });
      toast.success(i18n.t("academic.programs.toastDeleted"));
      void load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      if (mountedRef.current) setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-base flex items-center gap-2">
          <GraduationCap className="h-4 w-4 text-violet-500" />
          {t("academic.programs.title")}
        </CardTitle>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t("academic.programs.new")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("academic.programs.description")}
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("academic.programs.searchPlaceholder", {
                defaultValue: "Buscar por nombre, código o área…",
              })}
            />
          </div>
          <Select
            value={activeFilter}
            onValueChange={(v) => setActiveFilter(v as ActiveFilter)}
          >
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("academic.programs.filterAll", { defaultValue: "Todos" })}
              </SelectItem>
              <SelectItem value="active">
                {t("academic.programs.filterActive", { defaultValue: "Solo activos" })}
              </SelectItem>
              <SelectItem value="inactive">
                {t("academic.programs.filterInactive", { defaultValue: "Solo inactivos" })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loadError ? (
          <ErrorState
            message={t("academic.programs.loadError")}
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="name" sort={sort} className="max-w-[260px]">{t("academic.programs.colName")}</SortableHead>
                  <SortableHead sortKey="code" sort={sort} className="hidden sm:table-cell w-24">{t("academic.programs.colCode")}</SortableHead>
                  <SortableHead sortKey="faculty" sort={sort} className="hidden md:table-cell">{t("academic.programs.colFaculty")}</SortableHead>
                  <SortableHead sortKey="active" sort={sort} className="w-24">{t("academic.programs.colActive")}</SortableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Carga inicial / reintento: skeleton con el shape de la
                    tabla (no un "Cargando…" pelado sobre un área vacía). */}
                {loading ? (
                  <TableSkeleton rows={5} cols={5} />
                ) : sort.sorted.length === 0 ? (
                  (() => {
                    // Distinguir "no hay programas" de "los filtros no matchean":
                    // sin esto el admin cree que se le borraron los datos.
                    const noMatch =
                      rows.length > 0 && (!!search.trim() || activeFilter !== "all");
                    return (
                      <TableEmpty
                        colSpan={5}
                        text={noMatch ? t("common.noResults") : t("academic.programs.empty")}
                        hint={
                          noMatch
                            ? t("common.tryClearFilter")
                            : t("academic.programs.emptyHint")
                        }
                      />
                    );
                  })()
                ) : (
                  pagination.paginatedItems.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        <div className="truncate" title={r.name}>
                          {r.name}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                        {r.code ?? "—"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground" truncate title={r.faculty ?? undefined}>
                        {r.faculty ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={r.active}
                            disabled={togglingId !== null}
                            onCheckedChange={() => void toggleActive(r)}
                          />
                          {/* Spinner mientras el UPDATE vuela: el Switch
                              deshabilitado solo no comunica "está guardando". */}
                          {togglingId === r.id && <Spinner size="xs" />}
                          {!r.active && (
                            <Badge variant="outline" className="text-[10px]">
                              {t("academic.programs.inactiveBadge")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            { label: t("academic.programs.actionEdit"), icon: Pencil, onClick: () => openEdit(r) },
                            { label: t("common.duplicate"), icon: Copy, onClick: () => duplicate(r) },
                            {
                              label: t("academic.programs.actionDelete"),
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
                              disabled: deletingId !== null,
                              hint:
                                deletingId !== null
                                  ? t("common.processing", { defaultValue: "Procesando…" })
                                  : undefined,
                              onClick: () => void remove(r),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {!loading && !loadError && sort.sorted.length > 0 && (
          <DataPagination
            state={pagination}
            entityNamePlural={t("academic.programs.entityPlural", {
              defaultValue: "programas",
            })}
          />
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={dirty.guardOpenChange(setOpen)}>
        {/* DialogContent del design system ya maneja: width responsive,
            max-h-[calc(100dvh-2rem)] + overflow-y-auto, y DialogFooter es
            sticky bottom-0 con bg + border-t. No hace falta añadir
            flex/scroll propio — solo personalizamos el max-width. */}
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft.id ? t("academic.programs.editTitle") : t("academic.programs.createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label required>{t("academic.programs.labelName")}</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("hc_modulesAdminAdminAcademicProgramsPanel.placeholderName")}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("academic.programs.labelCode")}</Label>
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder={t("hc_modulesAdminAdminAcademicProgramsPanel.placeholderCode")}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("academic.programs.labelFaculty")}</Label>
              <Input
                value={draft.faculty}
                onChange={(e) => setDraft({ ...draft, faculty: e.target.value })}
                placeholder={t("hc_modulesAdminAdminAcademicProgramsPanel.placeholderFaculty")}
              />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Switch
                checked={draft.active}
                onCheckedChange={(v) => setDraft({ ...draft, active: v })}
              />
              <Label className="text-sm">{t("academic.programs.activeLabel")}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {t("academic.programs.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Spinner size="sm" className="mr-2" />}
              {saving ? t("academic.programs.saving") : draft.id ? t("academic.programs.saveChanges") : t("academic.programs.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
