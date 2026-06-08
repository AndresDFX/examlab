/**
 * Override por-curso de configuración de certificaciones.
 *
 * Cada campo es opcional: si lo dejas vacío, el certificado emitido para
 * este curso usa el valor global (Admin → Configuración → Certificaciones).
 *
 * Editable por el docente del curso o cualquier Admin. El RPC
 * `resolve_certificate_settings(course_id)` hace el merge automático al
 * emitir el certificado.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { Award, Save, Info, RotateCcw } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Course {
  id: string;
  name: string;
}

interface CourseCertOverride {
  id?: string;
  course_id: string;
  institution_name: string | null;
  institution_logo_url: string | null;
  signature_name: string | null;
  signature_title: string | null;
  signature_image_url: string | null;
  certificate_message: string | null;
  footer_text: string | null;
}

interface EffectiveSettings {
  institution_name: string | null;
  institution_logo_url: string | null;
  signature_name: string | null;
  signature_title: string | null;
  signature_image_url: string | null;
  certificate_message: string | null;
  footer_text: string | null;
}

const EMPTY = (course_id: string): CourseCertOverride => ({
  course_id,
  institution_name: null,
  institution_logo_url: null,
  signature_name: null,
  signature_title: null,
  signature_image_url: null,
  certificate_message: null,
  footer_text: null,
});

export function CourseCertificateSettingsDialog({
  course,
  onClose,
}: {
  course: Course | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [draft, setDraft] = useState<CourseCertOverride | null>(null);
  const [effective, setEffective] = useState<EffectiveSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasOverride, setHasOverride] = useState(false);

  useEffect(() => {
    if (!course) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      // Override actual del curso (puede no existir).
      const { data: ovr } = await db
        .from("course_certificate_settings")
        .select("*")
        .eq("course_id", course.id)
        .maybeSingle();
      // Settings efectivas (lo que aplicaría al emitir HOY).
      const { data: eff } = await db.rpc("resolve_certificate_settings", {
        _course_id: course.id,
      });
      if (cancelled) return;
      if (ovr) {
        setDraft(ovr as CourseCertOverride);
        setHasOverride(true);
      } else {
        setDraft(EMPTY(course.id));
        setHasOverride(false);
      }
      const e = Array.isArray(eff) ? eff[0] : eff;
      setEffective(e ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [course]);

  const handleSave = async () => {
    if (!user || !draft || !course) return;
    setSaving(true);
    try {
      const payload = {
        course_id: course.id,
        institution_name: draft.institution_name?.trim() || null,
        institution_logo_url: draft.institution_logo_url?.trim() || null,
        signature_name: draft.signature_name?.trim() || null,
        signature_title: draft.signature_title?.trim() || null,
        signature_image_url: draft.signature_image_url?.trim() || null,
        certificate_message: draft.certificate_message?.trim() || null,
        footer_text: draft.footer_text?.trim() || null,
        updated_by: user.id,
      };
      const { error } = await db
        .from("course_certificate_settings")
        .upsert(payload, { onConflict: "course_id" });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "certificate_settings.course_override_saved",
        category: "system",
        severity: "info",
        entityType: "course",
        entityId: course.id,
        entityName: course.name,
        metadata: { override: payload },
      });
      toast.success(
        i18n.t("toast.modules_certificates_CourseCertificateSettingsDialog.savedOk", {
          defaultValue: "Configuración del curso guardada",
        }),
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!course) return;
    setSaving(true);
    try {
      const { error } = await db
        .from("course_certificate_settings")
        .delete()
        .eq("course_id", course.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "certificate_settings.course_override_removed",
        category: "system",
        severity: "info",
        entityType: "course",
        entityId: course.id,
        entityName: course.name,
      });
      toast.success(
        i18n.t("toast.modules_certificates_CourseCertificateSettingsDialog.overrideRemoved", {
          defaultValue: "Override eliminado — vuelve a usar la configuración global",
        }),
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!course) return null;

  // Helper: muestra el placeholder con el valor efectivo (global) para que
  // el docente sepa qué se aplicaría sin tocar.
  const placeholderFor = (key: keyof EffectiveSettings, fallback: string) =>
    effective?.[key] || `(global) ${fallback}`;

  return (
    <Dialog open={!!course} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Award className="h-4 w-4 text-amber-500" />
            Configuración de certificaciones · {course.name}
          </DialogTitle>
          <DialogDescription>
            Sobrescribe los valores globales solo para este curso. Los campos vacíos heredan del
            Admin (Configuración → Certificaciones).
          </DialogDescription>
        </DialogHeader>

        {loading || !draft ? (
          <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando…
          </div>
        ) : (
          <div className="space-y-4">
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Los placeholders muestran lo que se aplicaría sin override (valor global o
                fallback). Llena solo lo que quieras sobrescribir para este curso.
              </AlertDescription>
            </Alert>

            <div className="space-y-3">
              <h3 className="text-sm font-medium">Institución</h3>
              <div>
                <Label>Nombre institucional</Label>
                <Input
                  value={draft.institution_name ?? ""}
                  onChange={(e) => setDraft({ ...draft, institution_name: e.target.value })}
                  placeholder={placeholderFor("institution_name", "Sin nombre configurado")}
                />
              </div>
              <div>
                <Label>URL del logo</Label>
                <Input
                  value={draft.institution_logo_url ?? ""}
                  onChange={(e) => setDraft({ ...draft, institution_logo_url: e.target.value })}
                  placeholder={placeholderFor("institution_logo_url", "Sin logo configurado")}
                />
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t">
              <h3 className="text-sm font-medium">Firma</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Nombre</Label>
                  <Input
                    value={draft.signature_name ?? ""}
                    onChange={(e) => setDraft({ ...draft, signature_name: e.target.value })}
                    placeholder={placeholderFor("signature_name", "Sin firma configurada")}
                  />
                </div>
                <div>
                  <Label>Cargo</Label>
                  <Input
                    value={draft.signature_title ?? ""}
                    onChange={(e) => setDraft({ ...draft, signature_title: e.target.value })}
                    placeholder={placeholderFor("signature_title", "Sin cargo")}
                  />
                </div>
              </div>
              <div>
                <Label>URL de la imagen de la firma</Label>
                <Input
                  value={draft.signature_image_url ?? ""}
                  onChange={(e) => setDraft({ ...draft, signature_image_url: e.target.value })}
                  placeholder={placeholderFor("signature_image_url", "Sin imagen")}
                />
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t">
              <h3 className="text-sm font-medium">Texto</h3>
              <div>
                <Label>
                  Mensaje principal{" "}
                  <HelpHint>
                    Placeholders disponibles: <code>{"{student}"}</code>, <code>{"{course}"}</code>,{" "}
                    <code>{"{grade}"}</code>, <code>{"{period}"}</code>, <code>{"{teacher}"}</code>,{" "}
                    <code>{"{date}"}</code>.
                  </HelpHint>
                </Label>
                <Textarea
                  value={draft.certificate_message ?? ""}
                  onChange={(e) => setDraft({ ...draft, certificate_message: e.target.value })}
                  rows={4}
                  placeholder={placeholderFor("certificate_message", "Mensaje por defecto")}
                />
              </div>
              <div>
                <Label>Pie de página</Label>
                <Input
                  value={draft.footer_text ?? ""}
                  onChange={(e) => setDraft({ ...draft, footer_text: e.target.value })}
                  placeholder={placeholderFor("footer_text", "Sin pie de página")}
                />
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {hasOverride && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleReset()}
              disabled={saving}
              className="mr-auto text-destructive hover:text-destructive"
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              Volver a la configuración global
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || loading}>
            {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Guardar override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
