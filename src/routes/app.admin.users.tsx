import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { HelpHint } from "@/components/ui/help-hint";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BadgeOverflow } from "@/components/ui/badge-overflow";
import { TenantQuotaCard } from "@/modules/tenants/TenantQuotaCard";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Users as UsersIcon, Eye } from "lucide-react";
import { DateCell } from "@/components/ui/date-cell";
import { startImpersonate } from "@/modules/admin/impersonation";
import { Spinner } from "@/components/ui/spinner";
import { toCSV } from "@/shared/lib/csv";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { useTranslation } from "react-i18next";
import { extractEdgeError } from "@/shared/lib/edge-error";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";

export const Route = createFileRoute("/app/admin/users")({ component: AdminUsers });

type StudentEstado = "activo" | "retirado" | "graduado" | "aplazado";

type Row = {
  id: string;
  full_name: string;
  institutional_email: string;
  personal_email: string | null;
  roles: AppRole[];
  // Identidad estudiantil (opcionales, solo tienen sentido para
  // usuarios con rol Estudiante; quedan null para Admin/Docente).
  codigo: string | null;
  documento: string | null;
  cohorte: string | null;
  estado: StudentEstado | null;
  programa_id: string | null;
  /** Tenant del usuario (Fase 1 multi-tenant). Para Admin viene siempre
   *  el suyo (RLS filtra); para SuperAdmin viene cross-tenant. */
  tenant_id: string | null;
  /** Fecha de creación del profile (replica de auth.users.created_at). */
  created_at: string | null;
  /** Último sign-in. Sincronizado por trigger desde auth.users
   *  (migración 20260715000000). null si nunca inició sesión. */
  last_sign_in_at: string | null;
};

const ALL_ROLES: AppRole[] = ["Admin", "Docente", "Estudiante", "SuperAdmin"];

const ESTADO_OPTIONS: Array<{ value: StudentEstado; label: string }> = [
  { value: "activo", label: "Activo" },
  { value: "retirado", label: "Retirado" },
  { value: "graduado", label: "Graduado" },
  { value: "aplazado", label: "Aplazado" },
];

const EMPTY_NEW: Row = {
  id: "",
  full_name: "",
  institutional_email: "",
  personal_email: "",
  roles: ["Estudiante"],
  codigo: null,
  documento: null,
  cohorte: null,
  estado: null,
  programa_id: null,
  tenant_id: null,
  // Sin profile aún: created_at lo asigna la DB en INSERT, last_sign_in_at
  // llega cuando el usuario inicia sesión (trigger desde auth.users).
  created_at: null,
  last_sign_in_at: null,
};

const USERS_TEMPLATE_CSV = toCSV([
  {
    full_name: "Juan Pérez",
    institutional_email: "juan.perez@institucion.edu",
    personal_email: "juan.perez@gmail.com",
    password: "Temporal#123",
    roles: "Estudiante",
    course_name: "Programación II",
  },
]);

function AdminUsers() {
  const { t } = useTranslation();
  const { roles, profile } = useAuth();
  const activeRole = useActiveRole();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [password, setPassword] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Programas activos para el dropdown de identidad estudiantil.
  // Se cargan en `load` junto con los perfiles.
  const [programs, setPrograms] = useState<Array<{ id: string; name: string }>>([]);
  // Tenants visibles para el caller. Solo el SuperAdmin ve TODAS las
  // instituciones (via RLS); el Admin normal solo ve la suya. Para el
  // SuperAdmin exponemos un filtro de institución arriba del grid (ver
  // `showTenantUI`) para acotar la vista cross-tenant.
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  // El filtro de institución solo debe aparecer cuando el usuario está
  // ACTIVAMENTE actuando como SuperAdmin (no por solo tener el rol). Un
  // usuario con SuperAdmin + Admin que cambia a Admin con el role-switcher
  // ya no quiere ver el dropdown cross-tenant: en ese caso opera dentro
  // de SU institución como cualquier Admin.
  const isSuperAdminCaller = activeRole === "SuperAdmin";
  // Mostrar el filtro + columna "Institución" cuando el caller es
  // SuperAdmin y hay al menos una institución cargada. Antes el umbral
  // era `> 1` (escondíamos el filtro con un solo tenant para no mostrar
  // un dropdown de 1 opción), pero el SuperAdmin pidió poder filtrar
  // siempre — útil incluso con 1 institución para confirmar el alcance,
  // y queda listo al crecer. El Admin normal nunca lo ve
  // (isSuperAdminCaller=false).
  const showTenantUI = isSuperAdminCaller && tenants.length > 0;
  // Tenant del Admin actual — necesario para auto-asignar nuevos usuarios
  // a SU institución cuando el SuperAdmin no eligió otra. Lo guardamos en
  // un ref para no re-renderizar cada vez que cambia, y lo populamos al
  // cargar el primer profile del Admin.
  const myTenantIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (profile?.tenant_id) myTenantIdRef.current = profile.tenant_id;
  }, [profile?.tenant_id]);
  const confirm = useConfirm();
  // Filtramos por nombre + ambos correos + rol. case-insensitive,
  // includes (no prefix). Cualquier match en cualquier campo cuenta —
  // los admins suelen buscar por nombre parcial o pedazo de email
  // (dominio, prefijo) sin recordar el campo exacto.
  // SuperAdmin: el filtro por tenant ya se aplica a la query en `load`
  // (re-corre cuando tenantFilter cambia). Aquí solo dejamos el filtro
  // por search, que necesita ser en memoria para responder rápido a cada
  // tecla sin re-pegarle a la DB.
  const filteredRows = useMemo(() => {
    let out = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) =>
          r.full_name.toLowerCase().includes(q) ||
          r.institutional_email.toLowerCase().includes(q) ||
          (r.personal_email?.toLowerCase().includes(q) ?? false) ||
          r.roles.some((role) => role.toLowerCase().includes(q)),
      );
    }
    return out;
  }, [rows, search]);
  // El multi-select trabaja sobre la lista visible. Si seleccioné todo
  // con un filtro activo, "seleccionar todos" se refiere a lo filtrado.
  const sel = useMultiSelect(filteredRows);

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

  const handleImpersonate = async (r: Row) => {
    if (r.roles.includes("Admin")) {
      toast.error("No se puede impersonar a otro administrador");
      return;
    }
    const ok = await confirm({
      title: `¿Iniciar sesión como ${r.full_name}?`,
      description:
        "Vas a entrar a la plataforma con la cuenta de este usuario. Verás todo lo que él ve. " +
        "Mientras estés impersonando, aparecerá un banner amarillo arriba con el botón 'Volver a mi cuenta'. " +
        "La acción queda registrada en el log de auditoría.",
      confirmLabel: "Iniciar como",
      tone: "warning",
    });
    if (!ok) return;
    try {
      await startImpersonate(r.id);
      // startImpersonate dispara window.location.href → no llegamos aquí.
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al iniciar la impersonación");
    }
  };

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    // SuperAdmin con filtro de institución activo: aplicamos
    // `.eq('tenant_id', X)` a la query. Antes el filtro era puramente en
    // memoria — funcionaba pero traía TODO el dataset cross-tenant. Ahora
    // es funcional: el dataset llega ya filtrado por la institución
    // elegida. Para "Todas" mantenemos el comportamiento original (sin
    // restricción adicional; la RLS de SuperAdmin permite cross-tenant).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from("profiles").select("*").order("full_name");
    if (isSuperAdminCaller && tenantFilter !== "all") {
      q = q.eq("tenant_id", tenantFilter);
    }
    const { data: profs, error: profsErr } = await q;
    if (profsErr) {
      setLoadError(friendlyError(profsErr, "No pudimos cargar la lista de usuarios."));
      setLoading(false);
      return;
    }
    const { data: rs } = await supabase.from("user_roles").select("user_id, role");
    const grouped = new Map<string, AppRole[]>();
    (rs ?? []).forEach((r: any) => {
      const arr = grouped.get(r.user_id) ?? [];
      arr.push(r.role);
      grouped.set(r.user_id, arr);
    });
    setRows((profs ?? []).map((p: any) => ({ ...p, roles: grouped.get(p.id) ?? [] })));
    // Programas activos (best-effort — si la migración no se aplicó, el
    // dropdown queda vacío pero el form no se rompe: programa_id es opcional).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: progs } = await (supabase as any)
      .from("academic_programs")
      .select("id, name")
      .eq("active", true)
      .order("name");
    setPrograms((progs ?? []) as Array<{ id: string; name: string }>);
    // Tenants visibles (RLS-filtrado): Admin ve solo el suyo; SuperAdmin
    // ve todos. Solo expone el filtro cuando hay >1 institución cargada.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tens } = await (supabase as any)
      .from("tenants")
      .select("id, slug, name")
      .order("name");
    setTenants((tens ?? []) as Array<{ id: string; slug: string; name: string }>);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // SuperAdmin: cuando cambia el filtro de institución, recargamos la
    // query con `.eq('tenant_id', X)` aplicado. Para Admin normal el
    // filtro no se renderiza, así que tenantFilter queda en 'all'
    // permanente y este effect corre solo una vez al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantFilter]);

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
      // Cast: el tipo regenerado de supabase aún no incluye 'SuperAdmin'
      // en el enum app_role (Lovable lo regenera en el próximo Publish).
      // El INSERT igual funciona en server-side porque el enum ya tiene
      // el valor desde la migración 20260621.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from("user_roles")
        .insert(toAdd.map((role) => ({ user_id: userId, role })));
      if (error) {
        toast.error(friendlyError(error));
        return false;
      }
    }
    if (toRemove.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from("user_roles")
        .delete()
        .eq("user_id", userId)
        .in("role", toRemove);
      if (error) {
        toast.error(friendlyError(error));
        return false;
      }
    }
    // Auditoría — solo si hubo cambios reales. Privilege escalation
    // (Admin/Docente añadido o removido) lo elevamos a `warning` por
    // ser un cambio sensible.
    if (toAdd.length || toRemove.length) {
      const target = rows.find((r) => r.id === userId);
      const sensitive = [...toAdd, ...toRemove].some((r) => r === "Admin" || r === "Docente");
      void logEvent({
        action: "user.roles_updated",
        category: "user",
        severity: sensitive ? "warning" : "info",
        entityType: "user",
        entityId: userId,
        entityName: target?.full_name ?? target?.institutional_email ?? null,
        metadata: {
          before: [...currentSet],
          after: newRoles,
          added: toAdd,
          removed: toRemove,
        },
      });
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

  /** Validación proactiva de unicidad — antes de mandar el form al
   *  backend. Llama al RPC `check_email_taken` (case-insensitive,
   *  excluyendo al propio usuario en modo edit). Retorna true si
   *  algún email del form colisiona con otro usuario; el caller debe
   *  abortar y mostrar el toast correspondiente. */
  const validateEmailUniqueness = async (
    institutional: string,
    personal: string,
    excludeUserId: string | null,
  ): Promise<boolean> => {
    const check = async (email: string, kind: "institutional" | "personal") => {
      const clean = email.trim().toLowerCase();
      if (!clean) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("check_email_taken", {
        p_email: clean,
        p_exclude_user_id: excludeUserId,
      });
      if (error) {
        console.warn("[admin.users] check_email_taken failed:", error.message);
        return false; // fallback al constraint UNIQUE de DB
      }
      if (data === true) {
        toast.error(
          kind === "institutional"
            ? `El email institucional "${clean}" ya está en uso por otro usuario.`
            : `El email personal "${clean}" ya está en uso por otro usuario.`,
        );
        return true;
      }
      return false;
    };
    if (await check(institutional, "institutional")) return true;
    if (await check(personal, "personal")) return true;
    return false;
  };

  const saveProfile = async () => {
    if (!editing) return;
    if (!editing.full_name.trim() || !editing.institutional_email.trim()) {
      toast.error("Nombre y email institucional son requeridos");
      return;
    }
    setSavingUser(true);
    try {
      // Validación proactiva de unicidad — antes de tocar DB. En modo
      // edit pasamos editing.id como exclude para que no choque con el
      // propio usuario.
      if (
        await validateEmailUniqueness(
          editing.institutional_email,
          editing.personal_email ?? "",
          editing.id || null,
        )
      ) {
        return;
      }
      if (editing.id) {
        // Update profile
        // Identidad estudiantil — solo se persiste para usuarios con rol
        // Estudiante. Para Admin/Docente forzamos NULL aunque el form
        // hubiese tenido valores (mejor pisarlos que dejar inconsistencia).
        const isStudent = editing.roles.includes("Estudiante");
        // SuperAdmin puede reasignar tenant en edit (sujeto al trigger
        // tg_check_profile_tenant_change que bloquea si el user tiene
        // cursos activos en el tenant viejo). Admin no lo toca.
        const updatePayload: Record<string, unknown> = {
          full_name: editing.full_name,
          personal_email: editing.personal_email || null,
          institutional_email: editing.institutional_email,
          codigo: isStudent ? editing.codigo?.trim() || null : null,
          documento: isStudent ? editing.documento?.trim() || null : null,
          cohorte: isStudent ? editing.cohorte?.trim() || null : null,
          estado: isStudent ? editing.estado || null : null,
          programa_id: isStudent ? editing.programa_id || null : null,
        };
        if (isSuperAdminCaller && editing.tenant_id) {
          updatePayload.tenant_id = editing.tenant_id;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from("profiles")
          .update(updatePayload)
          .eq("id", editing.id);
        if (error) {
          toast.error(friendlyError(error));
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
          if (pwErr || pwRes?.error) {
            const detail = await extractEdgeError(pwErr, pwRes);
            toast.error(detail || "Error al actualizar la contraseña");
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
          const detail = await extractEdgeError(error, data);
          toast.error(detail || "Error en importación");
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
        // Asignación de tenant al nuevo profile:
        //   - SuperAdmin elige institución en el form (editing.tenant_id).
        //   - Admin: si editing.tenant_id viene null/vacío, se asigna a SU
        //     tenant (los Admin solo crean usuarios para su institución).
        //   - El trigger handle_new_user ya creó el profile con tenant
        //     default; ahora lo ajustamos.
        const newUserId = (result as { userId?: string })?.userId;
        const targetTenantId =
          editing.tenant_id || (isSuperAdminCaller ? null : myTenantIdRef.current);
        if (newUserId && targetTenantId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: tErr } = await (supabase as any)
            .from("profiles")
            .update({ tenant_id: targetTenantId })
            .eq("id", newUserId);
          if (tErr) {
            console.warn("[admin.users] tenant assign failed:", tErr.message);
            // No bloqueamos: el usuario quedó creado, solo le falta el tenant
            // correcto. Toast warning para que el admin lo arregle desde el edit.
            toast.warning(
              "Usuario creado, pero no se pudo asignar a la institución. Edítalo y guarda de nuevo.",
            );
          }
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
      toast.error(friendlyError(rolesErr));
      return;
    }
    const { error } = await supabase.from("profiles").delete().eq("id", r.id);
    if (error) {
      toast.error(friendlyError(error));
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

  const exportUsersCsv = (): string => {
    const data = rows.map((r) => ({
      full_name: r.full_name,
      institutional_email: r.institutional_email,
      personal_email: r.personal_email ?? "",
      roles: r.roles.join("|"),
    }));
    return toCSV(data);
  };

  const handleImportRows = async (parsed: Record<string, string>[]): Promise<string> => {
    setImporting(true);
    try {
      const { data, error } = await supabase.functions.invoke("bulk-import-users", {
        body: { rows: parsed },
      });
      if (error) {
        const detail = await extractEdgeError(error, data);
        throw new Error(detail || "Error en importación masiva");
      }
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
      // Devolvemos "" para evitar el toast.success genérico de
      // ImportExportMenu — ya tosteamos success/warning con detalle.
      return "";
    } finally {
      setImporting(false);
    }
  };

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<UsersIcon className="h-6 w-6" />} title="Usuarios" />
        <ErrorState
          message="No pudimos cargar la lista de usuarios"
          hint={loadError}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<UsersIcon className="h-6 w-6" />}
        title="Usuarios"
        subtitle={
          search.trim()
            ? `${filteredRows.length} de ${rows.length} cuentas`
            : `${rows.length} cuentas registradas`
        }
        actions={
          <>
            <ImportExportMenu
              resourceName="usuarios"
              templateCsv={USERS_TEMPLATE_CSV}
              onExport={exportUsersCsv}
              onImport={handleImportRows}
              disabled={importing}
            />
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" />
              <span className="hidden xs:inline">Nuevo usuario</span>
              <span className="xs:hidden">Nuevo</span>
            </Button>
          </>
        }
      />

      {/* Licencias del tenant — el componente tiene su propio gate
          interno: se auto-oculta cuando es SuperAdmin sin override
          (modo cross-tenant). Cuando SuperAdmin tiene "Ver como X"
          activo, las cuotas SÍ se muestran (las de ese tenant elegido).
          Antes había un guard manual `{!isSuperAdminCaller && ...}`
          que escondía el card en ambos casos — quitado para que ahora
          aparezca correctamente cuando el SuperAdmin está overrideado. */}
      <TenantQuotaCard compact title="Licencias de usuarios" />

      <div className="flex flex-col sm:flex-row gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Buscar por nombre, correo o rol…"
          className="flex-1"
        />
        {/* Filtro de institución — visible para el SuperAdmin siempre que
            haya tenants cargados. Admin normal no lo ve. */}
        {showTenantUI && (
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            <SelectTrigger className="sm:w-64">
              <SelectValue placeholder={t("tenant.filterAllTenants")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("tenant.filterAllTenants")}</SelectItem>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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
              {/* table-fixed: emails y nombres largos truncan. */}
              <Table fixed resizable>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <MultiSelectHeaderCheckbox state={sel} />
                    </TableHead>
                    <TableHead className="max-w-[260px]">{t("users.fullName")}</TableHead>
                    <TableHead className="hidden sm:table-cell max-w-[260px]">
                      {t("users.institutionalEmail")}
                    </TableHead>
                    <TableHead className="hidden md:table-cell">
                      {t("users.personalEmail")}
                    </TableHead>
                    <TableHead className="hidden xs:table-cell w-40">{t("common.roles")}</TableHead>
                    {/* Columna Institución solo visible al SuperAdmin.
                        Para el Admin normal es siempre su tenant
                        (redundante). */}
                    {showTenantUI && (
                      <TableHead className="hidden lg:table-cell w-40">Institución</TableHead>
                    )}
                    {/* Fecha de creación + último acceso. Ocultas hasta xl
                        porque la tabla ya carga muchas columnas; en mobile
                        no aportan vs nombre/email. Sin íconos para no
                        recargar la cabecera. */}
                    <TableHead className="hidden xl:table-cell w-28">Creado</TableHead>
                    <TableHead className="hidden xl:table-cell w-32">Último acceso</TableHead>
                    <TableHead className="text-right w-20">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.length === 0 && (
                    <TableEmpty
                      colSpan={showTenantUI ? 9 : 8}
                      icon={UsersIcon}
                      text={
                        search.trim() && rows.length > 0
                          ? "Sin coincidencias"
                          : t("users.emptyTitle")
                      }
                      hint={
                        search.trim() && rows.length > 0
                          ? "Ajusta el buscador para ver más resultados."
                          : t("users.emptyHint")
                      }
                      action={
                        search.trim() && rows.length > 0 ? undefined : (
                          <Button size="sm" onClick={openNew}>
                            <Plus className="h-4 w-4 mr-1" />
                            {t("users.newUser")}
                          </Button>
                        )
                      }
                    />
                  )}
                  {filteredRows.map((r) => (
                    <TableRow key={r.id} data-state={sel.isSelected(r.id) ? "selected" : undefined}>
                      <TableCell className="w-10">
                        <MultiSelectCheckbox id={r.id} state={sel} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex flex-col gap-1 min-w-0">
                          <span className="truncate" title={r.full_name}>
                            {r.full_name}
                          </span>
                          <span className="text-xs text-muted-foreground sm:hidden truncate">
                            {r.institutional_email}
                          </span>
                          <div className="sm:hidden">
                            <BadgeOverflow items={r.roles} max={2} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell
                        className="text-sm hidden sm:table-cell"
                        title={r.institutional_email}
                      >
                        <div className="truncate">{r.institutional_email}</div>
                      </TableCell>
                      <TableCell
                        className="text-sm text-muted-foreground hidden md:table-cell"
                        title={r.personal_email ?? undefined}
                      >
                        <div className="truncate">{r.personal_email ?? "—"}</div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <BadgeOverflow items={r.roles} max={2} />
                      </TableCell>
                      {showTenantUI && (
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                          {tenants.find((t) => t.id === r.tenant_id)?.name ?? "—"}
                        </TableCell>
                      )}
                      <TableCell className="hidden xl:table-cell text-xs">
                        <DateCell value={r.created_at} variant="date" />
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-xs">
                        <DateCell value={r.last_sign_in_at} variant="datetime" />
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            {
                              label: t("common.edit"),
                              icon: Pencil,
                              onClick: () => openEdit(r),
                            },
                            // "Iniciar como" — solo disponible para targets
                            // que no son Admin (escalación lateral prohibida
                            // server-side también). El propio admin no se ve
                            // a sí mismo en la lista de "iniciar como".
                            !r.roles.includes("Admin") && {
                              label: "Iniciar como",
                              icon: Eye,
                              hint: `Acceder a la plataforma como ${r.full_name}`,
                              onClick: () => void handleImpersonate(r),
                              // Pinta el ícono con el primary del tenant
                              // actual (ya aplicado al theme via
                              // TenantThemeProvider) — visualiza que la
                              // impersonación se queda dentro de la
                              // institución.
                              iconColor: "var(--brand-primary)",
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
                  {ALL_ROLES
                    // Sólo SuperAdmin puede asignar/quitar el rol
                    // SuperAdmin a otro usuario. El edge function +
                    // RLS validan esto server-side; aquí ocultamos el
                    // checkbox para que un Admin común no vea siquiera
                    // la opción.
                    .filter((role) => role !== "SuperAdmin" || isSuperAdminCaller)
                    .map((role) => (
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

              {/* Institución — solo SuperAdmin elige. El Admin normal
                  no ve este campo y el usuario nuevo se asigna automá-
                  ticamente a SU tenant. Para usuarios EXISTENTES, el
                  SuperAdmin también puede reasignar (sujeto al trigger
                  tg_check_profile_tenant_change que bloquea si el user
                  tiene cursos activos en el tenant viejo). */}
              {isSuperAdminCaller && (
                <div>
                  <Label className="mb-2 block">Institución</Label>
                  <Select
                    value={editing.tenant_id ?? ""}
                    onValueChange={(v) => setEditing({ ...editing, tenant_id: v || null })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecciona institución…" />
                    </SelectTrigger>
                    <SelectContent>
                      {tenants.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    El SuperAdmin puede asignar el usuario a cualquier institución.
                    {editing.id &&
                      " Cambiar el valor falla si el usuario ya tiene cursos en la institución actual."}
                  </p>
                </div>
              )}

              {/* Identidad estudiantil — solo visible cuando el usuario
                  tiene rol Estudiante. Todos los campos son opcionales
                  pero recomendados: alimentan actas, certificados con
                  datos oficiales y el roster del Acuerdo Pedagógico. */}
              {editing.roles.includes("Estudiante") && (
                <div className="rounded-md border p-3 space-y-3">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    Identidad estudiantil
                    <HelpHint>
                      Datos institucionales que aparecen en actas y certificados oficiales. Todos
                      opcionales, pero recomendados.
                    </HelpHint>
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Código estudiantil</Label>
                      <Input
                        value={editing.codigo ?? ""}
                        onChange={(e) => setEditing({ ...editing, codigo: e.target.value || null })}
                        placeholder="Ej: 202412345"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Documento de identidad</Label>
                      <Input
                        value={editing.documento ?? ""}
                        onChange={(e) =>
                          setEditing({ ...editing, documento: e.target.value || null })
                        }
                        placeholder="Cédula / pasaporte"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Cohorte</Label>
                      <Input
                        value={editing.cohorte ?? ""}
                        onChange={(e) =>
                          setEditing({ ...editing, cohorte: e.target.value || null })
                        }
                        placeholder="Ej: 2024-1"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Estado</Label>
                      <Select
                        value={editing.estado ?? "__none__"}
                        onValueChange={(v) =>
                          setEditing({
                            ...editing,
                            estado: v === "__none__" ? null : (v as StudentEstado),
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Sin estado" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sin estado</SelectItem>
                          {ESTADO_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="sm:col-span-2">
                      <Label className="text-xs">Programa académico</Label>
                      <Select
                        value={editing.programa_id ?? "__none__"}
                        onValueChange={(v) =>
                          setEditing({
                            ...editing,
                            programa_id: v === "__none__" ? null : v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Sin programa" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sin programa</SelectItem>
                          {programs.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={savingUser}>
              Cancelar
            </Button>
            <Button onClick={saveProfile} disabled={savingUser}>
              {savingUser && <Spinner size="md" className="mr-1" />}
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
