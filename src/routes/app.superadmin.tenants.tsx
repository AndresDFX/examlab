/**
 * SuperAdmin: gestión de tenants (instituciones).
 *
 * Solo accesible para usuarios con rol SuperAdmin (Fase 1). Permite:
 *   - Crear nueva institución (slug, name, branding básico).
 *   - Editar campos de una institución existente.
 *   - Activar / pausar (is_active toggle).
 *   - "Ver como" — guarda override en localStorage y refresca useTenant.
 *
 * El SQL ya bloquea INSERT/UPDATE/DELETE a no-SuperAdmin via RLS de
 * la tabla tenants — así que aunque un user normal acceda a esta ruta
 * por manipulación de URL, RLS rechaza las operaciones.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { resizeImageForLogo } from "@/modules/tenants/image-resize";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HexColorInput } from "@/components/ui/hex-color-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { SectionLoader } from "@/components/ui/loaders";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Building2,
  Plus,
  Eye,
  Pencil,
  Power,
  Save,
  Upload,
  Trash2,
  UserPlus,
  LogIn,
  Copy,
  KeyRound,
} from "lucide-react";
import { startImpersonate } from "@/modules/admin/impersonation";
import { AssignUsersToTenantDialog } from "@/modules/superadmin/AssignUsersToTenantDialog";
import { isValidTenantSlug, slugifyTenantName } from "@/modules/tenants/tenant";
import { setTenantOverride } from "@/modules/tenants/use-tenant";
import type { Tenant } from "@/modules/tenants/tenant";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";

export const Route = createFileRoute("/app/superadmin/tenants")({
  component: SuperAdminTenantsPage,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

function SuperAdminTenantsPage() {
  const { roles, loading: authLoading } = useAuth();
  const confirm = useConfirm();
  const isSuper = roles.includes("SuperAdmin");

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [form, setForm] = useState({
    slug: "",
    name: "",
    logo_url: "",
    logo_path: "",
    primary_color: "",
    secondary_color: "",
    text_color: "",
    icon_color: "",
    email_domain: "",
    // Cuotas. "" = ilimitado (se persiste como NULL). Cualquier número
    // entero >= 0 es el tope.
    max_admins: "" as string,
    max_teachers: "" as string,
    max_students: "" as string,
  });
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  // Credenciales del usuario de prueba recién creado. Se muestran UNA
  // SOLA VEZ en un dialog separado tras crear la institución (la edge
  // function `provision-tenant-test-user` no las persiste en plaintext).
  // null = sin dialog abierto.
  const [testUserCreds, setTestUserCreds] = useState<{
    email: string;
    password: string;
    full_name: string;
    roles: string[];
    tenant_name: string;
  } | null>(null);
  const logoFileInputRef = useRef<HTMLInputElement>(null);
  // En modo CREAR no existe aún `tenant.id`, así que no se puede subir al
  // bucket todavía (el path es `${tenantId}/logo.ext`). Guardamos el File
  // en memoria + una preview con URL.createObjectURL, y el upload real se
  // hace dentro de `save()` después del INSERT, usando el id recién creado.
  const [pendingLogoFile, setPendingLogoFile] = useState<File | null>(null);
  const [pendingLogoPreview, setPendingLogoPreview] = useState<string | null>(null);
  /** Estado del dialog 'Gestionar usuarios' — el SuperAdmin decide qué
   *  usuarios pertenecen a este tenant (marca para agregar, desmarca
   *  para quitar). tenant=null = cerrado. */
  const [assignUsersTenant, setAssignUsersTenant] = useState<Tenant | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    // Filtramos las eliminadas (deleted_at IS NOT NULL) — viven en la
    // papelera (/app/trash) hasta su purga a 30d. El SuperAdmin las
    // restaura desde allí cuando hace falta.
    const { data, error } = await db
      .from("tenants")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar las instituciones."));
      setTenants([]);
    } else {
      setTenants((data ?? []) as Tenant[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (authLoading || !isSuper) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isSuper]);

  // Paginación client-side sobre el listado completo de tenants.
  const pagination = usePagination(tenants, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:superadmin_tenants",
    resetKey: "",
  });

  // Gate de rol — los no-SuperAdmin redirigen al dashboard.
  if (authLoading) return <SectionLoader text="Cargando…" />;
  if (!isSuper) {
    return <Navigate to="/app" />;
  }

  // Libera el blob URL del archivo pendiente. Si no se libera, el browser
  // mantiene el File vivo en memoria hasta el unload del tab.
  const clearPendingLogo = () => {
    if (pendingLogoPreview) URL.revokeObjectURL(pendingLogoPreview);
    setPendingLogoFile(null);
    setPendingLogoPreview(null);
  };

  const openCreate = () => {
    setEditing(null);
    clearPendingLogo();
    setForm({
      slug: "",
      name: "",
      logo_url: "",
      logo_path: "",
      primary_color: "",
      secondary_color: "",
      text_color: "",
      icon_color: "",
      email_domain: "",
      max_admins: "",
      max_teachers: "",
      max_students: "",
    });
    setDialogOpen(true);
  };

  const openEdit = (t: Tenant) => {
    setEditing(t);
    setForm({
      slug: t.slug,
      name: t.name,
      logo_url: t.logo_url ?? "",
      logo_path: t.logo_path ?? "",
      primary_color: t.primary_color ?? "",
      secondary_color: t.secondary_color ?? "",
      // text_color / icon_color: las columnas se agregaron en mig
      // 20260706000000; tipos generados de Supabase aún no las exponen.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text_color: ((t as any).text_color as string | null) ?? "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icon_color: ((t as any).icon_color as string | null) ?? "",
      email_domain: t.email_domain ?? "",
      max_admins: t.max_admins == null ? "" : String(t.max_admins),
      max_teachers: t.max_teachers == null ? "" : String(t.max_teachers),
      max_students: t.max_students == null ? "" : String(t.max_students),
    });
    setDialogOpen(true);
  };

  /**
   * SuperAdmin sube el logo de CUALQUIER institución. La RLS del bucket
   * permite a SuperAdmin escribir en `<tenant_id>/...` independiente del
   * `current_tenant_id()` del caller. Solo aplica en edit (necesitamos
   * `editing.id` para construir el path).
   */
  /** Valida tipo + tamaño. Devuelve null si inválido (con toast) o el
   *  mismo archivo si es válido. Compartido por modos crear y editar. */
  const validateLogoFile = (file: File): File | null => {
    const validTypes = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
    if (!validTypes.includes(file.type)) {
      toast.error("Formato no soportado. Usa PNG, JPG, SVG o WebP.");
      return null;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("El logo no puede pesar más de 2 MB.");
      return null;
    }
    return file;
  };

  /** Sube un File al bucket `tenant-logos` con path
   *  `${tenantId}/<slug-de-institucion>-logo.<ext>`. El folder DEBE ser
   *  el UUID (lo exige la RLS via `(storage.foldername(name))[1]`); el
   *  filename usa el nombre de la institución slugificado para que sea
   *  reconocible al inspeccionar el bucket / al descargar el archivo
   *  directo. Aplica resize antes. */
  const uploadLogoToBucket = async (file: File, tenantId: string): Promise<string | null> => {
    const { file: finalFile, resized, originalSize, finalSize } = await resizeImageForLogo(file);
    const ext =
      finalFile.type === "image/png"
        ? "png"
        : finalFile.type === "image/jpeg"
          ? "jpg"
          : finalFile.type === "image/svg+xml"
            ? "svg"
            : "webp";
    const slug = slugifyTenantName(form.name);
    const path = `${tenantId}/${slug}-logo.${ext}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase.storage as any)
      .from("tenant-logos")
      .upload(path, finalFile, { upsert: true, contentType: finalFile.type });
    if (upErr) {
      toast.error(friendlyError(upErr, "No se pudo subir el logo"));
      return null;
    }
    if (resized) {
      const kbBefore = Math.round(originalSize / 1024);
      const kbAfter = Math.round(finalSize / 1024);
      toast.success(`Logo subido (optimizado: ${kbBefore} KB → ${kbAfter} KB).`);
    }
    return path;
  };

  /**
   * Handler del input file. En MODO EDITAR sube inmediatamente al bucket
   * (ya hay `editing.id`). En MODO CREAR no hay tenant todavía, así que
   * solo validamos + stasheamos el File con una preview local — el upload
   * real lo hace `save()` después del INSERT del tenant.
   */
  const uploadLogo = async (file: File) => {
    const valid = validateLogoFile(file);
    if (!valid) return;

    if (!editing) {
      // Modo crear: stash + preview local.
      if (pendingLogoPreview) URL.revokeObjectURL(pendingLogoPreview);
      const preview = URL.createObjectURL(valid);
      setPendingLogoFile(valid);
      setPendingLogoPreview(preview);
      setForm((p) => ({ ...p, logo_url: "" }));
      if (logoFileInputRef.current) logoFileInputRef.current.value = "";
      toast.success("Logo listo. Se subirá al guardar la institución.");
      return;
    }

    // Modo editar: subimos al toque al bucket usando editing.id.
    setUploadingLogo(true);
    try {
      const path = await uploadLogoToBucket(valid, editing.id);
      if (path) {
        setForm((p) => ({ ...p, logo_path: path, logo_url: "" }));
        toast.success("Logo subido. Recuerda 'Guardar' para aplicarlo.");
      }
    } finally {
      setUploadingLogo(false);
      if (logoFileInputRef.current) logoFileInputRef.current.value = "";
    }
  };

  const removeLogo = () => {
    setForm((p) => ({ ...p, logo_path: "", logo_url: "" }));
    clearPendingLogo();
    toast.info("Logo removido.");
  };

  const save = async () => {
    if (!form.slug || !form.name) {
      toast.error("Slug y nombre son obligatorios.");
      return;
    }
    if (!isValidTenantSlug(form.slug)) {
      toast.error(
        "Slug inválido: usa minúsculas, números y guiones (3-50 chars). Ej: 'sena-bogota'.",
      );
      return;
    }
    setSaving(true);
    // Cuotas: "" → null (ilimitado). Cualquier otro → parseInt; rechazo
    // si no es entero >= 0.
    const parseQuota = (raw: string, label: string): number | null | undefined => {
      const v = raw.trim();
      if (!v) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        toast.error(`Cuota inválida para ${label}. Debe ser entero ≥ 0 (o vacío = ilimitado).`);
        return undefined; // sentinel = abort
      }
      return n;
    };
    const maxAdmins = parseQuota(form.max_admins, "administradores");
    const maxTeachers = parseQuota(form.max_teachers, "docentes");
    const maxStudents = parseQuota(form.max_students, "estudiantes");
    if (maxAdmins === undefined || maxTeachers === undefined || maxStudents === undefined) {
      setSaving(false);
      return;
    }

    const payload = {
      slug: form.slug.trim(),
      name: form.name.trim(),
      logo_url: form.logo_url.trim() || null,
      logo_path: form.logo_path.trim() || null,
      primary_color: form.primary_color.trim() || null,
      secondary_color: form.secondary_color.trim() || null,
      text_color: form.text_color.trim() || null,
      icon_color: form.icon_color.trim() || null,
      email_domain: form.email_domain.trim().toLowerCase() || null,
      max_admins: maxAdmins,
      max_teachers: maxTeachers,
      max_students: maxStudents,
    };
    if (editing) {
      const { error } = await db.from("tenants").update(payload).eq("id", editing.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo guardar"));
        setSaving(false);
        return;
      }
      toast.success("Institución actualizada");
    } else {
      // Modo crear: INSERT y nos quedamos con el id retornado, porque si
      // hay un `pendingLogoFile` necesitamos subirlo al bucket y luego
      // hacer un UPDATE con su path.
      const { data: created, error } = await db
        .from("tenants")
        .insert(payload)
        .select("id")
        .single();
      if (error) {
        toast.error(friendlyError(error, "No se pudo crear"));
        setSaving(false);
        return;
      }

      if (pendingLogoFile && created?.id) {
        const path = await uploadLogoToBucket(pendingLogoFile, created.id as string);
        if (path) {
          const { error: updErr } = await db
            .from("tenants")
            .update({ logo_path: path, logo_url: null })
            .eq("id", created.id);
          if (updErr) {
            // No abortamos: el tenant está creado, solo falló asociar el
            // logo. El SuperAdmin puede reintentar desde "Editar".
            toast.error(
              friendlyError(updErr, "Institución creada, pero no se pudo asociar el logo"),
            );
          }
        }
        clearPendingLogo();
      }
      toast.success("Institución creada");

      // Provisionar usuario de prueba (Admin + Docente + Estudiante).
      // Es best-effort: si falla, el tenant queda creado igual y el
      // SuperAdmin puede crear el user manualmente desde /app/admin/users.
      // Mostramos las credenciales en un dialog separado (la password
      // solo se entrega una vez — no se guarda en plaintext).
      if (created?.id) {
        try {
          const { data: provData, error: provErr } = await supabase.functions.invoke(
            "provision-tenant-test-user",
            {
              body: {
                tenant_id: created.id,
                tenant_name: form.name.trim(),
                tenant_slug: form.slug.trim(),
              },
            },
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = provData as any;
          if (provErr || !data?.ok) {
            const msg = data?.error || provErr?.message || "Error desconocido";
            toast.error(
              `Institución creada, pero falló crear usuario de prueba: ${msg}`,
              { duration: 8000 },
            );
          } else {
            setTestUserCreds({
              email: data.email,
              password: data.password,
              full_name: data.full_name,
              roles: data.roles ?? [],
              tenant_name: form.name.trim(),
            });
          }
        } catch (e) {
          toast.error(
            `Institución creada, pero falló crear usuario de prueba: ${
              e instanceof Error ? e.message : String(e)
            }`,
            { duration: 8000 },
          );
        }
      }
    }
    setSaving(false);
    setDialogOpen(false);
    await load();
  };

  const toggleActive = async (t: Tenant) => {
    const willDeactivate = t.is_active;
    if (willDeactivate) {
      const ok = await confirm({
        title: `Pausar ${t.name}`,
        description:
          "Los usuarios de esta institución no podrán acceder mientras esté pausada. Puedes reactivarla en cualquier momento.",
        confirmLabel: "Pausar",
        tone: "warning",
      });
      if (!ok) return;
    }
    const { error } = await db.from("tenants").update({ is_active: !t.is_active }).eq("id", t.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(willDeactivate ? "Institución pausada" : "Institución reactivada");
    await load();
  };

  // "Ver como X": setea el override en localStorage. `useTenant`
  // detecta el CustomEvent y re-fetch; el banner azul
  // `TenantOverrideBanner` muestra "Viendo como X". NO hace hard
  // reload — la UI se actualiza in-place. Toast informativo.
  const viewAs = (t: Tenant) => {
    setTenantOverride(t.slug);
    toast.success(`Viendo como: ${t.name}`);
  };

  // Limpia el override → modo cross-tenant. Mismo update in-place.
  const clearViewAs = () => {
    setTenantOverride(null);
    toast.success("Volviste al modo cross-tenant");
  };

  /**
   * Soft-delete cascadeado: marca el tenant como eliminado + cascadea a
   * las 8 entidades trashables (cursos, exámenes, talleres, proyectos,
   * sesiones, pizarras, contenidos, polls) con el mismo timestamp.
   * Aparece en /app/trash con 30d para revertir vía "Restaurar".
   *
   * Los profiles del tenant NO se eliminan — quedan sin acceso porque
   * el Select de institución en /auth filtra deleted_at IS NULL. Al
   * restaurar el tenant, vuelven a tener acceso normal.
   */
  const softDeleteTenantHandler = async (t: Tenant) => {
    const ok = await confirm({
      title: `Eliminar ${t.name}`,
      description:
        "La institución y TODO su contenido (cursos, exámenes, talleres, proyectos, sesiones, pizarras, contenidos y encuestas) van a la papelera. Los usuarios pierden acceso hasta que la restaures (queda 30 días disponible para revertir desde /app/trash). Pasados los 30 días, se elimina definitivamente.",
      confirmLabel: "Enviar a papelera",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.rpc("soft_delete_tenant", { _tenant_id: t.id });
    if (error) {
      toast.error(friendlyError(error, "No se pudo eliminar la institución"));
      return;
    }
    toast.success(`${t.name} fue enviada a la papelera`);
    await load();
  };

  /**
   * Inicia sesión como el Admin de un tenant — el SuperAdmin queda
   * "aislado" hasta que pare la impersonación. A diferencia del
   * "Ver como esta institución" (que solo cambia branding pero mantiene
   * tu identidad/rol), esto reemplaza la sesión por la del Admin del
   * tenant. Útil para reproducir bugs reportados por ese Admin sin
   * pedirle su contraseña.
   *
   * Selección del target:
   *   - Buscamos profiles del tenant con rol Admin (via user_roles).
   *   - Si hay 1, lo usamos.
   *   - Si hay >1, tomamos el más antiguo (created_at ASC) — el que
   *     más probablemente sea el "Admin principal" del tenant. Si más
   *     adelante queremos permitir elegir, se agrega un dialog acá.
   *   - Si hay 0, mostramos toast y abortamos: el SuperAdmin debe
   *     asignar un Admin primero al tenant.
   */
  const impersonateTenantAdmin = async (t: Tenant) => {
    // 1. IDs de users con rol Admin (cross-tenant — luego filtramos por tenant_id).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: adminRoleRows } = await (supabase as any)
      .from("user_roles")
      .select("user_id")
      .eq("role", "Admin");
    const adminUserIds = ((adminRoleRows ?? []) as { user_id: string }[]).map((r) => r.user_id);
    if (adminUserIds.length === 0) {
      toast.error("No hay usuarios con rol Admin en la plataforma.");
      return;
    }
    // 2. Profiles del tenant que estén en ese set de Admins.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: candidates } = await (supabase as any)
      .from("profiles")
      .select("id, full_name, institutional_email, created_at")
      .eq("tenant_id", t.id)
      .in("id", adminUserIds)
      .order("created_at", { ascending: true })
      .limit(1);
    const target = (candidates ?? [])[0] as
      | { id: string; full_name: string | null; institutional_email: string }
      | undefined;
    if (!target) {
      toast.error(
        `${t.name} no tiene Admin asignado. Crea o asigna uno antes de iniciar sesión como.`,
      );
      return;
    }
    // 3. Confirmación — esta acción reemplaza la sesión del SuperAdmin
    //    y recarga la app. Usamos useConfirm del design system (tono
    //    'warning' por ser cambio importante reversible, no destructivo
    //    en datos).
    const ok = await confirm({
      title: "Iniciar sesión como Admin",
      description:
        `Vas a reemplazar tu sesión de SuperAdmin por la de ` +
        `${target.full_name ?? target.institutional_email} (Admin de ${t.name}). ` +
        `Tu sesión queda guardada — para volver, usa el banner "Estás viendo como…" ` +
        `que aparece arriba.`,
      confirmLabel: "Iniciar como Admin",
      tone: "warning",
    });
    if (!ok) return;
    try {
      // NOTA: antes acá llamábamos `setTenantOverride(null)` para limpiar
      // el contexto de "ver como tenant" antes de impersonar. Con la
      // arquitectura URL-driven eso haría un hard navigate y nunca
      // llegaríamos a `startImpersonate`. Ahora basta con dejar que el
      // `TenantUrlGuard` redirija a la sesión impersonada a su URL
      // correcto cuando la nueva sesión cargue.
      await startImpersonate(target.id);
      // startImpersonate hace window.location.href — no llegamos acá.
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo iniciar la impersonación");
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Building2 className="h-6 w-6 text-violet-500 dark:text-violet-400" />}
        title="Instituciones"
        subtitle={`${tenants.length} institucion${tenants.length === 1 ? "" : "es"} en la plataforma`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={clearViewAs}>
              Limpiar "ver como"
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" />
              Nueva institución
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <SectionLoader text="Cargando…" />
          ) : loadError ? (
            <ErrorState message="No pudimos cargar" hint={loadError} onRetry={load} />
          ) : tenants.length === 0 ? (
            <TableEmpty
              text="Sin instituciones todavía"
              action={
                <Button size="sm" onClick={openCreate}>
                  <Plus className="h-4 w-4 mr-1" />
                  Crear la primera
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead className="hidden sm:table-cell">Dominio email</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagination.paginatedItems.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {t.logo_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={t.logo_url}
                            alt={t.name}
                            className="h-6 w-6 rounded object-cover"
                          />
                        )}
                        {t.name}
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">/t/{t.slug}</code>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                      {t.email_domain ?? "—"}
                    </TableCell>
                    <TableCell>
                      {t.is_active ? (
                        <Badge variant="secondary" className="text-[10px]">
                          Activa
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          Pausada
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <RowActionsMenu
                        actions={[
                          {
                            label: "Iniciar sesión como Admin",
                            icon: LogIn,
                            onClick: () => void impersonateTenantAdmin(t),
                            hint: "Reemplaza tu sesión por la del Admin del tenant",
                            // El ícono toma el primary del tenant de esta
                            // fila — pista visual de que la acción va a
                            // entrar al contexto de ESE tenant. Cae al
                            // default si el tenant no tiene color.
                            iconColor: t.primary_color ?? undefined,
                          },
                          {
                            label: "Gestionar usuarios",
                            icon: UserPlus,
                            onClick: () => setAssignUsersTenant(t),
                          },
                          {
                            label: "Ver como esta institución",
                            icon: Eye,
                            onClick: () => viewAs(t),
                            hint: "Solo cambia branding visual, mantiene tu sesión",
                          },
                          {
                            label: "Editar",
                            icon: Pencil,
                            onClick: () => openEdit(t),
                            separatorBefore: true,
                          },
                          {
                            label: t.is_active ? "Pausar" : "Reactivar",
                            icon: Power,
                            onClick: () => void toggleActive(t),
                            tone: t.is_active ? "destructive" : undefined,
                          },
                          {
                            label: "Eliminar institución",
                            icon: Trash2,
                            onClick: () => void softDeleteTenantHandler(t),
                            tone: "destructive",
                            separatorBefore: true,
                            hint: "Soft-delete cascadeado a todo el contenido. 30d para revertir desde la papelera.",
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <DataPagination state={pagination} entityNamePlural="instituciones" />
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `Editar ${editing.name}` : "Nueva institución"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Cada field es un stack vertical Label → Input → helper text
                con gap consistente de 6px (space-y-1.5). Antes los divs
                NO tenían class interna y la Label (leading-none, sin
                margin) quedaba pegada al Input — visualmente "labels
                no alineados con inputs". Fix: space-y-1.5 a cada field.
                El gap entre fields se subió a space-y-4 (16px) para no
                achicar la separación entre grupos. */}
            <div className="space-y-1.5">
              <Label required>Slug</Label>
              <Input
                value={form.slug}
                onChange={(e) => setForm((p) => ({ ...p, slug: e.target.value }))}
                placeholder="sena-bogota"
              />
              <p className="text-[11px] text-muted-foreground">
                URL: <code>/t/{form.slug || "..."}/app/...</code>. Minúsculas, números y guiones;
                3–50 chars.
                {editing && (
                  <>
                    {" "}
                    <span className="text-amber-600 dark:text-amber-400">
                      Cambiar el slug rompe links existentes a <code>/t/{editing.slug}/...</code>.
                    </span>
                  </>
                )}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label required>Nombre</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="SENA - Centro Bogotá"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Dominio email (opcional)</Label>
              <Input
                value={form.email_domain}
                onChange={(e) => setForm((p) => ({ ...p, email_domain: e.target.value }))}
                placeholder="sena.edu.co"
              />
              <p className="text-[11px] text-muted-foreground">
                Reservado para futura asignación automática de usuarios por dominio.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Logo institucional</Label>
              {/* Misma UI en crear y editar. La diferencia vive en uploadLogo:
                  - Editar: sube al bucket al instante (tenemos editing.id).
                  - Crear: stashea el File + preview local; el upload real lo
                    hace save() después del INSERT, usando el id recién creado. */}
              <div className="flex items-center gap-3 mt-1">
                {form.logo_path ? (
                  <div className="h-14 w-14 rounded-lg border bg-background flex items-center justify-center overflow-hidden shrink-0">
                    <img
                      src={
                        supabase.storage.from("tenant-logos").getPublicUrl(form.logo_path).data
                          ?.publicUrl ?? ""
                      }
                      alt={form.name}
                      className="h-full w-full object-contain"
                    />
                  </div>
                ) : pendingLogoPreview ? (
                  <div className="h-14 w-14 rounded-lg border border-primary/40 bg-background flex items-center justify-center overflow-hidden shrink-0">
                    <img
                      src={pendingLogoPreview}
                      alt={form.name}
                      className="h-full w-full object-contain"
                    />
                  </div>
                ) : form.logo_url ? (
                  <div className="h-14 w-14 rounded-lg border bg-background flex items-center justify-center overflow-hidden shrink-0">
                    <img
                      src={form.logo_url}
                      alt={form.name}
                      className="h-full w-full object-contain"
                    />
                  </div>
                ) : (
                  <div className="h-14 w-14 rounded-lg border border-dashed bg-muted/30 flex items-center justify-center text-[10px] text-muted-foreground shrink-0">
                    Sin logo
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <input
                    ref={logoFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadLogo(f);
                    }}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => logoFileInputRef.current?.click()}
                      disabled={uploadingLogo}
                    >
                      <Upload className="h-3.5 w-3.5 mr-1" />
                      {uploadingLogo ? "Subiendo…" : "Subir logo"}
                    </Button>
                    {(form.logo_path || form.logo_url || pendingLogoFile) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={removeLogo}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        Quitar
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    PNG/JPG/SVG/WebP · 2 MB max.
                    {!editing && pendingLogoFile ? " Se subirá al guardar la institución." : ""}
                  </p>
                </div>
              </div>
              {/* Campo URL alternativo: para casos en que el SuperAdmin
                  prefiere usar un asset alojado en otro lado (ej. CDN
                  corporativo). Si hay archivo subido / pendiente, este
                  campo queda informativo y no se usa. */}
              {!form.logo_path && !pendingLogoFile && (
                <Input
                  value={form.logo_url}
                  onChange={(e) => setForm((p) => ({ ...p, logo_url: e.target.value }))}
                  placeholder="...o pega una URL pública (opcional)"
                  className="mt-2"
                />
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-4">
              <div className="space-y-1.5">
                <Label>Color primario (hex)</Label>
                <HexColorInput
                  value={form.primary_color}
                  onChange={(v) => setForm((p) => ({ ...p, primary_color: v }))}
                  placeholder="#3B82F6"
                  ariaLabel="Color primario"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Color secundario (hex)</Label>
                <HexColorInput
                  value={form.secondary_color}
                  onChange={(v) => setForm((p) => ({ ...p, secondary_color: v }))}
                  placeholder="#8B5CF6"
                  ariaLabel="Color secundario"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Color de letra sobre el primario (hex)</Label>
                <HexColorInput
                  value={form.text_color}
                  onChange={(v) => setForm((p) => ({ ...p, text_color: v }))}
                  placeholder="#FFFFFF"
                  ariaLabel="Color de letra sobre el primario"
                />
                <p className="text-[11px] text-muted-foreground">
                  Override del texto sobre el sidebar y botones primarios. Vacío = auto.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Color de íconos del sidebar (hex)</Label>
                <HexColorInput
                  value={form.icon_color}
                  onChange={(v) => setForm((p) => ({ ...p, icon_color: v }))}
                  placeholder="#FFFFFF"
                  ariaLabel="Color de íconos del sidebar"
                />
                <p className="text-[11px] text-muted-foreground">
                  Override de íconos del menú lateral. Vacío = heredan el color de letra.
                </p>
              </div>
            </div>

            {/* Cuotas de usuarios — define el plan/contrato del tenant.
                NULL = ilimitado. El trigger tg_check_tenant_user_quota
                rechaza INSERT en user_roles cuando se excede. Aplica
                solo a Admin/Docente/Estudiante (SuperAdmin es
                cross-tenant, no cuenta). */}
            <div className="space-y-2 pt-2 border-t">
              <Label className="text-sm font-medium">Cuotas de usuarios</Label>
              <p className="text-[11px] text-muted-foreground">
                Tope de usuarios por rol. Deja vacío para ilimitado. SuperAdmin no consume cuota.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Administradores</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_admins}
                    onChange={(e) => setForm((p) => ({ ...p, max_admins: e.target.value }))}
                    placeholder="∞"
                    className="text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Docentes</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_teachers}
                    onChange={(e) => setForm((p) => ({ ...p, max_teachers: e.target.value }))}
                    placeholder="∞"
                    className="text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Estudiantes</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_students}
                    onChange={(e) => setForm((p) => ({ ...p, max_students: e.target.value }))}
                    placeholder="∞"
                    className="text-xs"
                  />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              <Save className="h-4 w-4 mr-1" />
              {saving ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 'Gestionar usuarios' — el SuperAdmin marca/desmarca
          profiles cross-tenant para agregar o quitar de este tenant.
          Trigger DB rechaza si el user tiene cursos activos en su
          tenant actual. */}
      <AssignUsersToTenantDialog
        tenant={assignUsersTenant}
        open={assignUsersTenant !== null}
        onOpenChange={(o) => {
          if (!o) setAssignUsersTenant(null);
        }}
        tenants={tenants}
        onAssigned={() => void load()}
      />

      {/* Credenciales del usuario de prueba — se muestran UNA SOLA VEZ
          tras crear una institución. La password no se persiste en
          plaintext: si el SuperAdmin cierra sin copiar, tiene que pedir
          reset desde /auth o crear otro user manualmente. */}
      <Dialog
        open={testUserCreds !== null}
        onOpenChange={(o) => {
          if (!o) setTestUserCreds(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-amber-500" />
              Usuario de prueba creado
            </DialogTitle>
            <DialogDescription>
              Se creó un usuario con todos los roles (Admin, Docente, Estudiante) para que puedas
              probar la institución. <strong>Guarda la contraseña ahora</strong> — no se mostrará
              de nuevo.
            </DialogDescription>
          </DialogHeader>
          {testUserCreds && (
            <div className="space-y-3 text-sm">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Institución</Label>
                <div className="font-medium">{testUserCreds.tenant_name}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Nombre completo</Label>
                <div className="font-medium">{testUserCreds.full_name}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Email</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono break-all">
                    {testUserCreds.email}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => {
                      void navigator.clipboard.writeText(testUserCreds.email);
                      toast.success("Email copiado");
                    }}
                    title="Copiar email"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Contraseña temporal</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono break-all">
                    {testUserCreds.password}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => {
                      void navigator.clipboard.writeText(testUserCreds.password);
                      toast.success("Contraseña copiada");
                    }}
                    title="Copiar contraseña"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Roles asignados</Label>
                <div className="flex flex-wrap gap-1">
                  {testUserCreds.roles.map((r) => (
                    <Badge key={r} variant="secondary" className="text-[10px]">
                      {r}
                    </Badge>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground border-t pt-3">
                El usuario ya está marcado como confirmado — puede ingresar directamente en
                <code className="mx-1 rounded bg-muted px-1">/auth</code>
                con estas credenciales. El email termina en <code>.test</code> (dominio reservado
                para pruebas — los correos a este dominio no se entregan).
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={() => {
                if (!testUserCreds) return;
                void navigator.clipboard.writeText(
                  `Email: ${testUserCreds.email}\nContraseña: ${testUserCreds.password}`,
                );
                toast.success("Credenciales copiadas");
              }}
              variant="outline"
            >
              <Copy className="h-3.5 w-3.5 mr-1" />
              Copiar todo
            </Button>
            <Button onClick={() => setTestUserCreds(null)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
