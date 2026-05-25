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
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/modules/tenants/use-tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionLoader } from "@/components/ui/loaders";
import { ErrorState } from "@/components/ui/empty-state";
import { Save, Building2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface FormState {
  name: string;
  logo_url: string;
  primary_color: string;
  email_domain: string;
}

export function AdminMyTenantPanel() {
  const { tenant, loading, error, refresh } = useTenant();
  const [form, setForm] = useState<FormState>({
    name: "",
    logo_url: "",
    primary_color: "",
    email_domain: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tenant) {
      setForm({
        name: tenant.name,
        logo_url: tenant.logo_url ?? "",
        primary_color: tenant.primary_color ?? "",
        email_domain: tenant.email_domain ?? "",
      });
    }
  }, [tenant]);

  if (loading) return <SectionLoader text="Cargando datos de la institución…" />;
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
          <Label>Logo (URL)</Label>
          <Input
            value={form.logo_url}
            onChange={(e) => setForm((p) => ({ ...p, logo_url: e.target.value }))}
            placeholder="https://…/logo.png"
          />
          {form.logo_url && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              Preview:
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={form.logo_url}
                alt="Logo"
                className="h-10 w-10 object-contain border rounded bg-background"
              />
            </div>
          )}
        </div>

        <div>
          <Label>Color primario (hex)</Label>
          <div className="flex items-center gap-2">
            <Input
              value={form.primary_color}
              onChange={(e) => setForm((p) => ({ ...p, primary_color: e.target.value }))}
              placeholder="#3B82F6"
              className="flex-1"
            />
            {/^#[0-9a-fA-F]{6}$/.test(form.primary_color.trim()) && (
              <div
                className="h-9 w-9 rounded border shrink-0"
                style={{ backgroundColor: form.primary_color.trim() }}
                title={form.primary_color.trim()}
              />
            )}
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
