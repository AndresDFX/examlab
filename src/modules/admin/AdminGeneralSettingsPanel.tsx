/**
 * Panel de parámetros globales de la aplicación (Admin).
 *
 * Cubre defaults transversales que no tienen un módulo propio:
 *   - Defaults para CURSOS nuevos: escala 0-N, nota mínima.
 *   - Defaults para EXÁMENES nuevos: max_warnings, navegación, max_attempts.
 *   - Threshold de alerta de correos en 24h (con cooldown).
 *
 * Singleton: una sola fila en `app_settings` (default sembrada por migración).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Save, Info, Mail, FileText, GraduationCap, BellRing } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface AppSettings {
  id: string;
  default_grade_scale_min: number;
  default_grade_scale_max: number;
  default_passing_grade: number;
  default_exam_max_warnings: number;
  default_exam_navigation: "libre" | "secuencial";
  default_exam_max_attempts: number;
  default_workshop_max_attempts: number;
  default_project_max_attempts: number;
  require_exam_fullscreen: boolean;
  question_bank_enabled: boolean;
  max_open_answer_chars: number;
  email_alert_threshold_24h: number;
  email_alert_cooldown_hours: number;
  /** Horas antes del vencimiento en que se avisa al alumno (recordatorio de
   *  entrega de taller/proyecto). Default 1. El cron revisa cada 15 min y
   *  manda UN solo aviso por entrega. */
  due_reminder_lead_hours: number;
  updated_at: string;
}

export function AdminGeneralSettingsPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [row, setRow] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db.from("app_settings").select("*").maybeSingle();
    if (error) {
      setLoadError(
        friendlyError(
          error,
          t("adminGeneralSettings.loadErrorFallback", {
            defaultValue: "No pudimos cargar los parámetros.",
          }),
        ),
      );
      setLoading(false);
      return;
    }
    if (data) {
      // Coalesce de campos que pueden faltar si la migración aún no se publicó
      // (mantiene el Input controlado y no rompe el panel pre-Publish).
      const r = { ...data, due_reminder_lead_hours: data.due_reminder_lead_hours ?? 1 } as AppSettings;
      setRow(r);
      setDraft(r);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const dirty = !!draft && !!row && JSON.stringify(draft) !== JSON.stringify(row);

  const save = async () => {
    if (!user || !draft || !row) return;
    // Validación cruzada: passing_grade ∈ [min, max]
    if (
      draft.default_passing_grade < draft.default_grade_scale_min ||
      draft.default_passing_grade > draft.default_grade_scale_max
    ) {
      toast.error(
        i18n.t("toast.modules_admin_AdminGeneralSettingsPanel.passingGradeOutOfRange", {
          defaultValue:
            "La nota mínima de aprobación debe estar entre {{min}} y {{max}}",
          min: draft.default_grade_scale_min,
          max: draft.default_grade_scale_max,
        }),
      );
      return;
    }
    if (draft.default_grade_scale_max <= draft.default_grade_scale_min) {
      toast.error(
        i18n.t("toast.modules_admin_AdminGeneralSettingsPanel.maxGradeMustExceedMin", {
          defaultValue: "La nota máxima debe ser mayor a la mínima",
        }),
      );
      return;
    }
    if (draft.max_open_answer_chars < 100 || draft.max_open_answer_chars > 50000) {
      toast.error(
        i18n.t("toast.modules_admin_AdminGeneralSettingsPanel.openAnswerCharsOutOfRange", {
          defaultValue: "Máx. caracteres de respuesta abierta debe estar entre 100 y 50000",
        }),
      );
      return;
    }
    if (draft.due_reminder_lead_hours < 1 || draft.due_reminder_lead_hours > 168) {
      toast.error(
        i18n.t("toast.modules_admin_AdminGeneralSettingsPanel.dueReminderLeadOutOfRange", {
          defaultValue: "El recordatorio de entregas debe estar entre 1 y 168 horas antes.",
        }),
      );
      return;
    }
    setSaving(true);
    try {
      const { error } = await db
        .from("app_settings")
        .update({
          default_grade_scale_min: draft.default_grade_scale_min,
          default_grade_scale_max: draft.default_grade_scale_max,
          default_passing_grade: draft.default_passing_grade,
          default_exam_max_warnings: draft.default_exam_max_warnings,
          default_exam_navigation: draft.default_exam_navigation,
          default_exam_max_attempts: draft.default_exam_max_attempts,
          default_workshop_max_attempts: draft.default_workshop_max_attempts,
          default_project_max_attempts: draft.default_project_max_attempts,
          require_exam_fullscreen: draft.require_exam_fullscreen,
          question_bank_enabled: draft.question_bank_enabled,
          max_open_answer_chars: draft.max_open_answer_chars,
          email_alert_threshold_24h: draft.email_alert_threshold_24h,
          email_alert_cooldown_hours: draft.email_alert_cooldown_hours,
          due_reminder_lead_hours: draft.due_reminder_lead_hours,
          updated_by: user.id,
        })
        .eq("id", row.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "app_settings.updated",
        category: "system",
        severity: "warning",
        metadata: { previous: row, new: draft },
      });
      toast.success(
        i18n.t("toast.modules_admin_AdminGeneralSettingsPanel.savedOk", {
          defaultValue: "Parámetros guardados",
        }),
      );
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <ErrorState
        message={t("adminGeneralSettings.loadErrorTitle")}
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  if (loading || !draft) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="sm" /> {t("adminGeneralSettings.loadingParams")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Defaults de cursos */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-blue-500" />
            {t("adminGeneralSettings.cardCoursesTitle")}
            <HelpHint>{t("help.courseDefaultsHint")}</HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label>{t("adminGeneralSettings.labelScaleMin")}</Label>
            <Input
              type="number"
              step="0.1"
              value={draft.default_grade_scale_min}
              onChange={(e) =>
                setDraft({ ...draft, default_grade_scale_min: Number(e.target.value) })
              }
            />
          </div>
          <div>
            <Label>{t("adminGeneralSettings.labelScaleMax")}</Label>
            <Input
              type="number"
              step="0.1"
              value={draft.default_grade_scale_max}
              onChange={(e) =>
                setDraft({ ...draft, default_grade_scale_max: Number(e.target.value) })
              }
            />
            <p className="text-[11px] text-muted-foreground mt-1">{t("adminGeneralSettings.hintScaleMax")}</p>
          </div>
          <div>
            <Label>{t("adminGeneralSettings.labelPassingGrade")}</Label>
            <Input
              type="number"
              step="0.1"
              value={draft.default_passing_grade}
              onChange={(e) =>
                setDraft({ ...draft, default_passing_grade: Number(e.target.value) })
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Defaults de exámenes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-violet-500" />
            {t("adminGeneralSettings.cardExamsTitle")}
            <HelpHint>{t("help.examDefaultsHint")}</HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label>{t("adminGeneralSettings.labelMaxWarnings")}</Label>
            <Input
              type="number"
              min={0}
              max={20}
              value={draft.default_exam_max_warnings}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  default_exam_max_warnings: Number(e.target.value),
                })
              }
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              {t("adminGeneralSettings.hintMaxWarnings")}
            </p>
          </div>
          <div>
            <Label>{t("adminGeneralSettings.labelNavigation")}</Label>
            <Select
              value={draft.default_exam_navigation}
              onValueChange={(v) =>
                setDraft({
                  ...draft,
                  default_exam_navigation: v as "libre" | "secuencial",
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="libre">{t("adminGeneralSettings.navFree")}</SelectItem>
                <SelectItem value="secuencial">{t("adminGeneralSettings.navSequential")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("adminGeneralSettings.labelMaxAttemptsExam")}</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={draft.default_exam_max_attempts}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  default_exam_max_attempts: Number(e.target.value),
                })
              }
            />
          </div>
          <div>
            <Label className="flex items-center gap-1.5">
              {t("adminGeneralSettings.labelMaxAttemptsWorkshop")}
              <HelpHint>{t("help.workshopMaxAttempts")}</HelpHint>
            </Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={draft.default_workshop_max_attempts}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  default_workshop_max_attempts: Number(e.target.value),
                })
              }
            />
          </div>
          <div>
            <Label className="flex items-center gap-1.5">
              {t("adminGeneralSettings.labelMaxAttemptsProject")}
              <HelpHint>{t("help.projectMaxAttempts")}</HelpHint>
            </Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={draft.default_project_max_attempts}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  default_project_max_attempts: Number(e.target.value),
                })
              }
            />
          </div>
          <div className="sm:col-span-3">
            <Label className="flex items-center gap-1.5">
              {t("adminGeneralSettings.labelMaxOpenChars")}
              <HelpHint>
                {t("help.maxOpenAnswerChars", {
                  defaultValue:
                    'Tope de caracteres que el alumno puede escribir en una pregunta tipo "abierta". Aplica a nivel frontend (Textarea con maxLength). Default 500 — fuerza respuestas concisas (1-2 párrafos) y mantiene bajo el costo de tokens de la IA al calificar. Subir hasta 50000 si necesitas ensayos largos. Rango permitido: 100..50000.',
                })}
              </HelpHint>
            </Label>
            <Input
              type="number"
              min={100}
              max={50000}
              step={100}
              value={draft.max_open_answer_chars}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  max_open_answer_chars: Number(e.target.value),
                })
              }
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              {t("adminGeneralSettings.hintOpenCharsPrefix", {
                defaultValue: "Solo afecta preguntas ",
              })}
              <code className="text-[10px]">abierta</code>
              {t("adminGeneralSettings.hintOpenCharsSuffix", {
                defaultValue:
                  ". Las de código, diagrama, java_gui, python_gui y opción múltiple tienen sus propios límites.",
              })}
            </p>
          </div>
          <div className="sm:col-span-3">
            <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/40">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={draft.require_exam_fullscreen}
                onChange={(e) => setDraft({ ...draft, require_exam_fullscreen: e.target.checked })}
              />
              <div className="flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {t("adminGeneralSettings.labelFullscreen")}
                  <HelpHint>{t("help.requireExamFullscreen")}</HelpHint>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {draft.require_exam_fullscreen
                    ? t("adminGeneralSettings.fullscreenActive")
                    : t("adminGeneralSettings.fullscreenInactive")}
                </p>
              </div>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Módulos opcionales — gestión movida al tab "Módulos" del panel.
          Antes había acá un toggle individual para Banco de preguntas y
          se planeaba extender con más; pero la matriz módulo × rol +
          display_order del tab Módulos ya cubre el caso de forma
          consistente con el resto de toggles. Mantener dos UIs llevaba
          a confusión sobre cuál ganaba. */}

      {/* Recordatorios de entregas */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BellRing className="h-4 w-4 text-amber-500" />
            {t("adminGeneralSettings.cardDueReminderTitle", {
              defaultValue: "Recordatorios de entregas",
            })}
            <HelpHint>
              {t("help.dueReminderLead", {
                defaultValue:
                  "Cuánto tiempo antes del vencimiento se avisa al alumno (taller/proyecto que aún no entrega). El sistema revisa cada 15 minutos y manda UN solo recordatorio por entrega — no se repite.",
              })}
            </HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-w-xs">
            <Label>
              {t("adminGeneralSettings.labelDueReminderLead", {
                defaultValue: "Avisar (horas antes del vencimiento)",
              })}
            </Label>
            <Input
              type="number"
              min={1}
              max={168}
              value={draft.due_reminder_lead_hours}
              onChange={(e) =>
                setDraft({ ...draft, due_reminder_lead_hours: Number(e.target.value) })
              }
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              {t("adminGeneralSettings.hintDueReminderLead", {
                defaultValue:
                  "Por defecto 1 hora. Rango 1–168 (hasta 7 días). Solo a quienes no han entregado.",
              })}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Alerta de correos */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-cyan-500" />
            {t("adminGeneralSettings.cardEmailAlertTitle")}
            <HelpHint>{t("help.emailAlertThreshold")}</HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>{t("adminGeneralSettings.labelThreshold")}</Label>
              <Input
                type="number"
                min={0}
                value={draft.email_alert_threshold_24h}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    email_alert_threshold_24h: Number(e.target.value),
                  })
                }
                placeholder={t("adminGeneralSettings.thresholdPlaceholder", {
                  defaultValue: "0 = desactivado",
                })}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("adminGeneralSettings.hintThreshold")}
              </p>
            </div>
            <div>
              <Label>{t("adminGeneralSettings.labelCooldown")}</Label>
              <Input
                type="number"
                min={1}
                max={168}
                value={draft.email_alert_cooldown_hours}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    email_alert_cooldown_hours: Number(e.target.value),
                  })
                }
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("adminGeneralSettings.hintCooldown")}
              </p>
            </div>
          </div>
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {t("adminGeneralSettings.alertCronNote")}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Save bar */}
      <div className="flex flex-wrap gap-2 justify-end">
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(row)} disabled={saving}>
            {t("adminGeneralSettings.btnCancel")}
          </Button>
        )}
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          {t("adminGeneralSettings.btnSave")}
        </Button>
      </div>
    </div>
  );
}
