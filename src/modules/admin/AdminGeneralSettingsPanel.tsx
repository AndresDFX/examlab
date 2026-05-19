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
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
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
import { Save, Info, Settings as SettingsIcon, Mail, FileText, GraduationCap } from "lucide-react";

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
  updated_at: string;
}

export function AdminGeneralSettingsPanel() {
  const { user } = useAuth();
  const [row, setRow] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db.from("app_settings").select("*").maybeSingle();
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    if (data) {
      const r = data as AppSettings;
      setRow(r);
      setDraft(r);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const dirty = !!draft && !!row && JSON.stringify(draft) !== JSON.stringify(row);

  const save = async () => {
    if (!user || !draft || !row) return;
    // Validación cruzada: passing_grade ∈ [min, max]
    if (
      draft.default_passing_grade < draft.default_grade_scale_min ||
      draft.default_passing_grade > draft.default_grade_scale_max
    ) {
      toast.error(
        `La nota mínima de aprobación debe estar entre ${draft.default_grade_scale_min} y ${draft.default_grade_scale_max}`,
      );
      return;
    }
    if (draft.default_grade_scale_max <= draft.default_grade_scale_min) {
      toast.error("La nota máxima debe ser mayor a la mínima");
      return;
    }
    if (draft.max_open_answer_chars < 100 || draft.max_open_answer_chars > 50000) {
      toast.error("Máx. caracteres de respuesta abierta debe estar entre 100 y 50000");
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
          updated_by: user.id,
        })
        .eq("id", row.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      void logEvent({
        action: "app_settings.updated",
        category: "system",
        severity: "warning",
        metadata: { previous: row, new: draft },
      });
      toast.success("Parámetros guardados");
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading || !draft) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="sm" /> Cargando parámetros…
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
            Defaults para cursos nuevos
            <HelpHint>
              Estos valores se aplican al crear un curso. El docente/admin puede modificarlos por
              curso.
            </HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label>Nota mínima de la escala</Label>
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
            <Label>Nota máxima de la escala</Label>
            <Input
              type="number"
              step="0.1"
              value={draft.default_grade_scale_max}
              onChange={(e) =>
                setDraft({ ...draft, default_grade_scale_max: Number(e.target.value) })
              }
            />
            <p className="text-[11px] text-muted-foreground mt-1">Colombia: 0-5. Otros: 0-10.</p>
          </div>
          <div>
            <Label>Nota mínima de aprobación</Label>
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
            Defaults para exámenes nuevos
            <HelpHint>
              Valores precargados al crear un examen. Cada docente puede sobrescribir por examen.
            </HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label>Máximo de advertencias (proctoring)</Label>
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
              Cuántos strikes antes de marcar sospechoso.
            </p>
          </div>
          <div>
            <Label>Navegación</Label>
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
                <SelectItem value="libre">Libre</SelectItem>
                <SelectItem value="secuencial">Secuencial (sin retroceso)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Intentos máximos exámenes</Label>
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
              Intentos máx. talleres
              <HelpHint>
                Cuántas veces puede entregar un alumno un taller. Default global; el docente puede
                sobreescribirlo por taller individual.
              </HelpHint>
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
              Intentos máx. proyectos
              <HelpHint>
                Cuántas veces puede entregar un alumno un proyecto. Default global; el docente puede
                sobreescribirlo por proyecto.
              </HelpHint>
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
              Máx. caracteres en respuesta abierta
              <HelpHint>
                Tope de caracteres que el alumno puede escribir en una pregunta tipo "abierta".
                Aplica a nivel frontend (Textarea con maxLength). Default 500 — fuerza respuestas
                concisas (1-2 párrafos) y mantiene bajo el costo de tokens de la IA al calificar.
                Subir hasta 50000 si necesitas ensayos largos. Rango permitido: 100..50000.
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
              Solo afecta preguntas <code className="text-[10px]">abierta</code>. Las de código,
              diagrama, java_gui y opción múltiple tienen sus propios límites.
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
                  Requerir pantalla completa
                  <HelpHint>
                    Si está activo (recomendado), los exámenes exigen pantalla completa y la salida
                    cuenta como strike. Desactívalo solo para depuración/soporte — sin pantalla
                    completa el alumno puede tener herramientas externas a la vista.
                  </HelpHint>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {draft.require_exam_fullscreen
                    ? "Activo — los exámenes corren en pantalla completa obligatoria."
                    : "Desactivado — los exámenes corren en ventana normal (modo depuración). Los strikes por fullscreen_exit NO aplican."}
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

      {/* Alerta de correos */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-cyan-500" />
            Alerta de volumen de correos
            <HelpHint>
              Si los correos enviados en las últimas 24h exceden el umbral, todos los admins reciben
              una notificación. Útil para detectar bucles de notificación o picos de actividad
              inesperados.
            </HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Umbral (correos / 24h)</Label>
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
                placeholder="0 = desactivado"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                0 desactiva la alerta. Recomendado: ajustar según volumen típico × 1.5.
              </p>
            </div>
            <div>
              <Label>Cooldown (horas entre alertas)</Label>
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
                Evita ráfagas de alertas si el problema persiste.
              </p>
            </div>
          </div>
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              La revisión corre automáticamente cada 30 min vía cron{" "}
              <code className="text-[11px]">email-alert-threshold</code>. Asegúrate de que el cron
              esté activo en <strong>Admin → Sistema → Tareas programadas</strong>.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Save bar */}
      <div className="flex flex-wrap gap-2 justify-end">
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(row)} disabled={saving}>
            Cancelar
          </Button>
        )}
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          Guardar parámetros
        </Button>
      </div>
    </div>
  );
}
