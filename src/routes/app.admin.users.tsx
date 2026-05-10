import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { logEvent } from "@/lib/audit";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { HelpHint } from "@/components/ui/help-hint";
import { TableEmpty } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Upload, Download, Trash2, Pencil, Loader2, Users as UsersIcon } from "lucide-react";
import { downloadCSV, parseCSV, toCSV } from "@/lib/csv";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTranslation } from "react-i18next";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";

export const Route = createFileRoute("/app/admin/users")({ component: AdminUsers });

type Row = {
  id: string;
  full_name: string;
  institutional_email: string;
  personal_email: string | null;
  roles: AppRole[];
};

const ALL_ROLES: AppRole[] = ["Admin", "Docente", "Estudiante"];

const EMPTY_NEW: Row = {
  id: "",
  full_name: "",
  institutional_email: "",
  personal_email: "",
  roles: ["Estudiante"],
};

function AdminUsers() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Row | null>(null);
  const [password, setPassword] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const confirm = useConfirm();
  const sel = useMultiSelect(rows);

  const handleBulkDelete = async (ids: string[]) => {
    // Atomic batch — Postgres transaccional. Borramos roles primero
    // (FK), luego perfiles. Si alguno falla, ninguno se elimina.
    const { error: rolesErr } = await supabase.from("user_roles").delete().in("user_id", ids);
    if (rolesErr) throw new Error(rolesErr.message);
    const { error } = await supabase.from("profiles").delete().in("id", ids);
    if (error) throw new Error(error.message);
    void logEvent({
      action: "user.bulk_deleted",
      category: "user",
      severity: "warning",
      metadata: { count: ids.length, ids },
    });
    toast.success(`${ids.length} usuario(s) eliminado(s) correctamente`);
    sel.clear();
    load();
  };

  const selectedItems = useMemo(
    () =>
      rows
        .filter((r) => sel.isSelected(r.id))
        .map((r) => ({ id: r.id, label: `${r.full_name} (${r.institutional_email})` })),
    [rows, sel],
  );

  const isAdmin = roles.includes("Admin");

  const load = async () => {
    setLoading(true);
    const { data: profs } = await supabase.from("profiles").select("*").order("full_name");
    const { data: rs } = await supabase.from("user_roles").select("user_id, role");
    const grouped = new Map<string, AppRole[]>();
    (rs ?? []).forEach((r: any) => {
      const arr = grouped.get(r.user_id) ?? [];
      arr.push(r.role);
      grouped.set(r.user_id, arr);
    });
    setRows((profs ?? []).map((p: any) => ({ ...p, roles: grouped.get(p.id) ?? [] })));
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const saveRoles = async (userId: string, newRoles: AppRole[]) => {
    const { data: current } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    const currentSet = new Set((current ?? []).map((r: any) => r.role as AppRole));
    const newSet = new Set(newRoles);
    const toAdd = newRoles.filter((r) => !currentSet.has(r));
    const toRemove = [...currentSet].filter((r) => !newSet.has(r));
    if (toAdd.length) {
      const { error } = await supabase
        .from("user_roles")
        .insert(toAdd.map((role) => ({ user_id: userId, role })));
      if (error) {
        toast.error(error.message);
        return false;
      }
    }
    if (toRemove.length) {
      const { error } = await supabase
        .from("user_roles")
        .delete()
        .eq("user_id", userId)
        .in("role", toRemove);
      if (error) {
        toast.error(error.message);
        return false;
      }
    }
    return true;
  };

  const openNew = () => {
    setEditing({ ...EMPTY_NEW });
    setPassword("");
    setDialogOpen(true);
  };

  const openEdit = (r: Row) => {
    setEditing({ ...r });
    setPassword("");
    setDialogOpen(true);
  };

  const saveProfile = async () => {
    if (!editing) return;
    if (!editing.full_name.trim() || !editing.institutional_email.trim()) {
      toast.error("Nombre y email institucional son requeridos");
      return;
    }
    setSavingUser(true);
    try {
      if (editing.id) {
        // Update profile
        const { error } = await supabase
          .from("profiles")
          .update({
            full_name: editing.full_name,
            personal_email: editing.personal_email || null,
            institutional_email: editing.institutional_email,
          })
          .eq("id", editing.id);
        if (error) {
          toast.error(error.message);
          return;
        }
        const ok = await saveRoles(editing.id, editing.roles);
        if (!ok) return;
        // Update password if provided
        if (password.trim()) {
          if (password.length < 8) {
            toast.error("La contraseña debe tener al menos 8 caracteres");
            return;
          }
          const { data: pwRes, error: pwErr } = await supabase.functions.invoke(
            "admin-update-password",
            {
              body: { userId: editing.id, newPassword: password },
            },
          );
          // supabase.functions.invoke returns FunctionsHttpError on non-2xx; the
          // server's JSON body is on error.context (a Response). Parse it so we
          // surface the real validation message instead of a generic edge error.
          if (pwErr) {
            let serverMsg = pwErr.message;
            const ctx = (pwErr as any).context;
            if (ctx && typeof ctx.json === "function") {
              try {
                const body = await ctx.json();
                if (body?.error) serverMsg = body.error;
              } catch {
                /* ignore */
              }
            }
            toast.error(serverMsg);
            return;
          }
          if (pwRes?.error) {
            toast.error(pwRes.error);
            return;
          }
        }
        toast.success(
          password.trim()
            ? "Usuario actualizado correctamente (contraseña incluida)"
            : "Usuario actualizado correctamente",
        );
        void logEvent({
          action: "user.updated",
          category: "user",
          actorRole: roles[0],
          entityType: "user",
          entityId: editing.id,
          entityName: editing.full_name,
          metadata: { roles: editing.roles },
        });
      } else {
        // Create via bulk-import (single row)
        if (!password || password.length < 8) {
          toast.error("Contraseña requerida (mínimo 8 caracteres)");
          return;
        }
        const { data, error } = await supabase.functions.invoke("bulk-import-users", {
          body: {
            rows: [
              {
                full_name: editing.full_name,
                institutional_email: editing.institutional_email,
                personal_email: editing.personal_email ?? "",
                password,
                roles: editing.roles.join("|"),
              },
            ],
          },
        });
        if (error) {
          toast.error(error.message);
          return;
        }
        const result = (data?.result ?? [])[0];
        if (!result?.ok) {
          if (result?.duplicate) {
            toast.error(
              `No se pudo crear: ya existe un usuario con el email "${editing.institutional_email}"`,
            );
          } else {
            toast.error(result?.error ?? result?.reason ?? "Error al crear usuario");
          }
          return;
        }
        toast.success("Usuario creado correctamente");
        void logEvent({
          action: "user.created",
          category: "user",
          actorRole: roles[0],
          entityType: "user",
          entityName: editing.full_name,
          metadata: { roles: editing.roles, email: editing.institutional_email },
        });
      }
      setDialogOpen(false);
      setEditing(null);
      load();
    } finally {
      setSavingUser(false);
    }
  };

  const remove = async (r: Row) => {
    const ok = await confirm({
      title: t("users.deleteTitle", { name: r.full_name }),
      description: t("users.deleteBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error: rolesErr } = await supabase.from("user_roles").delete().eq("user_id", r.id);
    if (rolesErr) {
      toast.error(rolesErr.message);
      return;
    }
    const { error } = await supabase.from("profiles").delete().eq("id", r.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(t("users.deletedToast"));
    void logEvent({
      action: "user.deleted",
      category: "user",
      actorRole: roles[0],
      severity: "warning",
      entityType: "user",
      entityId: r.id,
      entityName: r.full_name,
      metadata: { email: r.institutional_email },
    });
    load();
  };

  const exportCSV = () => {
    const data = rows.map((r) => ({
      full_name: r.full_name,
      institutional_email: r.institutional_email,
      personal_email: r.personal_email ?? "",
      roles: r.roles.join("|"),
    }));
    downloadCSV(`usuarios-${Date.now()}.csv`, toCSV(data));
    toast.success("Archivo exportado correctamente");
  };

  const downloadTemplate = () => {
    const tmpl = toCSV([
      {
        full_name: "Juan Pérez",
        institutional_email: "juan.perez@institucion.edu",
        personal_email: "juan.perez@gmail.com",
        password: "Temporal#123",
        roles: "Estudiante",
        course_name: "Programación II",
      },
    ]);
    downloadCSV("template-usuarios.csv", tmpl);
    toast.success("Template descargado correctamente");
  };

  const onImport = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseCSV(text);
      const { data, error } = await supabase.functions.invoke("bulk-import-users", {
        body: { rows: parsed },
      });
      if (error) throw error;
      const results = (data.result ?? []) as Array<{
        email: string;
        ok: boolean;
        reason?: string;
        duplicate?: boolean;
      }>;
      const ok = results.filter((r) => r.ok).length;
      const duplicates = results.filter((r) => !r.ok && r.duplicate);
      const otherFails = results.filter((r) => !r.ok && !r.duplicate);

      if (duplicates.length === 0 && otherFails.length === 0) {
        toast.success(`Importados correctamente: ${ok}`);
      } else {
        toast.warning(
          `Importados: ${ok} · Duplicados: ${duplicates.length} · Errores: ${otherFails.length}`,
          {
            duration: 12000,
            description:
              duplicates.length > 0
                ? `Ya existían: ${duplicates
                    .slice(0, 5)
                    .map((d) => d.email)
                    .join(", ")}${duplicates.length > 5 ? ` y ${duplicates.length - 5} más` : ""}`
                : otherFails
                    .slice(0, 3)
                    .map((f) => `${f.email}: ${f.reason}`)
                    .join(" | "),
          },
        );
      }
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Error al importar");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usuarios</h1>
          <p className="text-sm text-muted-foreground">{rows.length} cuentas registradas</p>
        </div>
        <div className="flex gap-2 flex-wrap w-full sm:w-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={downloadTemplate}
            className="flex-1 sm:flex-none"
          >
            <Download className="h-4 w-4 mr-1" />
            <span className="hidden xs:inline">Template CSV</span>
            <span className="xs:hidden">Plantilla</span>
          </Button>
          <Button variant="outline" size="sm" onClick={exportCSV} className="flex-1 sm:flex-none">
            <Download className="h-4 w-4 mr-1" />
            Exportar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="flex-1 sm:flex-none"
          >
            {importing ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-1" />
            )}{" "}
            <span className="hidden xs:inline">Cargar CSV</span>
            <span className="xs:hidden">Cargar</span>
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
          />
          <Button size="sm" onClick={openNew} className="flex-1 sm:flex-none">
            <Plus className="h-4 w-4 mr-1" />
            <span className="hidden xs:inline">Nuevo usuario</span>
            <span className="xs:hidden">Nuevo</span>
          </Button>
        </div>
      </div>

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular="usuario"
        entityNamePlural="usuarios"
      />

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Cargando…</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <MultiSelectHeaderCheckbox state={sel} />
                    </TableHead>
                    <TableHead>{t("users.fullName")}</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      {t("users.institutionalEmail")}
                    </TableHead>
                    <TableHead className="hidden md:table-cell">
                      {t("users.personalEmail")}
                    </TableHead>
                    <TableHead className="hidden xs:table-cell">{t("common.roles")}</TableHead>
                    <TableHead className="text-right">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableEmpty
                      colSpan={6}
                      icon={UsersIcon}
                      text={t("users.emptyTitle")}
                      hint={t("users.emptyHint")}
                      action={
                        <Button size="sm" onClick={openNew}>
                          <Plus className="h-4 w-4 mr-1" />
                          {t("users.newUser")}
                        </Button>
                      }
                    />
                  )}
                  {rows.map((r) => (
                    <TableRow key={r.id} data-state={sel.isSelected(r.id) ? "selected" : undefined}>
                      <TableCell className="w-10">
                        <MultiSelectCheckbox id={r.id} state={sel} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex flex-col gap-1">
                          <span>{r.full_name}</span>
                          <span className="text-xs text-muted-foreground sm:hidden truncate max-w-[14rem]">
                            {r.institutional_email}
                          </span>
                          <div className="flex flex-wrap gap-1 sm:hidden">
                            {r.roles.map((role) => (
                              <Badge key={role} variant="secondary" className="text-[10px]">
                                {role}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm hidden sm:table-cell">
                        {r.institutional_email}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground hidden md:table-cell">
                        {r.personal_email ?? "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {r.roles.length === 0 && (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                          {r.roles.map((role) => (
                            <Badge key={role} variant="secondary" className="text-[10px]">
                              {role}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            {
                              label: t("common.edit"),
                              icon: Pencil,
                              onClick: () => openEdit(r),
                            },
                            {
                              label: t("common.delete"),
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
                              onClick: () => remove(r),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Editar" : "Nuevo"} usuario</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label required>Nombre completo</Label>
                <Input
                  value={editing.full_name}
                  onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                />
              </div>
              <div>
                <Label required>Email institucional</Label>
                <Input
                  type="email"
                  value={editing.institutional_email}
                  onChange={(e) => setEditing({ ...editing, institutional_email: e.target.value })}
                />
              </div>
              <div>
                <Label>Email personal</Label>
                <Input
                  type="email"
                  value={editing.personal_email ?? ""}
                  onChange={(e) => setEditing({ ...editing, personal_email: e.target.value })}
                />
              </div>
              {!editing.id && (
                <div>
                  <Label required>Contraseña inicial</Label>
                  <Input
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    El usuario podrá cambiarla después.
                  </p>
                </div>
              )}
              {editing.id && (
                <div>
                  <Label>
                    Nueva contraseña{" "}
                    <HelpHint>Déjalo vacío para no cambiar la contraseña actual.</HelpHint>
                  </Label>
                  <Input
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres"
                  />
                </div>
              )}
              <div>
                <Label className="mb-2 block" required>
                  Roles
                </Label>
                <div className="space-y-1.5">
                  {ALL_ROLES.map((role) => (
                    <label key={role} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={editing.roles.includes(role)}
                        onCheckedChange={(v) => {
                          setEditing({
                            ...editing,
                            roles: v
                              ? [...editing.roles, role]
                              : editing.roles.filter((x) => x !== role),
                          });
                        }}
                      />
                      {role}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={savingUser}>
              Cancelar
            </Button>
            <Button onClick={saveProfile} disabled={savingUser}>
              {savingUser && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedItems}
        entityNameSingular="usuario"
        entityNamePlural="usuarios"
        extraWarning="Se eliminarán los perfiles y todos sus roles. Las cuentas de autenticación NO se borran."
        onConfirm={handleBulkDelete}
      />
    </div>
  );
}
