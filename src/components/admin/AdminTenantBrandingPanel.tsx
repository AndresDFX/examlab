/**
 * Panel de marca del tenant (Admin del tenant + Superadmin).
 *
 * El Admin del tenant edita el nombre visible, logo y colores de SU
 * tenant. La RLS RESTRICTIVE de `tenants` ya garantiza que solo puede
 * escribir la fila que le corresponde (su `current_tenant_id_safe()`).
 *
 * Superadmin gestiona TODOS los tenants desde `/app/superadmin/tenants`
 * — este panel es exclusivamente para el Admin de tenant.
 *
 * Cambios aquí se reflejan en:
 *   - `tenants.name` → ROLE_CONFIG y headers de la app
 *   - `tenants.logo_url` → header / login screens
 *   - `tenants.primary_color` / `secondary_color` → CSS vars del tema
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/lib/audit";
import { applyTenantBranding, buildTenantInviteUrl } from "@/lib/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { Building2, Save, Info, Palette, Image as ImageIcon, Copy, Link2 } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
}

export function AdminTenantBrandingPanel() {
  const { user } = useAuth();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [draft, setDraft] = useState<Partial<Tenant>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    // RLS filtra automáticamente al tenant del user. Si por alguna razón
    // hay más de una fila visible (Superadmin), tomamos la primera y
    // sugerimos que use el panel de Superadmin para gestión completa.
    const { data, error } = await db
      .from("tenants")
      .select("id, slug, name, status, logo_url, primary_color, secondary_color")
      .limit(1)
      .maybeSingle();
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    if (data) {
      const t = data as Tenant;
      setTenant(t);
      setDraft({
        name: t.name,
        logo_url: t.logo_url,
        primary_color: t.primary_color ?? "#1e40af",
        secondary_color: t.secondary_color ?? "#64748b",
      });
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty =
    tenant &&
    (draft.name !== tenant.name ||
      draft.logo_url !== tenant.logo_url ||
      draft.primary_color !== tenant.primary_color ||
      draft.secondary_color !== tenant.secondary_color);

  const handleSave = async () => {
    if (!user || !tenant) return;
    if (!draft.name?.trim() || draft.name.trim().length < 2) {
      toast.error("El nombre del tenant debe tener al menos 2 caracteres.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await db
        .from("tenants")
        .update({
          name: draft.name.trim(),
          logo_url: draft.logo_url?.trim() || null,
          primary_color: draft.primary_color || null,
          secondary_color: draft.secondary_color || null,
        })
        .eq("id", tenant.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      void logEvent({
        action: "tenant.branding_updated",
        category: "system",
        severity: "info",
        entityType: "tenant",
        entityId: tenant.id,
        entityName: draft.name,
        metadata: {
          previous: {
            name: tenant.name,
            logo_url: tenant.logo_url,
            primary_color: tenant.primary_color,
            secondary_color: tenant.secondary_color,
          },
          new: draft,
        },
      });
      // Aplicar branding al instante en la pestaña actual
      applyTenantBranding({
        id: tenant.id,
        slug: tenant.slug,
        name: draft.name!,
        status: tenant.status,
        logo_url: draft.logo_url ?? null,
        primary_color: draft.primary_color ?? null,
        secondary_color: draft.secondary_color ?? null,
      });
      toast.success("Marca actualizada");
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="sm" /> Cargando marca…
        </CardContent>
      </Card>
    );
  }

  if (!tenant) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No se pudo cargar el tenant. Verifica que tienes rol Admin.
        </CardContent>
      </Card>
    );
  }

  const inviteUrl = buildTenantInviteUrl(tenant.slug);
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Link copiado al portapapeles");
    } catch {
      toast.error("No se pudo copiar. Copia el link manualmente.");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="h-4 w-4 text-indigo-500" />
            Link de invitación
            <HelpHint>
              Compártelo con docentes y estudiantes nuevos. Al abrirlo, el navegador detecta
              automáticamente tu instancia (slug <code className="font-mono">{tenant.slug}</code>)
              y aplica el branding. El slug queda persistido en el navegador del invitado, así que
              después puede entrar directamente a la URL raíz.
            </HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2">
            <Input value={inviteUrl} readOnly className="font-mono text-sm" />
            <Button size="sm" variant="outline" onClick={() => void copyInvite()}>
              <Copy className="h-4 w-4 mr-1" />
              Copiar
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Útil mientras no haya subdominios configurados. Cuando el DNS wildcard esté listo,
            podrás usar también <code className="font-mono">{tenant.slug}.examlab.com</code>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4 text-indigo-500" />
            Marca de tu institución
            <HelpHint>
              Estos valores afectan a TODOS los usuarios de tu instancia. El logo aparece en
              cabeceras y el login; los colores se aplican a botones y badges.
            </HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Los cambios se reflejan inmediatamente para todos los usuarios al recargar.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label required>Nombre visible</Label>
            <Input
              value={draft.name ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Ej: Universidad X"
              maxLength={200}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Slug (URL) actual: <code className="font-mono">{tenant.slug}</code>. El slug es
              inmutable — contacta al Superadministrador si necesitas cambiarlo.
            </p>
          </div>

          <div>
            <Label>
              <ImageIcon className="h-3.5 w-3.5 inline mr-1" />
              URL del logo
            </Label>
            <Input
              value={draft.logo_url ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, logo_url: e.target.value }))}
              placeholder="https://…/logo.png"
            />
            {draft.logo_url && (
              <div className="mt-2 inline-block rounded border bg-muted/30 p-2">
                <img
                  src={draft.logo_url}
                  alt="preview"
                  className="h-12 w-auto"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
            )}
            <p className="text-[11px] text-muted-foreground mt-1">
              PNG/SVG/JPG. Idealmente con fondo transparente y resolución mínima 192×192.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>
                <Palette className="h-3.5 w-3.5 inline mr-1" />
                Color primario
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  value={draft.primary_color ?? "#1e40af"}
                  onChange={(e) => setDraft((d) => ({ ...d, primary_color: e.target.value }))}
                  className="h-9 w-16 p-1"
                />
                <Input
                  value={draft.primary_color ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, primary_color: e.target.value }))}
                  placeholder="#1e40af"
                  className="font-mono text-sm"
                />
              </div>
            </div>
            <div>
              <Label>
                <Palette className="h-3.5 w-3.5 inline mr-1" />
                Color secundario
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  value={draft.secondary_color ?? "#64748b"}
                  onChange={(e) => setDraft((d) => ({ ...d, secondary_color: e.target.value }))}
                  className="h-9 w-16 p-1"
                />
                <Input
                  value={draft.secondary_color ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, secondary_color: e.target.value }))}
                  placeholder="#64748b"
                  className="font-mono text-sm"
                />
              </div>
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Los cambios afectan a TODOS los usuarios de tu instancia. Si quieres probarlos
              primero, considera duplicar el tenant en un entorno de prueba.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2 justify-end pt-1">
            {dirty && tenant && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setDraft({
                    name: tenant.name,
                    logo_url: tenant.logo_url,
                    primary_color: tenant.primary_color ?? "#1e40af",
                    secondary_color: tenant.secondary_color ?? "#64748b",
                  })
                }
                disabled={saving}
              >
                Cancelar
              </Button>
            )}
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || !dirty}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Guardar marca
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
