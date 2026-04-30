import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Plus, Trash2, Pencil, Loader2 } from "lucide-react";
import { toCSV } from "@/lib/csv";
import { useConfirm } from "@/components/ConfirmDialog";
import { ImportExportMenu } from "@/components/ImportExportMenu";

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
  const { roles } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Row | null>(null);
  const [password, setPassword] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const confirm = useConfirm();

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
          if (pwErr) {
            toast.error(pwErr.message);
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
      title: `Eliminar a ${r.full_name}`,
      description:
        "Se eliminará el perfil y todos sus roles. La cuenta de autenticación no se borra.",
      confirmLabel: "Eliminar usuario",
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
    toast.success("Usuario eliminado correctamente");
    load();
  };

  const USERS_TEMPLATE = toCSV([
    {
      full_name: "Juan Pérez",
      institutional_email: "juan.perez@institucion.edu",
      personal_email: "juan.perez@gmail.com",
      password: "Temporal#123",
      roles: "Estudiante",
      course_name: "Programación II",
    },
  ]);

  const buildUsersCsv = () =>
    toCSV(
      rows.map((r) => ({
        full_name: r.full_name,
        institutional_email: r.institutional_email,
        personal_email: r.personal_email ?? "",
        roles: r.roles.join("|"),
      })),
    );

  const importUsers = async (parsed: Record<string, string>[]) => {
    setImporting(true);
    try {
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

      load();

      if (duplicates.length === 0 && otherFails.length === 0) {
        return `Importados correctamente: ${ok}`;
      }
      // Surface detail via toast.warning explicitly for richer formatting,
      // and return undefined so ImportExportMenu doesn't post its own success.
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
      return ` `; // truthy non-empty string skips default toast.success label
    } finally {
      setImporting(false);
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
          <ImportExportMenu
            label="Usuarios"
            resourceName="usuarios"
            templateCsv={USERS_TEMPLATE}
            onImport={importUsers}
            onExport={buildUsersCsv}
            disabled={importing}
          />
          <Button size="sm" onClick={openNew} className="flex-1 sm:flex-none">
            <Plus className="h-4 w-4 mr-1" />
            <span className="hidden xs:inline">Nuevo usuario</span>
            <span className="xs:hidden">Nuevo</span>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Cargando…</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nombre</TableHead>
                    <TableHead className="hidden sm:table-cell">Email institucional</TableHead>
                    <TableHead className="hidden md:table-cell">Email personal</TableHead>
                    <TableHead className="hidden xs:table-cell">Roles</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                        No hay usuarios.
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => (
                    <TableRow key={r.id}>
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
                      <TableCell className="text-sm hidden sm:table-cell">{r.institutional_email}</TableCell>
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
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEdit(r)}
                            title="Editar"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => remove(r)}
                            title="Eliminar"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
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
                <Label>Nombre completo</Label>
                <Input
                  value={editing.full_name}
                  onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                />
              </div>
              <div>
                <Label>Email institucional</Label>
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
                  <Label>Contraseña inicial</Label>
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
                    <span className="text-xs text-muted-foreground font-normal">
                      (dejar vacío para no cambiar)
                    </span>
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
                <Label className="mb-2 block">Roles</Label>
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
    </div>
  );
}
