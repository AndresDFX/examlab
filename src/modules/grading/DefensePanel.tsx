/**
 * Panel de SUSTENTACIÓN dentro del diálogo de calificación.
 *
 * El modelo es el mismo en proyectos y en talleres: la nota final NO es la del
 * trabajo entregado, es `nota de la entrega × factor de sustentación`. Mientras
 * el factor esté vacío la nota final no existe («Falta sustentación»), porque
 * el trabajo entregado todavía no es la nota de nadie.
 *
 * Vive acá y no dentro de una ruta porque lo usan dos flujos distintos y la
 * fórmula tiene que ser la misma en los dos: si una pantalla redondeara
 * diferente, la misma sustentación valdría distinto según desde dónde se
 * registró.
 *
 * ── El video es OPCIONAL y su soporte depende del flujo ───────────────
 * En proyectos se puede pegar un enlace **o subir el archivo** al bucket
 * `project-files`. En talleres solo enlace: el bucket `workshop-files` tiene
 * una lista blanca de tipos que no incluye video y topa en 50 MB, y subirle el
 * tope afectaría también a lo que suben los ESTUDIANTES —y al cupo de
 * almacenamiento de la institución— para resolver algo que la grabación de la
 * videollamada ya cubre con un enlace. Por eso `subida` es opcional: sin ella
 * el panel muestra solo el campo de enlace.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Upload, Video } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/shared/lib/db-errors";

/** La entrega, con lo único que este panel necesita de ella. */
export interface DefenseSubmission {
  id: string;
  submission_grade?: number | null;
  ai_grade?: number | null;
  defense_factor?: number | null;
  defense_notes?: string | null;
  defense_video_url?: string | null;
}

export interface DefensePanelProps {
  sub: DefenseSubmission;
  maxScore: number;
  /**
   * Persiste la sustentación. `subGradeOverride` va `undefined` cuando el
   * docente NO tocó la nota del trabajo, para que el cálculo del servidor siga
   * mandando en vez de quedar congelado en lo que la pantalla leyó.
   */
  onSave: (
    subId: string,
    factor: number | null,
    notes: string,
    videoUrl?: string | null,
    subGradeOverride?: number | null,
  ) => Promise<void>;
  /** Con esto el video además se puede SUBIR. Sin esto, solo enlace. */
  subida?: {
    bucket: string;
    /** Carpeta raíz dentro del bucket; las policies exigen que sea el uid. */
    carpetaPorUsuario?: boolean;
  };
}

export function DefensePanel({ sub, maxScore, onSave, subida }: DefensePanelProps) {
  const { t } = useTranslation();
  const [factor, setFactor] = useState<string>(
    sub.defense_factor != null ? String(sub.defense_factor) : "",
  );
  const [notes, setNotes] = useState<string>(sub.defense_notes ?? "");
  const [saving, setSaving] = useState(false);
  // Nota de la entrega EDITABLE. Normalmente la calcula el servidor (la IA
  // suma las respuestas), pero el docente puede corregirla si la ponderación
  // quedó mal. Vacío = no mandar override, que el servidor siga mandando.
  const baseInicial =
    sub.submission_grade != null
      ? String(sub.submission_grade)
      : sub.ai_grade != null
        ? String(sub.ai_grade)
        : "";
  const [subGradeStr, setSubGradeStr] = useState<string>(baseInicial);
  // Guarda un enlace externo (http…) o un path del bucket (subido). El input
  // de enlace solo refleja el primer caso; el subido se ve como un chip.
  const [videoUrl, setVideoUrl] = useState<string>(sub.defense_video_url ?? "");
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const isExternalUrl = /^https?:\/\//i.test(videoUrl);

  const handleUploadVideo = async (file: File) => {
    if (!subida) return;
    setUploadingVideo(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        toast.error(t("defense.notAuthenticated"));
        return;
      }
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${u.user.id}/defense/${sub.id}-${safe}`;
      const { error } = await supabase.storage
        .from(subida.bucket)
        .upload(path, file, { upsert: true });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setVideoUrl(path);
      toast.success(t("defense.videoUploaded"));
    } catch (e) {
      // Un throw del upload (red caída, archivo ilegible) se perdía sin ningún
      // aviso: el spinner paraba y el video no quedaba adjunto.
      toast.error(friendlyError(e));
    } finally {
      setUploadingVideo(false);
    }
  };

  const openVideo = async () => {
    if (!videoUrl) return;
    if (/^https?:\/\//i.test(videoUrl)) {
      window.open(videoUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (!subida) return;
    const { data, error } = await supabase.storage
      .from(subida.bucket)
      .createSignedUrl(videoUrl, 120);
    if (error || !data?.signedUrl) {
      toast.error(friendlyError(error, t("defense.couldNotOpenVideo")));
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const baselineSubGrade: number | null = sub.submission_grade ?? sub.ai_grade ?? null;
  const subGradeNumRaw = subGradeStr.trim() === "" ? null : Number(subGradeStr.replace(",", "."));
  const subGradeValid =
    subGradeNumRaw == null ||
    (!Number.isNaN(subGradeNumRaw) && subGradeNumRaw >= 0 && subGradeNumRaw <= maxScore);
  const effectiveSubGrade =
    subGradeNumRaw != null && subGradeValid ? subGradeNumRaw : baselineSubGrade;
  const subGradeChanged =
    subGradeNumRaw != null &&
    subGradeValid &&
    (baselineSubGrade == null || Number(baselineSubGrade) !== subGradeNumRaw);
  const factorNum = factor.trim() === "" ? null : Number(factor.replace(",", "."));
  const factorValid = factorNum == null || (!Number.isNaN(factorNum) && factorNum >= 0 && factorNum <= 1);
  const previewFinal =
    effectiveSubGrade != null && factorNum != null && factorValid
      ? Number((Number(effectiveSubGrade) * factorNum).toFixed(2))
      : null;

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="p-3 space-y-2">
        <div className="text-sm font-medium">{t("defense.title")}</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground text-2xs">
              {t("defense.submissionGrade")} <span className="text-3xs">(/{maxScore})</span>
            </div>
            <Input
              type="text"
              inputMode="decimal"
              placeholder={baselineSubGrade != null ? String(baselineSubGrade) : "0"}
              value={subGradeStr}
              onChange={(e) => setSubGradeStr(e.target.value)}
              className="h-8 text-xs font-mono tabular-nums"
            />
            {!subGradeValid && <p className="text-3xs text-destructive mt-0.5">0 — {maxScore}</p>}
            {subGradeChanged && subGradeValid && (
              <p className="text-3xs text-warning-on-subtle mt-0.5">
                {t("defense.overridesAuto", { value: baselineSubGrade ?? 0 })}
              </p>
            )}
          </div>
          <div>
            <div className="text-muted-foreground text-2xs flex items-center gap-1">
              {t("defense.factor01")}
              <HelpHint>{t("help.defenseFactorHelp")}</HelpHint>
            </div>
            <Input
              type="text"
              inputMode="decimal"
              placeholder={t("defense.factorPlaceholder")}
              value={factor}
              onChange={(e) => setFactor(e.target.value)}
              className="h-8 text-xs"
            />
            {!factorValid && (
              <p className="text-3xs text-destructive mt-0.5">{t("defense.factorRange")}</p>
            )}
          </div>
          <div>
            <div className="text-muted-foreground text-2xs">{t("defense.finalGradeFormula")}</div>
            <div className="font-mono tabular-nums font-semibold">
              {previewFinal != null ? `${previewFinal}/${maxScore}` : "—"}
            </div>
          </div>
        </div>
        <Textarea
          rows={2}
          placeholder={t("defense.notesPlaceholder")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="text-xs"
        />
        <div className="space-y-1">
          <div className="text-muted-foreground text-2xs">{t("defense.videoLabel")}</div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="url"
              placeholder={t("defense.videoLinkPlaceholder")}
              value={isExternalUrl ? videoUrl : ""}
              onChange={(e) => setVideoUrl(e.target.value)}
              className="h-8 text-xs flex-1 min-w-[160px] sm:min-w-[180px]"
            />
            {subida && (
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 h-8 px-2.5 rounded-md border text-xs hover:bg-muted/50">
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.currentTarget.value = "";
                    if (f) void handleUploadVideo(f);
                  }}
                />
                {uploadingVideo ? <Spinner size="sm" /> : <Upload className="h-3.5 w-3.5" />}
                {t("defense.upload")}
              </label>
            )}
          </div>
          {videoUrl && (
            <div className="flex items-center gap-2 text-2xs">
              <button
                type="button"
                onClick={() => void openVideo()}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <Video className="h-3.5 w-3.5" /> {t("defense.viewVideo")}{" "}
                {isExternalUrl ? t("defense.viewVideoLink") : t("defense.viewVideoUploaded")}
              </button>
              <button
                type="button"
                onClick={() => setVideoUrl("")}
                className="text-muted-foreground hover:text-destructive"
              >
                {t("defense.remove")}
              </button>
            </div>
          )}
          <p className="text-3xs text-muted-foreground">
            {subida ? t("defense.videoTip") : t("defense.videoTipLinkOnly")}
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={async () => {
              if (!factorValid || !subGradeValid) return;
              setSaving(true);
              try {
                await onSave(
                  sub.id,
                  factorNum,
                  notes,
                  videoUrl,
                  subGradeChanged ? subGradeNumRaw : undefined,
                );
              } catch (e) {
                // El caller toastea los errores de Supabase, pero un throw
                // (red caída) llegaba acá y se perdía en silencio.
                toast.error(friendlyError(e));
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving || !factorValid || !subGradeValid}
          >
            {saving ? <Spinner size="sm" className="mr-1" /> : null}
            {t("defense.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
