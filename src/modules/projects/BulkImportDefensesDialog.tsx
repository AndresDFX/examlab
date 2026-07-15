/**
 * Dialog para importar sustentaciones de proyecto en bulk via CSV.
 *
 * Flujo:
 *   1. Docente abre el dialog desde el header de "Calificaciones".
 *   2. Descarga el template (header + filas demo).
 *   3. Carga el CSV editado.
 *   4. Preview: filas válidas + filas con error + filas sin entrega previa.
 *      El docente puede revisar antes de aplicar.
 *   5. "Aplicar" → para cada fila válida:
 *      - resolver email → `profiles.id` (1 query con `.in("institutional_email", emails)`)
 *      - buscar submission del proyecto (filtrando por user_id; si está en
 *        un grupo, la submission del grupo se comparte → la dedup descarta
 *        duplicados de grupo).
 *      - UPDATE de `defense_factor`, `defense_notes`, `defense_video_url`,
 *        `defense_at = now()`, `status` y `final_grade = submission_grade × factor`.
 *
 * El `final_grade` se calcula desde el cliente (mismo patrón que el form
 * manual `saveDefense` de `app.teacher.projects.tsx`) porque la columna NO
 * es generada automáticamente — se persiste explícitamente al sustentar.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileDown, FileUp, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { downloadCSV, parseCSV, readCsvFile } from "@/shared/lib/csv";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  DEFENSES_TEMPLATE,
  parseDefenseCsv,
  dedupeBySubmission,
  type ParsedDefenseRow,
  type DefenseCsvError,
} from "./defense-csv";

const db = supabase as any;

interface Submission {
  id: string;
  user_id: string | null;
  group_id?: string | null;
  submission_grade: number | null;
  ai_grade: number | null;
}

interface BulkImportDefensesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** El proyecto al que pertenecen las entregas. */
  projectId: string;
  projectTitle: string;
  /** max_score del proyecto — clamp final del newFinal. */
  maxScore: number;
  /** Submissions actualmente en memoria del dialog padre. Se usa para
   *  resolver email → submission sin pegarle a la DB de nuevo. */
  submissions: Array<
    Submission & {
      profile?: { full_name: string; institutional_email: string };
    }
  >;
  /** Callback que el padre usa para actualizar su state local con las
   *  filas aplicadas. Recibe una map `submissionId → updates`. */
  onApplied: (
    updates: Map<
      string,
      {
        defense_factor: number;
        defense_notes: string | null;
        defense_video_url: string | null;
        defense_at: string;
        final_grade: number;
        status: string;
      }
    >,
  ) => void;
}

export function BulkImportDefensesDialog({
  open,
  onOpenChange,
  projectId,
  projectTitle,
  maxScore,
  submissions,
  onApplied,
}: BulkImportDefensesDialogProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedDefenseRow[]>([]);
  const [parseErrors, setParseErrors] = useState<DefenseCsvError[]>([]);
  const [emailsNoSubmission, setEmailsNoSubmission] = useState<ParsedDefenseRow[]>([]);
  const [emailsNoGrade, setEmailsNoGrade] = useState<ParsedDefenseRow[]>([]);
  const [duplicateGroup, setDuplicateGroup] = useState<ParsedDefenseRow[]>([]);
  const [readyToApply, setReadyToApply] = useState<
    Array<ParsedDefenseRow & { submission_id: string; submission_grade: number }>
  >([]);
  const [fileName, setFileName] = useState<string>("");
  const [applying, setApplying] = useState(false);

  const reset = () => {
    setParsedRows([]);
    setParseErrors([]);
    setEmailsNoSubmission([]);
    setEmailsNoGrade([]);
    setDuplicateGroup([]);
    setReadyToApply([]);
    setFileName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleDownloadTemplate = () => {
    downloadCSV("template-sustentaciones.csv", DEFENSES_TEMPLATE);
    toast.success(
      t("hc_bulkImportDefenses.templateDownloaded", {
        defaultValue: "Plantilla descargada",
      }),
    );
  };

  const handlePickFile = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    try {
      // Detección de charset (UTF-8 con fallback a Windows-1252): un CSV
      // exportado desde Excel en Windows viene en Latin-1 y `file.text()`
      // (UTF-8) lo dejaba con mojibake en tildes/ñ. Ver `readCsvFile`.
      const text = await readCsvFile(file);
      const csvRows = parseCSV(text);
      if (!csvRows.length) {
        toast.error(
          t("hc_bulkImportDefenses.emptyFile", {
            defaultValue: "El archivo no contiene datos",
          }),
        );
        return;
      }
      const { rows, errors } = parseDefenseCsv(csvRows);
      // Guard anti-desalineación de columnas: el CSV es delimitado por coma, así que
      // un factor con coma decimal ("0,8") parte la fila en columnas de más y el
      // factor quedaría en "0" → nota final 0 EN SILENCIO. Rechazamos toda fila SIN
      // comillas cuyo número de campos difiera del header (las filas con comillas las
      // maneja parseCSV; no las tocamos para no dar falsos positivos con notas que
      // legítimamente contengan comas entre comillas).
      const rawLines = text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      const headerCount = (rawLines[0] ?? "").split(",").length;
      const colErrors: DefenseCsvError[] = [];
      for (let i = 1; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (line.includes('"')) continue;
        const n = line.split(",").length;
        if (n !== headerCount) {
          colErrors.push({
            line: i + 1,
            message: t("hc_bulkImportDefenses.colCountError", {
              defaultValue:
                "Fila {{line}}: número de columnas inesperado ({{got}} vs {{exp}}) — ¿usaste coma decimal? Usa punto (ej. 0.8).",
              line: i + 1,
              got: n,
              exp: headerCount,
            }),
          });
        }
      }
      const badLines = new Set(colErrors.map((e) => e.line));
      const safeRows = rows.filter((r) => !badLines.has(r.line));
      setParsedRows(safeRows);
      setParseErrors([...errors, ...colErrors].sort((a, b) => a.line - b.line));

      // Resolver email → submission usando submissions ya cargadas en el
      // dialog padre (NO hace falta query). Para grupos, todos los miembros
      // del grupo apuntan a la misma submission (group_id), pero solo el
      // user_id del "último editor" está en el field user_id. Para resolver
      // por email, miramos el profile.institutional_email de cada submission.
      // Eso cubre el caso "individual" (la submission del email match) y
      // el caso "grupo donde el email del CSV es el último editor". NO
      // cubre el caso "grupo donde el email NO es el último editor" —
      // para eso necesitaríamos consultar project_group_members.
      const submissionIdByEmail = new Map<string, string>();
      const submissionGradeById = new Map<string, number>();
      for (const sub of submissions) {
        const email = sub.profile?.institutional_email?.toLowerCase();
        if (email) submissionIdByEmail.set(email, sub.id);
        const subGrade = sub.submission_grade ?? sub.ai_grade;
        if (subGrade != null) submissionGradeById.set(sub.id, Number(subGrade));
      }

      // Para grupos: el CSV puede traer cualquier miembro. Tenemos que
      // buscar TODOS los miembros de los grupos del proyecto y mapear sus
      // emails a la submission del grupo correspondiente.
      const groupSubs = submissions.filter((s) => s.group_id);
      if (groupSubs.length > 0) {
        const groupIds = Array.from(
          new Set(groupSubs.map((s) => s.group_id).filter((g): g is string => !!g)),
        );
        // Query members con sus emails. Usamos un join 2-step: ids → users.
        const { data: members } = await db
          .from("project_group_members")
          .select("group_id, user_id")
          .in("group_id", groupIds);
        const memberRows = (members ?? []) as Array<{ group_id: string; user_id: string }>;
        const memberUserIds = Array.from(new Set(memberRows.map((m) => m.user_id)));
        if (memberUserIds.length > 0) {
          const { data: profiles } = await db
            .from("profiles")
            .select("id, institutional_email")
            .in("id", memberUserIds);
          const emailByUserId = new Map<string, string>();
          for (const p of (profiles ?? []) as Array<{ id: string; institutional_email: string }>) {
            if (p.institutional_email) {
              emailByUserId.set(p.id, p.institutional_email.toLowerCase());
            }
          }
          // Para cada miembro, el email → submission del grupo
          for (const m of memberRows) {
            const email = emailByUserId.get(m.user_id);
            if (!email) continue;
            const subOfGroup = groupSubs.find((s) => s.group_id === m.group_id);
            if (subOfGroup) submissionIdByEmail.set(email, subOfGroup.id);
          }
        }
      }

      // safeRows (NO rows): las filas descartadas por el guard de desalineación
      // de columnas NO deben llegar a aplicarse. Con `rows` una fila mal alineada
      // tipo `email,0,8,,` (factor "0") pasaba a toApply → final_grade =
      // submission_grade × 0 = 0, en SILENCIO, pese a mostrarse como error.
      const dedup = dedupeBySubmission(safeRows, submissionIdByEmail);
      setEmailsNoSubmission(dedup.skippedNoSubmission);
      setDuplicateGroup(dedup.skippedDuplicateGroup);

      // Filtrar también las que NO tienen submission_grade — no podemos
      // calcular final_grade = submission_grade × factor sin la nota base.
      // (Mismo gate del form manual `saveDefense`.)
      const ready: Array<ParsedDefenseRow & { submission_id: string; submission_grade: number }> =
        [];
      const noGrade: ParsedDefenseRow[] = [];
      for (const r of dedup.toApply) {
        const subGrade = submissionGradeById.get(r.submission_id);
        if (subGrade == null) {
          noGrade.push(r);
          continue;
        }
        ready.push({ ...r, submission_grade: subGrade });
      }
      setReadyToApply(ready);
      setEmailsNoGrade(noGrade);
    } catch (err: any) {
      toast.error(
        t("hc_bulkImportDefenses.parseError", {
          defaultValue: "Error procesando CSV: {{detail}}",
          detail: friendlyError(err, "desconocido"),
        }),
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleApply = async () => {
    if (readyToApply.length === 0 || applying) return;
    setApplying(true);
    const updates = new Map<
      string,
      {
        defense_factor: number;
        defense_notes: string | null;
        defense_video_url: string | null;
        defense_at: string;
        final_grade: number;
        status: string;
      }
    >();
    let okCount = 0;
    let failCount = 0;
    let firstError: string | null = null;

    for (const row of readyToApply) {
      const newFinal = Number(
        Math.min(maxScore, row.submission_grade * row.defense_factor).toFixed(2),
      );
      const nowIso = new Date().toISOString();
      const payload = {
        defense_factor: row.defense_factor,
        defense_notes: row.defense_notes,
        defense_video_url: row.defense_video_url,
        defense_at: nowIso,
        final_grade: newFinal,
        status: "calificado",
      };
      const { error } = await db
        .from("project_submissions")
        .update(payload)
        .eq("id", row.submission_id)
        .eq("project_id", projectId);
      if (error) {
        failCount++;
        if (!firstError) firstError = friendlyError(error);
        continue;
      }
      okCount++;
      updates.set(row.submission_id, payload);
    }

    setApplying(false);
    onApplied(updates);

    if (okCount > 0 && failCount === 0) {
      toast.success(
        t("hc_bulkImportDefenses.applySuccess", {
          defaultValue: "{{count}} sustentaciones aplicadas",
          count: okCount,
        }),
      );
    } else if (okCount > 0 && failCount > 0) {
      toast.warning(
        t("hc_bulkImportDefenses.applyPartial", {
          defaultValue:
            "{{ok}} aplicadas, {{fail}} con error. Primero: {{detail}}",
          ok: okCount,
          fail: failCount,
          detail: firstError ?? "—",
        }),
        { duration: 12000 },
      );
    } else {
      toast.error(
        t("hc_bulkImportDefenses.applyFail", {
          defaultValue: "No se aplicó ninguna sustentación. Detalle: {{detail}}",
          detail: firstError ?? "—",
        }),
      );
    }
    handleClose(false);
  };

  const totalParsed = parsedRows.length;
  const hasFile = fileName !== "";
  const hasAnyIssue =
    parseErrors.length > 0 ||
    emailsNoSubmission.length > 0 ||
    emailsNoGrade.length > 0 ||
    duplicateGroup.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("hc_bulkImportDefenses.title", {
              defaultValue: "Importar sustentaciones",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("hc_bulkImportDefenses.subtitle", {
              defaultValue:
                "Sube un CSV con las notas de sustentación para varios estudiantes a la vez en {{project}}.",
              project: projectTitle,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Paso 1: descargar template */}
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
            <div className="text-xs font-medium">
              {t("hc_bulkImportDefenses.step1Title", {
                defaultValue: "1. Descarga la plantilla",
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("hc_bulkImportDefenses.step1Hint", {
                defaultValue:
                  "Columnas: student_email (obligatorio), defense_factor (0..1, obligatorio, decimal con PUNTO — ej. 0.8), defense_notes (opcional, máx. 2000 chars), defense_video_url (opcional). Para grupos, basta UN miembro por grupo.",
              })}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownloadTemplate}
              type="button"
            >
              <FileDown className="h-4 w-4 mr-1" />
              {t("hc_bulkImportDefenses.downloadTemplate", {
                defaultValue: "Descargar plantilla",
              })}
            </Button>
          </div>

          {/* Paso 2: subir CSV */}
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
            <div className="text-xs font-medium">
              {t("hc_bulkImportDefenses.step2Title", {
                defaultValue: "2. Carga el CSV con las sustentaciones",
              })}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={handlePickFile}
                type="button"
                disabled={applying}
              >
                <FileUp className="h-4 w-4 mr-1" />
                {t("hc_bulkImportDefenses.pickFile", {
                  defaultValue: "Elegir archivo CSV",
                })}
              </Button>
              {hasFile && (
                <span className="text-[11px] text-muted-foreground truncate">
                  {fileName}
                </span>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Paso 3: preview */}
          {hasFile && (
            <div className="rounded-md border border-border p-3 space-y-3">
              <div className="text-xs font-medium">
                {t("hc_bulkImportDefenses.step3Title", {
                  defaultValue: "3. Resumen",
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <Badge variant="outline" className="gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  {t("hc_bulkImportDefenses.readyCount", {
                    defaultValue: "Listas para aplicar: {{count}}",
                    count: readyToApply.length,
                  })}
                </Badge>
                {totalParsed > 0 && (
                  <Badge variant="secondary">
                    {t("hc_bulkImportDefenses.parsedCount", {
                      defaultValue: "Filas parseadas: {{count}}",
                      count: totalParsed,
                    })}
                  </Badge>
                )}
                {parseErrors.length > 0 && (
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {t("hc_bulkImportDefenses.errorsCount", {
                      defaultValue: "Con error: {{count}}",
                      count: parseErrors.length,
                    })}
                  </Badge>
                )}
              </div>

              {/* Errores de validación */}
              {parseErrors.length > 0 && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 space-y-1">
                  <div className="text-[11px] font-medium text-destructive">
                    {t("hc_bulkImportDefenses.validationErrors", {
                      defaultValue: "Errores de validación",
                    })}
                  </div>
                  <ul className="text-[11px] text-destructive space-y-0.5 max-h-32 overflow-y-auto">
                    {parseErrors.slice(0, 20).map((err, i) => (
                      <li key={i}>{err.message}</li>
                    ))}
                    {parseErrors.length > 20 && (
                      <li className="italic">
                        {t("hc_bulkImportDefenses.moreErrors", {
                          defaultValue: "...y {{count}} más",
                          count: parseErrors.length - 20,
                        })}
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {/* Emails sin entrega */}
              {emailsNoSubmission.length > 0 && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
                  <div className="text-[11px] font-medium text-amber-700 dark:text-amber-500">
                    {t("hc_bulkImportDefenses.noSubmissionTitle", {
                      defaultValue:
                        "Estudiantes sin entrega previa ({{count}}) — no se les puede aplicar sustentación",
                      count: emailsNoSubmission.length,
                    })}
                  </div>
                  <ul className="text-[11px] text-amber-700 dark:text-amber-500 space-y-0.5 max-h-24 overflow-y-auto">
                    {emailsNoSubmission.slice(0, 10).map((r, i) => (
                      <li key={i}>
                        {t("hc_bulkImportDefenses.lineEmail", {
                          defaultValue: "Fila {{line}}: {{email}}",
                          line: r.line,
                          email: r.student_email,
                        })}
                      </li>
                    ))}
                    {emailsNoSubmission.length > 10 && (
                      <li className="italic">
                        {t("hc_bulkImportDefenses.moreItems", {
                          defaultValue: "...y {{count}} más",
                          count: emailsNoSubmission.length - 10,
                        })}
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {/* Emails sin nota IA/manual previa */}
              {emailsNoGrade.length > 0 && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
                  <div className="text-[11px] font-medium text-amber-700 dark:text-amber-500">
                    {t("hc_bulkImportDefenses.noGradeTitle", {
                      defaultValue:
                        "Entregas sin nota base ({{count}}) — califica los archivos primero",
                      count: emailsNoGrade.length,
                    })}
                  </div>
                  <ul className="text-[11px] text-amber-700 dark:text-amber-500 space-y-0.5 max-h-24 overflow-y-auto">
                    {emailsNoGrade.slice(0, 10).map((r, i) => (
                      <li key={i}>
                        {t("hc_bulkImportDefenses.lineEmail", {
                          defaultValue: "Fila {{line}}: {{email}}",
                          line: r.line,
                          email: r.student_email,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Duplicados de grupo */}
              {duplicateGroup.length > 0 && (
                <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2 space-y-1">
                  <div className="text-[11px] font-medium text-sky-700 dark:text-sky-400">
                    {t("hc_bulkImportDefenses.duplicateGroupTitle", {
                      defaultValue:
                        "Miembros del mismo grupo ignorados ({{count}}) — solo se aplica al primero del CSV",
                      count: duplicateGroup.length,
                    })}
                  </div>
                  <ul className="text-[11px] text-sky-700 dark:text-sky-400 space-y-0.5 max-h-24 overflow-y-auto">
                    {duplicateGroup.slice(0, 10).map((r, i) => (
                      <li key={i}>
                        {t("hc_bulkImportDefenses.lineEmail", {
                          defaultValue: "Fila {{line}}: {{email}}",
                          line: r.line,
                          email: r.student_email,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Preview de filas listas */}
              {readyToApply.length > 0 && !hasAnyIssue && (
                <div className="text-[11px] text-muted-foreground">
                  {t("hc_bulkImportDefenses.allReadyHint", {
                    defaultValue:
                      "Todas las filas están listas. Al aplicar, se actualizará la sustentación de {{count}} entregas.",
                    count: readyToApply.length,
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-row gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            type="button"
            disabled={applying}
          >
            {t("hc_bulkImportDefenses.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button
            onClick={handleApply}
            disabled={readyToApply.length === 0 || applying}
            type="button"
          >
            {applying ? (
              <>
                <Spinner size="sm" className="mr-1" />
                {t("hc_bulkImportDefenses.applying", {
                  defaultValue: "Aplicando...",
                })}
              </>
            ) : (
              t("hc_bulkImportDefenses.applyCount", {
                defaultValue: "Aplicar {{count}}",
                count: readyToApply.length,
              })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
