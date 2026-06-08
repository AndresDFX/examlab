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
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ErrorState, TableEmpty } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import {
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
import { GraduationCap, Plus, Pencil, Trash2 } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";
import i18n from "@/i18n";

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

export function AdminAcademicProgramsPanel() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<AcademicProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("academic_programs")
      .select("id, name, code, faculty, active, created_at")
      .order("name");
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar los programas académicos."));
      setLoading(false);
      return;
    }
    setRows((data ?? []) as AcademicProgram[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

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

  const save = async () => {
    if (!user) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error(i18n.t("toast.modules_admin_AdminAcademicProgramsPanel.nameRequired", { defaultValue: "El nombre es obligatorio" }));
      return;
    }
    setSaving(true);
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
    setSaving(false);
    if (error) {
      toast.error(friendlyError(error, "No se pudo guardar el programa"));
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
        ? i18n.t("toast.modules_admin_AdminAcademicProgramsPanel.programUpdated", { defaultValue: "Programa actualizado" })
        : i18n.t("toast.modules_admin_AdminAcademicProgramsPanel.programCreated", { defaultValue: "Programa creado" }),
    );
    setOpen(false);
    void load();
  };

  const toggleActive = async (r: AcademicProgram) => {
    setTogglingId(r.id);
    const next = !r.active;
    const { error } = await db
      .from("academic_programs")
      .update({ active: next })
      .eq("id", r.id);
    setTogglingId(null);
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
  };

  const remove = async (r: AcademicProgram) => {
    const ok = await confirm({
      title: `¿Eliminar "${r.name}"?`,
      description:
        "Los cursos asociados quedarán sin programa (program_id NULL); no se borran. " +
        "Si solo quieres dejar de ofrecerlo, considera desactivarlo en lugar de eliminar. " +
        "Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
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
    toast.success(i18n.t("toast.modules_admin_AdminAcademicProgramsPanel.programDeleted", { defaultValue: "Programa eliminado" }));
    void load();
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-base flex items-center gap-2">
          <GraduationCap className="h-4 w-4 text-violet-500" />
          Programas / Niveles
        </CardTitle>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Nuevo programa
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          La unidad organizativa principal: carrera, programa, nivel educativo o área técnica
          según tu institución (ej. &quot;Ingeniería de Sistemas&quot;, &quot;Bachillerato Técnico&quot;,
          &quot;Educación Básica Primaria&quot;, &quot;Auxiliar Contable&quot;). Los cursos se
          asocian a un programa desde el formulario de cursos.
        </p>

        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando…
          </div>
        ) : loadError ? (
          <ErrorState
            message="No pudimos cargar"
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-[260px]">Nombre</TableHead>
                  <TableHead className="hidden sm:table-cell w-24">Código</TableHead>
                  <TableHead className="hidden md:table-cell">Área / Departamento</TableHead>
                  <TableHead className="w-24">Activo</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableEmpty
                    colSpan={5}
                    text="Sin programas registrados"
                    hint="Crea el primer programa con el botón de arriba."
                  />
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        <div className="truncate" title={r.name}>
                          {r.name}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                        {r.code ?? "—"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                        {r.faculty ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={r.active}
                            disabled={togglingId === r.id}
                            onCheckedChange={() => void toggleActive(r)}
                          />
                          {!r.active && (
                            <Badge variant="outline" className="text-[10px]">
                              inactivo
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            { label: "Editar", icon: Pencil, onClick: () => openEdit(r) },
                            {
                              label: "Eliminar",
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
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
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* DialogContent del design system ya maneja: width responsive,
            max-h-[calc(100dvh-2rem)] + overflow-y-auto, y DialogFooter es
            sticky bottom-0 con bg + border-t. No hace falta añadir
            flex/scroll propio — solo personalizamos el max-width. */}
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft.id ? "Editar programa" : "Nuevo programa"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label required>Nombre</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Ej: Ingeniería de Sistemas, Bachillerato, Auxiliar Contable"
              />
            </div>
            <div className="space-y-1">
              <Label>Código</Label>
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder="Ej: IS, BTC, AUX-CON"
              />
            </div>
            <div className="space-y-1">
              <Label>Área / Departamento</Label>
              <Input
                value={draft.faculty}
                onChange={(e) => setDraft({ ...draft, faculty: e.target.value })}
                placeholder="Ej: Facultad de Ingeniería, Sección Bachillerato, Área Técnica"
              />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Switch
                checked={draft.active}
                onCheckedChange={(v) => setDraft({ ...draft, active: v })}
              />
              <Label className="text-sm">Activo (aparece al crear cursos)</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Guardando…" : draft.id ? "Guardar cambios" : "Crear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
