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
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
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
      toast.success(t("hc_modulesCertificatesCourseCertificateSettingsDialog.savedOk"));
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
      toast.success(t("hc_modulesCertificatesCourseCertificateSettingsDialog.overrideRemoved"));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!course) return null;

  // Helper: muestra el placeholder con el valor efectivo (global) para que
  // el docente sepa qué se aplicaría sin tocar.
  const placeholderFor = (key: keyof EffectiveSettings, fallback: string) =>
    effective?.[key] ||
    t("hc_modulesCertificatesCourseCertificateSettingsDialog.globalPlaceholderPrefix", {
      fallback,
    });

  return (
    <Dialog open={!!course} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Award className="h-4 w-4 text-amber-500" />
            {t("hc_modulesCertificatesCourseCertificateSettingsDialog.dialogTitle", {
              course: course.name,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("hc_modulesCertificatesCourseCertificateSettingsDialog.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {loading || !draft ? (
          <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> {t("hc_modulesCertificatesCourseCertificateSettingsDialog.loading")}
          </div>
        ) : (
          <div className="space-y-4">
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                {t("hc_modulesCertificatesCourseCertificateSettingsDialog.alertPlaceholders")}
              </AlertDescription>
            </Alert>

            <div className="space-y-3">
              <h3 className="text-sm font-medium">{t("hc_modulesCertificatesCourseCertificateSettingsDialog.sectionInstitution")}</h3>
              <div>
                <Label>{t("hc_modulesCertificatesCourseCertificateSettingsDialog.labelInstitutionName")}</Label>
                <Input
                  value={draft.institution_name ?? ""}
                  onChange={(e) => setDraft({ ...draft, institution_name: e.target.value })}
                  placeholder={placeholderFor("institution_name", t("hc_modulesCertificatesCourseCertificateSettingsDialog.fallbackNoName"))}
                />
              </div>
              <div>
                <Label>{t("hc_modulesCertificatesCourseCertificateSettingsDialog.labelLogoUrl")}</Label>
                <Input
                  value={draft.institution_logo_url ?? ""}
                  onChange={(e) => setDraft({ ...draft, institution_logo_url: e.target.value })}
                  placeholder={placeholderFor("institution_logo_url", t("hc_modulesCertificatesCourseCertificateSettingsDialog.fallbackNoLogo"))}
                />
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t">
              <h3 className="text-sm font-medium">{t("hc_modulesCertificatesCourseCertificateSettingsDialog.sectionSignature")}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>{t("hc_modulesCertificatesCourseCertificateSettingsDialog.labelName")}</Label>
                  <Input
                    value={draft.signature_name ?? ""}
                    onChange={(e) => setDraft({ ...draft, signature_name: e.target.value })}
                    placeholder={placeholderFor("signature_name", t("hc_modulesCertificatesCourseCertificateSettingsDialog.fallbackNoSignature"))}
                  />
                </div>
                <div>
                  <Label>{t("hc_modulesCertificatesCourseCertificateSettingsDialog.labelTitle")}</Label>
                  <Input
                    value={draft.signature_title ?? ""}
                    onChange={(e) => setDraft({ ...draft, signature_title: e.target.value })}
                    placeholder={placeholderFor("signature_title", t("hc_modulesCertificatesCourseCertificateSettingsDialog.fallbackNoTitle"))}
                  />
                </div>
              </div>
              <div>
                <Label>{t("hc_modulesCertificatesCourseCertificateSettingsDialog.labelSignatureImageUrl")}</Label>
                <Input
                  value={draft.signature_image_url ?? ""}
                  onChange={(e) => setDraft({ ...draft, signature_image_url: e.target.value })}
                  placeholder={placeholderFor("signature_image_url", t("hc_modulesCertificatesCourseCertificateSettingsDialog.fallbackNoImage"))}
                />
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t">
              <h3 className="text-sm font-medium">{t("hc_modulesCertificatesCourseCertificateSettingsDialog.sectionText")}</h3>
              <div>
                <Label>
                  {t("hc_modulesCertificatesCourseCertificateSettingsDialog.labelMainMessage")}{" "}
                  <HelpHint>
                    {t("hc_modulesCertificatesCourseCertificateSettingsDialog.helpPlaceholdersIntro")}{" "}
                    <code>{"{student}"}</code>, <code>{"{course}"}</code>,{" "}
                    <code>{"{grade}"}</code>, <code>{"{period}"}</code>, <code>{"{teacher}"}</code>,{" "}
                    <code>{"{date}"}</code>.
                  </HelpHint>
                </Label>
                <Textarea
                  value={draft.certificate_message ?? ""}
                  onChange={(e) => setDraft({ ...draft, certificate_message: e.target.value })}
                  rows={4}
                  placeholder={placeholderFor("certificate_message", t("hc_modulesCertificatesCourseCertificateSettingsDialog.fallbackDefaultMessage"))}
                />
              </div>
              <div>
                <Label>{t("hc_modulesCertificatesCourseCertificateSettingsDialog.labelFooter")}</Label>
                <Input
                  value={draft.footer_text ?? ""}
                  onChange={(e) => setDraft({ ...draft, footer_text: e.target.value })}
                  placeholder={placeholderFor("footer_text", t("hc_modulesCertificatesCourseCertificateSettingsDialog.fallbackNoFooter"))}
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
              {t("hc_modulesCertificatesCourseCertificateSettingsDialog.backToGlobal")}
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("hc_modulesCertificatesCourseCertificateSettingsDialog.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || loading}>
            {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            {t("hc_modulesCertificatesCourseCertificateSettingsDialog.saveOverride")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
