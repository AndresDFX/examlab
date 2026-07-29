/**
 * Alerta temprana — panel del docente.
 *
 * Se monta dentro de `CourseDashboard`, así que aparece igual en las
 * estadísticas del Docente y del Admin sin duplicar código.
 *
 * No recibe el riesgo ya calculado: lo computa del `CourseDataset` que el
 * dashboard ya tenía cargado. Sus dos queries propias son chicas y
 * cacheables (umbrales de la institución + nombres de los matriculados).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertTriangle, ShieldCheck, TrendingDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableEmpty } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/shared/lib/utils";
import {
  classifyCourse,
  summarizeRisk,
  thresholdsFromSettings,
  type RiskLevel,
  type RiskReason,
  type RiskThresholds,
  type StudentRisk,
} from "@/shared/lib/early-alert";
import type { CourseDataset } from "@/shared/lib/statistics";

/**
 * Semáforo con tres tonos propios.
 *
 * NO usa `StatusBadge` a propósito: ese componente centraliza los estados de
 * exam/workshop/project/submission sobre las 4 variantes de Badge, y ninguna
 * expresa "ámbar" ni "verde". Un semáforo sin ámbar deja de ser un semáforo.
 * La regla del design system es no pintar badges de estado ad-hoc por
 * pantalla — se respeta manteniendo el mapeo acá, en un solo lugar.
 */
const RISK_TONE: Record<RiskLevel, string> = {
  en_riesgo:
    "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  en_observacion:
    "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  sin_riesgo:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

function RiskBadge({ level }: { level: RiskLevel }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap", RISK_TONE[level])}>
      {t(`earlyAlert.level.${level}`)}
    </Badge>
  );
}

/** Notas con coma decimal (convención es-CO del proyecto). */
function grade(n: number): string {
  return n.toFixed(1).replace(".", ",");
}

function reasonText(r: RiskReason, t: TFunction): string {
  switch (r.kind) {
    case "inasistencia":
      return t("earlyAlert.reason.inasistencia", {
        pct: Math.round(r.value * 100),
        min: Math.round(r.threshold * 100),
      });
    case "reprobadas":
      return t("earlyAlert.reason.reprobadas", { count: r.value });
    case "no_entregadas":
      return t("earlyAlert.reason.noEntregadas", { count: r.value });
    case "promedio_bajo":
      return t("earlyAlert.reason.promedioBajo", {
        avg: grade(r.value),
        passing: grade(r.threshold),
      });
  }
}

export function EarlyAlertCard({ ds }: { ds: CourseDataset }) {
  const { t } = useTranslation();
  const [thresholds, setThresholds] = useState<RiskThresholds | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const enrolledIds = useMemo(
    () => new Set(ds.enrollments.map((e) => e.user_id)),
    [ds.enrollments],
  );

  // Umbrales de la institución. Si la query falla o la migración no corrió,
  // se cae a los defaults del código: el panel NUNCA queda vacío por esto.
  //
  // Se filtra por el tenant DEL CURSO, no por el del usuario. Para Docente y
  // Admin da lo mismo (es su propio tenant), pero un SuperAdmin ve todas las
  // filas de `app_settings` (su RLS incluye `is_super_admin()`): sin el filtro,
  // `maybeSingle()` fallaría con varias filas y el panel caería a los defaults
  // → el SA vería una clasificación distinta a la que ve el Admin de esa
  // institución, con los mismos datos.
  useEffect(() => {
    let cancelled = false;
    const courseId = ds.course.id;
    void (async () => {
      try {
        const { data: courseRow } = await supabase
          .from("courses")
          .select("tenant_id")
          .eq("id", courseId)
          .maybeSingle();
        if (cancelled) return;
        // `supabase as any`: `types.ts` se genera desde la DB y no conoce
        // estas columnas hasta que la migración se publique. Mismo patrón que
        // usa `AdminGeneralSettingsPanel` (`const db = supabase as any`).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q = (supabase as any)
          .from("app_settings")
          .select(
            "early_alert_min_attendance_rate, early_alert_max_failed, early_alert_max_missing",
          );
        const tenantId = (courseRow as { tenant_id?: string | null } | null)
          ?.tenant_id;
        if (tenantId) q = q.eq("tenant_id", tenantId);
        const { data } = await q.maybeSingle();
        if (cancelled) return;
        setThresholds(thresholdsFromSettings(data ?? null));
      } catch {
        // Un fallo de red acá NO puede dejar el panel colgado en "Cargando…":
        // se cae a los defaults del clasificador y el docente ve sus datos.
        if (!cancelled) setThresholds(thresholdsFromSettings(null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ds.course.id]);

  // Nombres en query aparte: `course_enrollments.user_id` no se puede
  // embeber a `profiles` de forma confiable (convención del proyecto).
  useEffect(() => {
    let cancelled = false;
    const ids = [...enrolledIds];
    if (ids.length === 0) {
      setNames({});
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", ids);
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const p of data ?? []) {
          map[p.id as string] = (p.full_name as string) ?? "";
        }
        setNames(map);
      } catch {
        // Sin nombres el panel sigue siendo útil (nivel + motivos), así que
        // se muestra igual en vez de bloquear la sección entera.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enrolledIds]);

  const allSubs = useMemo(
    () => [...ds.examSubs, ...ds.workshopSubs, ...ds.projectSubs],
    [ds],
  );

  const risks = useMemo(() => {
    if (!thresholds) return [];
    return classifyCourse(
      enrolledIds,
      allSubs,
      ds.attendanceSessions,
      ds.attendanceRecords,
      ds.course,
      thresholds,
    );
  }, [thresholds, enrolledIds, allSubs, ds]);

  const summary = useMemo(() => summarizeRisk(risks), [risks]);

  // Solo se listan los que requieren atención. Los "sin riesgo" se cuentan
  // en el resumen pero no se enumeran: un listado de 90 filas donde 85 están
  // bien entierra a los 5 que importan.
  const flagged = useMemo(
    () => risks.filter((r) => r.level !== "sin_riesgo"),
    [risks],
  );

  const busy = loading || !thresholds;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-rose-500" />
          {t("earlyAlert.title")}
        </CardTitle>
        <CardDescription>{t("earlyAlert.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {busy ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Spinner size="sm" />
            {t("common.loading")}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <RiskTally
                level="en_riesgo"
                count={summary.en_riesgo}
                total={enrolledIds.size}
              />
              <RiskTally
                level="en_observacion"
                count={summary.en_observacion}
                total={enrolledIds.size}
              />
              <RiskTally
                level="sin_riesgo"
                count={summary.sin_riesgo}
                total={enrolledIds.size}
              />
            </div>

            <div className="max-h-96 overflow-y-auto overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-32">
                      {t("earlyAlert.colStudent")}
                    </TableHead>
                    <TableHead>{t("earlyAlert.colLevel")}</TableHead>
                    <TableHead className="min-w-48">
                      {t("earlyAlert.colReasons")}
                    </TableHead>
                    <TableHead className="hidden sm:table-cell">
                      {t("earlyAlert.colAttendance")}
                    </TableHead>
                    <TableHead className="hidden md:table-cell">
                      {t("earlyAlert.colAverage")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flagged.length === 0 ? (
                    <TableEmpty
                      colSpan={5}
                      icon={ShieldCheck}
                      text={t("earlyAlert.emptyTitle")}
                      hint={t("earlyAlert.emptyHint")}
                    />
                  ) : (
                    flagged.map((r) => (
                      <RiskRow key={r.userId} risk={r} name={names[r.userId]} />
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RiskTally({
  level,
  count,
  total,
}: {
  level: RiskLevel;
  count: number;
  total: number;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("rounded-md border p-2.5", RISK_TONE[level])}>
      <div className="text-xl font-semibold tabular-nums">{count}</div>
      <div className="text-[11px] leading-tight opacity-90">
        {t(`earlyAlert.level.${level}`)}
      </div>
      <div className="text-[10px] opacity-70 tabular-nums">
        {t("earlyAlert.ofStudents", { count: total })}
      </div>
    </div>
  );
}

function RiskRow({ risk, name }: { risk: StudentRisk; name?: string }) {
  const { t } = useTranslation();
  return (
    <TableRow>
      <TableCell className="font-medium">
        {name || t("earlyAlert.unknownStudent")}
      </TableCell>
      <TableCell>
        <RiskBadge level={risk.level} />
      </TableCell>
      <TableCell>
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {risk.reasons.map((r) => (
            <li key={r.kind} className="flex items-start gap-1.5">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" />
              <span>{reasonText(r, t)}</span>
            </li>
          ))}
        </ul>
      </TableCell>
      <TableCell className="hidden sm:table-cell tabular-nums text-sm">
        {risk.attendanceRate == null ? (
          <span className="text-muted-foreground" title={t("earlyAlert.noAttendanceData")}>
            —
          </span>
        ) : (
          `${Math.round(risk.attendanceRate * 100)}%`
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell tabular-nums text-sm">
        {risk.averageGrade == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          grade(risk.averageGrade)
        )}
      </TableCell>
    </TableRow>
  );
}
