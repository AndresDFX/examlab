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
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { SectionLoader } from "@/components/ui/loaders";
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
import { Building2, Plus, Eye, Pencil, Power, Save, Upload, Trash2 } from "lucide-react";
import { isValidTenantSlug } from "@/modules/tenants/tenant";
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
    email_domain: "",
    // Cuotas. "" = ilimitado (se persiste como NULL). Cualquier número
    // entero >= 0 es el tope.
    max_admins: "" as string,
    max_teachers: "" as string,
    max_students: "" as string,
  });
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoFileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("tenants")
      .select("*")
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

  // Gate de rol — los no-SuperAdmin redirigen al dashboard.
  if (authLoading) return <SectionLoader text="Cargando…" />;
  if (!isSuper) {
    return <Navigate to="/app" />;
  }

  const openCreate = () => {
    setEditing(null);
    setForm({
      slug: "",
      name: "",
      logo_url: "",
      logo_path: "",
      primary_color: "",
      secondary_color: "",
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
  const uploadLogo = async (file: File) => {
    if (!editing) {
      toast.error("Crea la institución primero, luego edita para subir el logo.");
      return;
    }
    const validTypes = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
    if (!validTypes.includes(file.type)) {
      toast.error("Formato no soportado. Usa PNG, JPG, SVG o WebP.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("El logo no puede pesar más de 2 MB.");
      return;
    }
    setUploadingLogo(true);
    try {
      const { file: finalFile, resized, originalSize, finalSize } =
        await resizeImageForLogo(file);
      const ext =
        finalFile.type === "image/png"
          ? "png"
          : finalFile.type === "image/jpeg"
            ? "jpg"
            : finalFile.type === "image/svg+xml"
              ? "svg"
              : "webp";
      const path = `${editing.id}/logo.${ext}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await (supabase.storage as any)
        .from("tenant-logos")
        .upload(path, finalFile, { upsert: true, contentType: finalFile.type });
      if (upErr) {
        toast.error(friendlyError(upErr, "No se pudo subir el logo"));
        return;
      }
      setForm((p) => ({ ...p, logo_path: path, logo_url: "" }));
      if (resized) {
        const kbBefore = Math.round(originalSize / 1024);
        const kbAfter = Math.round(finalSize / 1024);
        toast.success(
          `Logo subido (optimizado: ${kbBefore} KB → ${kbAfter} KB). Recuerda 'Guardar'.`,
        );
      } else {
        toast.success("Logo subido. Recuerda 'Guardar' para aplicarlo.");
      }
    } finally {
      setUploadingLogo(false);
      if (logoFileInputRef.current) logoFileInputRef.current.value = "";
    }
  };

  const removeLogo = () => {
    setForm((p) => ({ ...p, logo_path: "", logo_url: "" }));
    toast.info("Logo removido. 'Guardar' para aplicar.");
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
      const { error } = await db.from("tenants").insert(payload);
      if (error) {
        toast.error(friendlyError(error, "No se pudo crear"));
        setSaving(false);
        return;
      }
      toast.success("Institución creada");
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
    const { error } = await db
      .from("tenants")
      .update({ is_active: !t.is_active })
      .eq("id", t.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(willDeactivate ? "Institución pausada" : "Institución reactivada");
    await load();
  };

  const viewAs = (t: Tenant) => {
    setTenantOverride(t.slug);
    toast.success(`Viendo como: ${t.name}. Recarga la página para refrescar listas.`);
  };

  const clearViewAs = () => {
    setTenantOverride(null);
    toast.success("Override de tenant limpiado. Recarga para volver al tuyo.");
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
                {tenants.map((t) => (
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
                            label: "Ver como esta institución",
                            icon: Eye,
                            onClick: () => viewAs(t),
                          },
                          {
                            label: "Editar",
                            icon: Pencil,
                            onClick: () => openEdit(t),
                          },
                          {
                            label: t.is_active ? "Pausar" : "Reactivar",
                            icon: Power,
                            onClick: () => void toggleActive(t),
                            tone: t.is_active ? "destructive" : undefined,
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Editar ${editing.name}` : "Nueva institución"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required>Slug</Label>
              <Input
                value={form.slug}
                onChange={(e) => setForm((p) => ({ ...p, slug: e.target.value }))}
                placeholder="sena-bogota"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                URL: <code>/t/{form.slug || "..."}/app/...</code>. Minúsculas, números
                y guiones; 3–50 chars.
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
            <div>
              <Label required>Nombre</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="SENA - Centro Bogotá"
              />
            </div>
            <div>
              <Label>Dominio email (opcional)</Label>
              <Input
                value={form.email_domain}
                onChange={(e) => setForm((p) => ({ ...p, email_domain: e.target.value }))}
                placeholder="sena.edu.co"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Reservado para futura asignación automática de usuarios por dominio.
              </p>
            </div>
            <div>
              <Label>Logo institucional</Label>
              {editing ? (
                <div className="flex items-center gap-3 mt-1">
                  {/* Preview del logo (path actual del form). Si el SuperAdmin
                      acaba de subir uno nuevo, form.logo_path lo refleja al
                      instante. resolveTenantLogoUrl resuelve la URL pública
                      desde el bucket. */}
                  {form.logo_path ? (
                    <div className="h-14 w-14 rounded-lg border bg-background flex items-center justify-center overflow-hidden shrink-0">
                      <img
                        src={
                          supabase.storage
                            .from("tenant-logos")
                            .getPublicUrl(form.logo_path).data?.publicUrl ?? ""
                        }
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
                      {(form.logo_path || form.logo_url) && (
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
                      PNG/JPG/SVG/WebP · 2 MB max. Sobrescribe el que tenga el
                      Admin del tenant.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <Input
                    value={form.logo_url}
                    onChange={(e) => setForm((p) => ({ ...p, logo_url: e.target.value }))}
                    placeholder="https://.../logo.png (opcional)"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Para subir un archivo, crea la institución primero y luego
                    edítala — necesitamos el ID del tenant para guardar el archivo
                    en el bucket.
                  </p>
                </>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label>Color primario (hex)</Label>
                <Input
                  value={form.primary_color}
                  onChange={(e) => setForm((p) => ({ ...p, primary_color: e.target.value }))}
                  placeholder="#3B82F6"
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <Label>Color secundario (hex)</Label>
                <Input
                  value={form.secondary_color}
                  onChange={(e) => setForm((p) => ({ ...p, secondary_color: e.target.value }))}
                  placeholder="#8B5CF6"
                  className="font-mono text-xs"
                />
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
                Tope de usuarios por rol. Deja vacío para ilimitado. SuperAdmin
                no consume cuota.
              </p>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-xs">Administradores</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_admins}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, max_admins: e.target.value }))
                    }
                    placeholder="∞"
                    className="text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs">Docentes</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_teachers}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, max_teachers: e.target.value }))
                    }
                    placeholder="∞"
                    className="text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs">Estudiantes</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_students}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, max_students: e.target.value }))
                    }
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
    </div>
  );
}
