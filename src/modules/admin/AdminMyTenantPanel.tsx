/**
 * AdminMyTenantPanel — el Admin edita SU PROPIA institución.
 *
 * Vive dentro del tab Institución de Configuración. Es el panel que el
 * Admin usa día a día — distinto del CRUD global de tenants en
 * /app/superadmin/tenants (que es para SuperAdmin gestionando TODAS las
 * instituciones de la plataforma).
 *
 * El Admin puede editar:
 *   - name (cómo se llama la institución).
 *   - logo_url, primary_color (branding).
 *   - email_domain (dominio email opcional para futura auto-asignación).
 *
 * No puede editar el `slug` (es URL canónica, immutable post-creación;
 * solo SuperAdmin la cambia desde el panel global).
 *
 * No puede editar `is_active` (apagar tu propia institución te dejaría
 * fuera; solo SuperAdmin puede pausarlas).
 *
 * RLS: el UPDATE de tenants en migración 20260621 exige
 * `is_super_admin() OR (id = current_tenant_id())`. Pero la policy actual
 * solo permite SuperAdmin (decisión defensiva al crear la tabla). Para
 * que el Admin pueda editar SU propio tenant, necesitamos extender la
 * policy. Acá usamos la RPC `admin_update_my_tenant` que valida
 * server-side: el caller debe tener rol Admin y el tenant_id debe ser
 * el suyo.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { useTenant, readTenantOverride } from "@/modules/tenants/use-tenant";
import { resolveTenantLogoUrl } from "@/modules/tenants/tenant";
import { resizeImageForLogo } from "@/modules/tenants/image-resize";
import { TenantQuotaCard } from "@/modules/tenants/TenantQuotaCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HexColorInput } from "@/components/ui/hex-color-input";
import { SectionLoader } from "@/components/ui/loaders";
import { ErrorState } from "@/components/ui/empty-state";
import { Save, Building2, Upload, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface FormState {
  name: string;
  logo_url: string;
  /** Path en bucket tenant-logos. Lo setea uploadLogo / removeLogo. */
  logo_path: string;
  primary_color: string;
  secondary_color: string;
  /** Hex opcional — override del color de letra sobre el sidebar y
   *  botones primarios. Si vacío, se deriva por luminancia. */
  text_color: string;
  /** Hex opcional — override del color de íconos del sidebar nav.
   *  Si vacío, los íconos heredan text_color. */
  icon_color: string;
  email_domain: string;
}

export function AdminMyTenantPanel() {
  const { tenant, loading, error, refresh } = useTenant();
  // Gate de rol: SuperAdmin en modo cross-tenant (rol activo SuperAdmin
  // + sin override "ver como X") NO tiene una "institución propia" que
  // editar — opera cross-tenant. En ese modo mostramos un placeholder
  // que lo manda al panel correcto en /app/superadmin/tenants. Cuando
  // elige "Ver como X" desde ahí, el override se activa y este panel
  // edita ESA institución correctamente.
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const isSuperAdminCrossTenant =
    roles.includes("SuperAdmin") &&
    activeRole === "SuperAdmin" &&
    readTenantOverride() === null;
  const [form, setForm] = useState<FormState>({
    name: "",
    logo_url: "",
    logo_path: "",
    primary_color: "",
    secondary_color: "",
    text_color: "",
    icon_color: "",
    email_domain: "",
  });
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tenant) {
      setForm({
        name: tenant.name,
        logo_url: tenant.logo_url ?? "",
        logo_path: tenant.logo_path ?? "",
        primary_color: tenant.primary_color ?? "",
        secondary_color: tenant.secondary_color ?? "",
        // text_color / icon_color: las columnas se agregaron en mig
        // 20260706000000; los tipos generados aún no las exponen.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        text_color: ((tenant as any).text_color as string | null) ?? "",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        icon_color: ((tenant as any).icon_color as string | null) ?? "",
        email_domain: tenant.email_domain ?? "",
      });
    }
  }, [tenant]);

  // URL renderizable del logo CURRENT (lo que esta guardado, no el draft).
  // Tras subir el logo, esta URL se actualiza al refetch del tenant.
  const currentLogoUrl = resolveTenantLogoUrl(tenant, supabase);

  /**
   * Sube un archivo de imagen al bucket tenant-logos.
   * Path: <tenant_id>/logo.<ext>. Upsert = sobrescribe el anterior.
   * Guarda la nueva ruta en form.logo_path para que al "Guardar" se
   * persista en tenants.logo_path.
   */
  const uploadLogo = async (file: File) => {
    if (!tenant) return;
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
      // Auto-resize client-side: el helper escala a 512×512 max
      // proporcional. SVG/archivos chicos pasan sin tocar.
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
      const path = `${tenant.id}/logo.${ext}`;
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
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeLogo = () => {
    setForm((p) => ({ ...p, logo_path: "", logo_url: "" }));
    toast.info("Logo removido. 'Guardar' para aplicar.");
  };

  if (loading) return <SectionLoader text="Cargando datos de la institución…" />;
  // SuperAdmin cross-tenant (rol activo SuperAdmin sin override "ver como X"):
  // NO tiene una institución propia que editar — opera cross-tenant. El
  // form de branding aplica solo a tenants reales; mostramos placeholder
  // que lo manda a /app/superadmin/tenants donde puede elegir uno.
  if (isSuperAdminCrossTenant) {
    return (
      <Card>
        <CardContent className="p-6 text-center space-y-3">
          <p className="text-sm font-medium">Modo SuperAdmin cross-tenant</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Como SuperAdmin no tienes "una institución propia" que editar acá. Para gestionar
            branding, cuotas o logos de una institución específica, entrá al panel de instituciones
            y elegila desde el listado o usá "Ver como esta institución" para entrar a su contexto.
          </p>
          <Link
            to="/app/superadmin/tenants"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Ir a Instituciones
          </Link>
        </CardContent>
      </Card>
    );
  }
  if (error || !tenant) {
    return (
      <ErrorState
        message="No pudimos cargar la institución"
        hint={
          error === "missing_tenant"
            ? "Tu usuario no tiene institución asignada. Contacta al SuperAdmin."
            : "Reintenta en unos segundos."
        }
        onRetry={refresh}
      />
    );
  }

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("El nombre es obligatorio.");
      return;
    }
    setSaving(true);
    const { error: rpcErr } = await db.rpc("admin_update_my_tenant", {
      _name: form.name.trim(),
      _logo_url: form.logo_url.trim() || null,
      _primary_color: form.primary_color.trim() || null,
      _email_domain: form.email_domain.trim().toLowerCase() || null,
      _secondary_color: form.secondary_color.trim() || null,
      _logo_path: form.logo_path.trim() || null,
      _text_color: form.text_color.trim() || null,
      _icon_color: form.icon_color.trim() || null,
    });
    setSaving(false);
    if (rpcErr) {
      toast.error(friendlyError(rpcErr, "No se pudo guardar"));
      return;
    }
    toast.success("Institución actualizada");
    refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4 text-violet-500" />
          Mi institución
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-xs">Identificador (URL)</Label>
          <Input value={tenant.slug} disabled className="font-mono text-xs" />
          <p className="text-[11px] text-muted-foreground mt-1">
            El slug es la URL canónica de tu institución y no es editable.
            Solo el SuperAdmin lo puede cambiar.
          </p>
        </div>

        <div>
          <Label required>Nombre</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="Universidad / Instituto / Colegio…"
          />
        </div>

        <div>
          <Label>Logo institucional</Label>
          <div className="flex items-center gap-3 mt-1">
            {/* Preview del logo guardado (resuelto via Storage) o
                placeholder si no hay todavía. */}
            {currentLogoUrl || form.logo_path ? (
              <div className="h-16 w-16 rounded-lg border bg-background flex items-center justify-center overflow-hidden shrink-0">
                <img
                  src={
                    currentLogoUrl ??
                    (form.logo_path
                      ? supabase.storage.from("tenant-logos").getPublicUrl(form.logo_path).data
                          ?.publicUrl
                      : "")
                  }
                  alt={form.name}
                  className="h-full w-full object-contain"
                />
              </div>
            ) : (
              <div className="h-16 w-16 rounded-lg border border-dashed bg-muted/30 flex items-center justify-center text-[10px] text-muted-foreground shrink-0">
                Sin logo
              </div>
            )}
            <div className="flex-1 min-w-0">
              <input
                ref={fileInputRef}
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
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingLogo}
                >
                  <Upload className="h-3.5 w-3.5 mr-1" />
                  {uploadingLogo ? "Subiendo…" : "Subir logo"}
                </Button>
                {(currentLogoUrl || form.logo_path) && (
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
              <p className="text-[11px] text-muted-foreground mt-1.5">
                PNG, JPG, SVG o WebP · máximo 2 MB. Aparece en el header de
                la app y en el login para usuarios de tu institución.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Color primario (hex)</Label>
            <HexColorInput
              value={form.primary_color}
              onChange={(v) => setForm((p) => ({ ...p, primary_color: v }))}
              placeholder="#3B82F6"
              ariaLabel="Color primario"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Color principal de la marca. Aplica en acentos / botones primarios. Click en el swatch
              para abrir el selector visual.
            </p>
          </div>
          <div>
            <Label>Color secundario (hex)</Label>
            <HexColorInput
              value={form.secondary_color}
              onChange={(v) => setForm((p) => ({ ...p, secondary_color: v }))}
              placeholder="#8B5CF6"
              ariaLabel="Color secundario"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Color de acento opcional. Usado en hovers y badges secundarios.
            </p>
          </div>
          <div>
            <Label>Color de letra sobre el primario (hex)</Label>
            <HexColorInput
              value={form.text_color}
              onChange={(v) => setForm((p) => ({ ...p, text_color: v }))}
              placeholder="#FFFFFF"
              ariaLabel="Color de letra sobre el primario"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Override del texto sobre el sidebar y botones primarios. Vacío = auto.
            </p>
          </div>
          <div>
            <Label>Color de íconos del sidebar (hex)</Label>
            <HexColorInput
              value={form.icon_color}
              onChange={(v) => setForm((p) => ({ ...p, icon_color: v }))}
              placeholder="#FFFFFF"
              ariaLabel="Color de íconos del sidebar"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Override de los íconos del menú lateral. Vacío = heredan el color de letra.
            </p>
          </div>
        </div>

        <div>
          <Label>Dominio email (opcional)</Label>
          <Input
            value={form.email_domain}
            onChange={(e) => setForm((p) => ({ ...p, email_domain: e.target.value }))}
            placeholder="miuniversidad.edu.co"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Reservado para asignación automática de usuarios por dominio
            en versiones futuras.
          </p>
        </div>

        {/* Cuotas: ahora vienen del componente compartido del design
            system. Read-only para el Admin (los limites los gestiona
            el SuperAdmin). El mismo widget se monta en el grid de
            usuarios para que el Admin vea cuanto le queda antes de
            crear uno nuevo. */}
        <div className="pt-2 border-t">
          <TenantQuotaCard compact title="Licencias de usuarios" />
          <p className="text-[11px] text-muted-foreground mt-2">
            Definidas por el SuperAdmin de la plataforma. Para ajustar estos topes,
            contacta al equipo de ExamLab.
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <Button onClick={save} disabled={saving}>
            <Save className="h-4 w-4 mr-1" />
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

