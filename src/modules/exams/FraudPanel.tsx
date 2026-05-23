import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Bot, Check, Eye, Save, Search, Users } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { RowAction } from "@/components/ui/row-action";
import { DecimalInput } from "@/components/ui/decimal-input";
import { HelpHint } from "@/components/ui/help-hint";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";

/**
 * Panel reutilizable para docente: análisis de fraude (IA) y detección
 * de copia entre estudiantes. Funciona para examen, taller y proyecto
 * vía la prop `kind` + `refId` (id del examen/taller/proyecto).
 *
 * Lee:
 *  - submissions / workshop_submissions / project_submissions para los
 *    flags ai_detected, ai_detected_score, ai_detected_reasons.
 *  - similarity_pairs (kind, ref_id) para los pares de copia detectados.
 *
 * Escribe (vía edge function):
 *  - Llama a `detect-plagiarism` cuando el docente pulsa el botón.
 *
 * El componente se monta una sola vez en la pantalla — no necesita
 * estar en realtime; el docente refresca explícitamente.
 */

export type FraudKind = "exam" | "workshop" | "project";

interface FraudPanelProps {
  kind: FraudKind;
  refId: string;
  /** Mapa user_id → nombre legible. Si falta, mostramos un id corto. */
  userNames?: Record<string, string>;
}

interface AiSignalRow {
  submissionId: string;
  userId: string;
  score: number;
  reasons: string | null;
  /** Marca de revisión: si está poblada, el docente ya inspeccionó la
   *  alerta IA y la consideramos cerrada — no entra en el conteo de
   *  "sospechoso" del estudiante. */
  reviewedAt: string | null;
}

interface SimilarityRow {
  id: string;
  question_id: string | null;
  user_a: string;
  user_b: string;
  score: number;
  reasons: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

/** Estado de calificación por usuario para este examen/taller/proyecto.
 * `currentGrade` es la nota efectiva (override > IA), `maxScore` es el
 * tope para escalar y limitar el input al guardar la sugerencia. */
interface GradeSnapshot {
  submissionId: string;
  currentGrade: number | null;
  maxScore: number;
}

const TABLES: Record<FraudKind, string> = {
  exam: "submissions",
  workshop: "workshop_submissions",
  project: "project_submissions",
};

const REF_COLUMN: Record<FraudKind, string> = {
  exam: "exam_id",
  workshop: "workshop_id",
  project: "project_id",
};

/** Columna que el docente edita al "Aplicar sugerencia": override en
 * exámenes, nota final en talleres/proyectos. */
const OVERRIDE_COLUMN: Record<FraudKind, string> = {
  exam: "final_override_grade",
  workshop: "final_grade",
  project: "final_grade",
};

/** Severidad mínima para activar la sugerencia (mismo umbral que el
 * monitor de exámenes y la edge function de plagio). */
const INTEGRITY_ALERT_THRESHOLD = 0.6;

/** Devuelve la nota sugerida = nota actual × (1 - severidad), redondeada
 * a 2 decimales y nunca menor que 0. Si no hay nota actual, retorna null
 * y el botón "Aplicar" se desactiva. */
function suggestedFromCurrent(currentGrade: number | null, severity: number): number | null {
  if (currentGrade == null) return null;
  return Math.max(0, Number((currentGrade * (1 - severity)).toFixed(2)));
}

function shortName(userId: string, names?: Record<string, string>): string {
  return names?.[userId] ?? userId.slice(0, 8);
}

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function scoreVariant(score: number): "destructive" | "default" | "secondary" {
  if (score >= 0.85) return "destructive";
  if (score >= 0.7) return "default";
  return "secondary";
}

export function FraudPanel({ kind, refId, userNames }: FraudPanelProps) {
  // Gate IA: detect-plagiarism consume cuota Gemini (N²/2 comparaciones).
  // En modo async sin override pedimos confirmación antes de gastar.
  const aiGate = useAiAuthorizationGate();
  const [aiSignals, setAiSignals] = useState<AiSignalRow[]>([]);
  const [pairs, setPairs] = useState<SimilarityRow[]>([]);
  const [questionLabels, setQuestionLabels] = useState<Record<string, string>>({});
  // Mapa userId → snapshot de su entrega (id + nota actual + tope). Lo
  // usamos para calcular sugerencias y persistir penalizaciones desde
  // las dos sub-tablas (IA y copia) sin volver a consultar la BD por
  // cada click.
  const [gradesByUser, setGradesByUser] = useState<Record<string, GradeSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detailOpen, setDetailOpen] = useState<{ a: string; b: string } | null>(null);
  // userId → busy state para mostrar spinner por fila al aplicar.
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  // Override editable de la sugerencia. Las claves son "ai-${userId}" y
  // "pl-${userId}" para que el docente pueda llevar valores distintos
  // por sub-tabla (IA vs copia) sin pisarse mutuamente. Si no hay
  // entrada en este map, se usa el valor calculado automáticamente
  // (currentGrade × (1 - severity)).
  const [editedSuggestion, setEditedSuggestion] = useState<Record<string, number | null>>({});

  const table = TABLES[kind];
  const refColumn = REF_COLUMN[kind];
  const overrideColumn = OVERRIDE_COLUMN[kind];

  /** Devuelve el valor visible en la celda "Sugerida" para una fila:
   * el override del docente si existe, o el calculado por defecto. */
  const getSuggestedValue = (
    rowKey: string,
    currentGrade: number | null,
    severity: number,
  ): number | null => {
    if (rowKey in editedSuggestion) return editedSuggestion[rowKey];
    return suggestedFromCurrent(currentGrade, severity);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Para examen el override vive en `final_override_grade`; para
      // taller/proyecto en `final_grade`. El campo IA es siempre
      // `ai_grade`. Cargamos AMBOS para poder mostrar la nota efectiva
      // (override > IA) en las tablas de sugerencia.
      const allSubmissionsSelect =
        kind === "exam"
          ? "id, user_id, ai_grade, final_override_grade, ai_detected, ai_detected_score, ai_detected_reasons, ai_review_at"
          : "id, user_id, ai_grade, final_grade, ai_detected, ai_detected_score, ai_detected_reasons, ai_review_at";

      // Tope (maxScore) por entrega — para validar y mostrar contexto
      // al aplicar. Para examen el max es la escala del curso del exam;
      // para taller/proyecto el max está en la propia tabla padre.
      const maxScorePromise =
        kind === "exam"
          ? supabase
              .from("exams" as any)
              .select("course:courses(grade_scale_max)")
              .eq("id", refId)
              .maybeSingle()
          : supabase
              .from((kind === "workshop" ? "workshops" : "projects") as any)
              .select("max_score")
              .eq("id", refId)
              .maybeSingle();

      const [
        { data: allSubs, error: sErr },
        { data: pairsData, error: pErr },
        { data: parentRow },
      ] = await Promise.all([
        supabase
          .from(table as any)
          .select(allSubmissionsSelect)
          .eq(refColumn, refId),
        supabase
          .from("similarity_pairs" as any)
          .select(
            "id, question_id, user_a, user_b, score, reasons, created_at, reviewed_at, reviewed_by",
          )
          .eq("kind", kind)
          .eq("ref_id", refId)
          .order("score", { ascending: false }),
        maxScorePromise,
      ]);
      if (sErr) console.warn("[fraud] submissions", sErr);
      if (pErr) console.warn("[fraud] pairs", pErr);

      // Resuelve el tope una sola vez para todas las entregas del refId.
      const maxScore =
        kind === "exam"
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Number((parentRow as any)?.course?.grade_scale_max ?? 5) || 5
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Number((parentRow as any)?.max_score ?? 100) || 100;

      const snapshot: Record<string, GradeSnapshot> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const s of (allSubs ?? []) as any[]) {
        const override = kind === "exam" ? s.final_override_grade : s.final_grade;
        const current =
          override != null ? Number(override) : s.ai_grade != null ? Number(s.ai_grade) : null;
        snapshot[s.user_id] = { submissionId: s.id, currentGrade: current, maxScore };
      }
      setGradesByUser(snapshot);

      // AI signals = subset con ai_detected=true O con ai_review_at
      // poblado (alertas previas que el docente cerró). Las cerradas se
      // muestran de forma separada para que el docente sepa que están
      // archivadas, pero NO entran al conteo de "sospechoso".
      const aiRows = ((allSubs ?? []) as any[])
        .filter((s) => s.ai_detected === true || s.ai_review_at != null)
        .map((s) => ({
          submissionId: s.id,
          userId: s.user_id,
          score: Number(s.ai_detected_score) || 0,
          reasons: s.ai_detected_reasons ?? null,
          reviewedAt: s.ai_review_at ?? null,
        }))
        .sort((a, b) => b.score - a.score);
      setAiSignals(aiRows);

      const pairsArr = ((pairsData ?? []) as any[]).map((p) => p as SimilarityRow);
      setPairs(pairsArr);

      // Cargar etiquetas de las preguntas referenciadas en pairs para
      // poder mostrarlas en el modal de detalle. El kind define la
      // tabla: questions / workshop_questions / project_files.
      const qIds = Array.from(
        new Set(pairsArr.map((p) => p.question_id).filter((x): x is string => !!x)),
      );
      if (qIds.length > 0) {
        const tableName =
          kind === "exam"
            ? "questions"
            : kind === "workshop"
              ? "workshop_questions"
              : "project_files";
        const titleColumn = kind === "project" ? "title" : "content";
        const { data: qData } = await supabase
          .from(tableName as any)
          .select(`id, position, ${titleColumn}`)
          .in("id", qIds);
        const map: Record<string, string> = {};
        for (const q of (qData ?? []) as any[]) {
          const label =
            (q.position != null ? `Pregunta ${Number(q.position) + 1}` : "Pregunta") +
            (q[titleColumn] ? `: ${String(q[titleColumn]).slice(0, 80)}` : "");
          map[q.id as string] = label;
        }
        setQuestionLabels(map);
      } else {
        setQuestionLabels({});
      }
    } finally {
      setLoading(false);
    }
  }, [kind, refId, refColumn, table]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Marca un par de plagio como revisado (o lo desmarca si ya estaba).
   * Llama la RPC `mark_similarity_pair_reviewed` que fuerza
   * `reviewed_by = auth.uid()` server-side. Después actualiza el row
   * en memoria y deja el toast.
   */
  const togglePairReviewed = async (pairId: string, currentlyReviewed: boolean) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("mark_similarity_pair_reviewed", {
      p_pair_id: pairId,
      p_unmark: currentlyReviewed,
    });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setPairs((prev) =>
      prev.map((p) =>
        p.id === pairId
          ? {
              ...p,
              reviewed_at: currentlyReviewed ? null : new Date().toISOString(),
              reviewed_by: currentlyReviewed ? null : null,
            }
          : p,
      ),
    );
    toast.success(currentlyReviewed ? "Marcada como pendiente" : "Marcada como revisada");
  };

  /**
   * Marca la sospecha IA de una submission como revisada (o desmarca).
   * Cambia el flag a nivel submission — la pregunta queda fuera del
   * conteo de "sospechoso" del estudiante.
   */
  const toggleAiReviewed = async (submissionId: string, currentlyReviewed: boolean) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("mark_ai_suspicion_reviewed", {
      p_kind: kind,
      p_submission_id: submissionId,
      p_unmark: currentlyReviewed,
    });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setAiSignals((prev) =>
      prev.map((row) =>
        row.submissionId === submissionId
          ? { ...row, reviewedAt: currentlyReviewed ? null : new Date().toISOString() }
          : row,
      ),
    );
    toast.success(currentlyReviewed ? "Marcada como pendiente" : "Marcada como revisada");
  };

  const runDetection = async () => {
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    setDetecting(true);
    try {
      const { data, error } = await supabase.functions.invoke("detect-plagiarism", {
        body: { kind, refId },
      });
      if (error) {
        const detail = await extractEdgeError(error, data);
        throw new Error(detail || "Error en detección de plagio");
      }
      const summary = data as { pairs?: unknown[]; groups_compared?: number; message?: string };
      const found = Array.isArray(summary?.pairs) ? summary.pairs.length : 0;
      void logEvent({
        action: "ai_plagiarism.detected",
        category: "fraud",
        severity: found > 0 ? "warning" : "info",
        entityType: kind,
        entityId: refId,
        metadata: { pairs_found: found },
      });
      if (found > 0) {
        toast.success(
          `Detección completada: ${found} par${found === 1 ? "" : "es"} sospechoso${found === 1 ? "" : "s"}.`,
        );
      } else {
        toast.message("Detección completada", {
          description: summary?.message ?? "No se encontraron coincidencias relevantes.",
        });
      }
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`No se pudo ejecutar la detección: ${msg}`);
    } finally {
      setDetecting(false);
    }
  };

  const hasAi = aiSignals.length > 0;
  const hasPairs = pairs.length > 0;

  // Agrupa pairs por (userA, userB) — clave canonicalizada por orden
  // alfabético para que pairs.user_a/user_b inversos no aparezcan dos
  // veces. Cada grupo guarda el max score, count de preguntas y la
  // lista de pairs originales para el modal de detalle.
  type GroupedPair = {
    userA: string;
    userB: string;
    maxScore: number;
    questionCount: number;
    pairs: SimilarityRow[];
  };
  const groupedPairs = useMemo<GroupedPair[]>(() => {
    const map = new Map<string, GroupedPair>();
    for (const p of pairs) {
      const [a, b] = [p.user_a, p.user_b].sort();
      const key = `${a}::${b}`;
      const existing = map.get(key);
      if (existing) {
        existing.pairs.push(p);
        existing.maxScore = Math.max(existing.maxScore, p.score);
        existing.questionCount = existing.pairs.length;
      } else {
        map.set(key, {
          userA: a,
          userB: b,
          maxScore: p.score,
          questionCount: 1,
          pairs: [p],
        });
      }
    }
    return Array.from(map.values()).sort((x, y) => y.maxScore - x.maxScore);
  }, [pairs]);

  const detailGroup =
    detailOpen != null
      ? (groupedPairs.find((g) => g.userA === detailOpen.a && g.userB === detailOpen.b) ?? null)
      : null;

  const aiSummaryLabel = useMemo(() => {
    if (!hasAi) return "Sin señales de IA";
    const high = aiSignals.filter((s) => s.score >= 0.85).length;
    return `${aiSignals.length} entrega${aiSignals.length === 1 ? "" : "s"} marcada${aiSignals.length === 1 ? "" : "s"}${high ? ` · ${high} con alta probabilidad` : ""}`;
  }, [aiSignals, hasAi]);

  /**
   * Vista por estudiante de la sección de copia: cada usuario que
   * aparezca en algún par recibe una fila con su MAX similitud y los
   * compañeros con quienes coincidió. Es el equivalente al "AI signals"
   * pero para plagio — permite aplicar la sugerencia 1 click por
   * estudiante en vez de tener que abrir el detalle del par.
   */
  type PlagiarismPerStudent = {
    userId: string;
    maxScore: number;
    peerIds: string[];
    questionCount: number;
  };
  const plagiarismByStudent = useMemo<PlagiarismPerStudent[]>(() => {
    const map = new Map<string, PlagiarismPerStudent>();
    for (const p of pairs) {
      for (const [u, peer] of [
        [p.user_a, p.user_b],
        [p.user_b, p.user_a],
      ] as const) {
        const existing = map.get(u);
        if (existing) {
          existing.maxScore = Math.max(existing.maxScore, p.score);
          if (!existing.peerIds.includes(peer)) existing.peerIds.push(peer);
          existing.questionCount += 1;
        } else {
          map.set(u, { userId: u, maxScore: p.score, peerIds: [peer], questionCount: 1 });
        }
      }
    }
    return Array.from(map.values()).sort((x, y) => y.maxScore - x.maxScore);
  }, [pairs]);

  /**
   * Persiste la sugerencia (currentGrade × (1 − severidad)) en la
   * columna correspondiente al kind: `final_override_grade` para
   * exámenes, `final_grade` para talleres/proyectos. Optimista: mete
   * el spinner por fila, espera la respuesta + .select() para
   * detectar deny silencioso de RLS, luego actualiza el snapshot
   * local para que la columna "Nota actual" refleje el cambio.
   */
  // Estado de la operación masiva — controla el botón "Aplicar a todos"
  // y deshabilita las filas individuales mientras corre.
  const [bulkApplying, setBulkApplying] = useState(false);

  const applyPenalty = useCallback(
    async (userId: string, gradeToApply: number | null) => {
      const snap = gradesByUser[userId];
      if (!snap) {
        toast.error("No se encontró la entrega del estudiante");
        return;
      }
      if (gradeToApply == null || Number.isNaN(gradeToApply)) {
        toast.error("Ingresa un valor numérico para la nota");
        return;
      }
      // Validación dura: nota dentro del rango permitido por la entrega
      // (0 a maxScore). El docente puede haber editado el input a un
      // valor fuera de rango — preferimos rechazar antes de persistir.
      if (gradeToApply < 0 || gradeToApply > snap.maxScore) {
        toast.error(`La nota debe estar entre 0 y ${snap.maxScore}`);
        return;
      }
      setApplying((p) => ({ ...p, [userId]: true }));
      try {
        const { data, error } = await supabase
          .from(table as any)
          .update({ [overrideColumn]: gradeToApply })
          .eq("id", snap.submissionId)
          .select("id");
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        if (!data || (data as unknown as { id: string }[]).length === 0) {
          toast.error(
            "No se pudo aplicar (sin permisos o la entrega ya no existe). Recarga e intenta de nuevo.",
          );
          return;
        }
        setGradesByUser((prev) => ({
          ...prev,
          [userId]: { ...snap, currentGrade: gradeToApply },
        }));
        toast.success(
          `Nota de ${shortName(userId, userNames)} actualizada a ${gradeToApply.toFixed(2)}`,
        );
      } finally {
        setApplying((p) => ({ ...p, [userId]: false }));
      }
    },
    [gradesByUser, overrideColumn, table, userNames],
  );

  /**
   * Aplica la sugerencia a TODAS las filas de una sección (IA o copia).
   * Iteramos secuencial — preferimos UX de "ver progreso" sobre paralelo
   * (que podría saturar PostgREST en cursos grandes). Solo aplica filas
   * con sugerencia válida.
   *
   * Recibe la lista de (userId, suggested, severity) — el caller computa
   * estos valores con la misma lógica que usa para pintar cada fila, así
   * el botón hace exactamente lo que el docente ve.
   */
  const applyAllInSection = useCallback(
    async (rowsToApply: Array<{ userId: string; suggested: number | null; severity: number }>) => {
      const applicable = rowsToApply.filter(
        (r) =>
          r.suggested != null &&
          !Number.isNaN(r.suggested) &&
          r.severity >= INTEGRITY_ALERT_THRESHOLD,
      );
      if (applicable.length === 0) {
        toast.info("Ninguna fila tiene sugerencia aplicable");
        return;
      }
      const confirmMsg = `Vas a aplicar la sugerencia a ${applicable.length} estudiante${
        applicable.length === 1 ? "" : "s"
      }. La nota actual se reemplaza por la sugerida. ¿Continuar?`;
      if (!window.confirm(confirmMsg)) return;

      setBulkApplying(true);
      let okCount = 0;
      let failCount = 0;
      for (const r of applicable) {
        try {
          await applyPenalty(r.userId, r.suggested);
          okCount += 1;
        } catch (_) {
          failCount += 1;
        }
      }
      setBulkApplying(false);
      if (okCount > 0) {
        toast.success(
          `Sugerencia aplicada a ${okCount} estudiante${okCount === 1 ? "" : "s"}` +
            (failCount > 0 ? ` · ${failCount} fallido${failCount === 1 ? "" : "s"}` : ""),
        );
      }
    },
    [applyPenalty],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-primary" />
            Análisis de fraude
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={runDetection}
            disabled={detecting || loading}
            className="h-8 text-xs"
          >
            {detecting ? (
              <Spinner size="sm" className="mr-1.5" />
            ) : (
              <Search className="h-3.5 w-3.5 mr-1.5" />
            )}
            Detectar copias
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Sección 1: señales IA por entrega */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bot className="h-4 w-4 text-muted-foreground" />
            Probabilidad de respuesta generada por IA
            <Badge variant="outline" className="ml-auto text-[11px]">
              {aiSummaryLabel}
            </Badge>
            {hasAi && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                disabled={bulkApplying}
                onClick={() =>
                  applyAllInSection(
                    aiSignals.map((row) => {
                      const snap = gradesByUser[row.userId];
                      const rowKey = `ai-${row.userId}`;
                      return {
                        userId: row.userId,
                        suggested: getSuggestedValue(rowKey, snap?.currentGrade ?? null, row.score),
                        severity: row.score,
                      };
                    }),
                  )
                }
                title="Aplica la sugerencia a todas las filas con score ≥ umbral"
              >
                {bulkApplying ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <Save className="h-3 w-3 mr-1" />
                )}
                Aplicar a todos
              </Button>
            )}
          </div>
          {!hasAi ? (
            <p className="text-xs text-muted-foreground">
              Ninguna entrega supera el umbral del 60% de probabilidad de IA. Las señales se
              actualizan automáticamente al calificar con IA.
            </p>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-32">Estudiante</TableHead>
                  <TableHead className="w-28">Probabilidad</TableHead>
                  <TableHead className="min-w-40 hidden md:table-cell">Razones</TableHead>
                  <TableHead className="w-24 text-right">Nota actual</TableHead>
                  <TableHead className="w-24 text-right">
                    <span className="inline-flex items-center gap-1 justify-end">
                      Sugerida
                      <HelpHint>
                        La nota se ingresa en la escala del item (0 al puntaje máximo del
                        examen/taller/proyecto). Decimales con coma (ej. 4,5).
                      </HelpHint>
                    </span>
                  </TableHead>
                  <TableHead className="w-28 text-right">Aplicar</TableHead>
                  <TableHead className="w-32 text-right">Revisión</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {aiSignals.map((row) => {
                  const snap = gradesByUser[row.userId];
                  const current = snap?.currentGrade ?? null;
                  const rowKey = `ai-${row.userId}`;
                  const suggested = getSuggestedValue(rowKey, current, row.score);
                  const canApply =
                    suggested != null &&
                    !Number.isNaN(suggested) &&
                    row.score >= INTEGRITY_ALERT_THRESHOLD;
                  const busy = !!applying[row.userId];
                  return (
                    <TableRow key={row.submissionId}>
                      <TableCell className="font-medium">
                        {shortName(row.userId, userNames)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={scoreVariant(row.score)}>{formatScore(row.score)}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-pre-wrap">
                        {row.reasons ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {current != null ? current.toFixed(2) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <DecimalInput
                          min={0}
                          max={snap?.maxScore}
                          value={suggested}
                          onChange={(v) =>
                            setEditedSuggestion((prev) => ({ ...prev, [rowKey]: v }))
                          }
                          placeholder="—"
                          className="h-7 w-20 ml-auto text-xs text-right font-semibold text-amber-700 dark:text-amber-300"
                          aria-label="Nota sugerida editable"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={!canApply || busy}
                          onClick={() => applyPenalty(row.userId, suggested)}
                          title={
                            canApply
                              ? `Aplica nota ${suggested?.toFixed(2)} a la entrega`
                              : "Sin nota previa, severidad < 60%, o nota inválida"
                          }
                        >
                          {busy ? (
                            <Spinner size="sm" className="mr-1" />
                          ) : (
                            <Check className="h-3 w-3 mr-1" />
                          )}
                          Aplicar
                        </Button>
                      </TableCell>
                      <TableCell className="text-right">
                        {row.reviewedAt ? (
                          <div className="flex flex-col items-end gap-1">
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                            >
                              <Check className="h-3 w-3 mr-1" />
                              Revisada
                            </Badge>
                            <button
                              type="button"
                              className="text-[10px] text-muted-foreground hover:text-foreground underline"
                              onClick={() => toggleAiReviewed(row.submissionId, true)}
                            >
                              Reabrir
                            </button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => toggleAiReviewed(row.submissionId, false)}
                          >
                            <Check className="h-3 w-3 mr-1" />
                            Marcar revisada
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          )}
        </div>

        {/* Sección 2: pares de copia entre estudiantes (agregado) */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Users className="h-4 w-4 text-muted-foreground" />
            Posibles copias entre estudiantes
            <Badge variant="outline" className="ml-auto text-[11px]">
              {hasPairs
                ? `${groupedPairs.length} par${groupedPairs.length === 1 ? "" : "es"} de estudiantes`
                : "Sin pares detectados"}
            </Badge>
          </div>
          {!hasPairs ? (
            <p className="text-xs text-muted-foreground">
              Ejecuta "Detectar copias" para comparar las entregas con Gemini. Solo se muestran
              pares con similitud ≥ 60%.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-32">Estudiante A</TableHead>
                    <TableHead className="min-w-32">Estudiante B</TableHead>
                    <TableHead className="w-32">Similitud máx</TableHead>
                    <TableHead className="w-24 hidden sm:table-cell">Preguntas</TableHead>
                    <TableHead className="w-32 text-right">Revisión</TableHead>
                    <TableHead className="text-right">Detalle</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupedPairs.map((g) => {
                    const reviewedCount = g.pairs.filter((p) => p.reviewed_at != null).length;
                    const allReviewed = reviewedCount === g.pairs.length;
                    const someReviewed = reviewedCount > 0;
                    const markAll = async () => {
                      // Marca/desmarca todos los pares del grupo según el
                      // estado actual: si TODOS están revisados → desmarca
                      // todos; en cualquier otro caso → marca todos.
                      const targetUnmark = allReviewed;
                      for (const p of g.pairs) {
                        const isReviewed = p.reviewed_at != null;
                        if (targetUnmark && !isReviewed) continue;
                        if (!targetUnmark && isReviewed) continue;
                        await togglePairReviewed(p.id, isReviewed);
                      }
                    };
                    return (
                      <TableRow key={`${g.userA}::${g.userB}`}>
                        <TableCell className="font-medium">
                          {shortName(g.userA, userNames)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {shortName(g.userB, userNames)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={scoreVariant(g.maxScore)}>
                            {formatScore(g.maxScore)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs tabular-nums hidden sm:table-cell">{g.questionCount}</TableCell>
                        <TableCell className="text-right">
                          {allReviewed ? (
                            <div className="flex flex-col items-end gap-1">
                              <Badge
                                variant="outline"
                                className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                              >
                                <Check className="h-3 w-3 mr-1" />
                                Revisada
                              </Badge>
                              <button
                                type="button"
                                className="text-[10px] text-muted-foreground hover:text-foreground underline"
                                onClick={markAll}
                              >
                                Reabrir
                              </button>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={markAll}
                              title={
                                someReviewed
                                  ? `${reviewedCount}/${g.pairs.length} ya revisado(s) — marcar el resto`
                                  : "Marca todos los pares como revisados"
                              }
                            >
                              <Check className="h-3 w-3 mr-1" />
                              {someReviewed
                                ? `Revisar resto (${g.pairs.length - reviewedCount})`
                                : "Marcar revisada"}
                            </Button>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowAction
                            label="Ver preguntas con posible copia"
                            icon={Eye}
                            onClick={() => setDetailOpen({ a: g.userA, b: g.userB })}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>

              {/* Vista por estudiante: aplica la sugerencia 1 click por
                  alumno. Severidad = max similarity con cualquier
                  compañero en el examen/taller/proyecto. */}
              <div className="pt-3 border-t">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    Penalización sugerida por estudiante (severidad = similitud máxima)
                  </div>
                  {plagiarismByStudent.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      disabled={bulkApplying}
                      onClick={() =>
                        applyAllInSection(
                          plagiarismByStudent.map((s) => {
                            const snap = gradesByUser[s.userId];
                            const rowKey = `pl-${s.userId}`;
                            return {
                              userId: s.userId,
                              suggested: getSuggestedValue(
                                rowKey,
                                snap?.currentGrade ?? null,
                                s.maxScore,
                              ),
                              severity: s.maxScore,
                            };
                          }),
                        )
                      }
                      title="Aplica la sugerencia a todos los estudiantes con similitud ≥ umbral"
                    >
                      {bulkApplying ? (
                        <Spinner size="sm" className="mr-1" />
                      ) : (
                        <Save className="h-3 w-3 mr-1" />
                      )}
                      Aplicar a todos
                    </Button>
                  )}
                </div>
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-32">Estudiante</TableHead>
                      <TableHead className="w-28">Similitud máx</TableHead>
                      <TableHead className="min-w-40 hidden md:table-cell">Coincide con</TableHead>
                      <TableHead className="w-24 text-right">Nota actual</TableHead>
                      <TableHead className="w-24 text-right">
                        <span className="inline-flex items-center gap-1 justify-end">
                          Sugerida
                          <HelpHint>
                            La nota se ingresa en la escala del item (0 al puntaje máximo del
                            examen/taller/proyecto). Decimales con coma (ej. 4,5).
                          </HelpHint>
                        </span>
                      </TableHead>
                      <TableHead className="w-28 text-right">Aplicar</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plagiarismByStudent.map((s) => {
                      const snap = gradesByUser[s.userId];
                      const current = snap?.currentGrade ?? null;
                      const rowKey = `pl-${s.userId}`;
                      const suggested = getSuggestedValue(rowKey, current, s.maxScore);
                      const canApply =
                        suggested != null &&
                        !Number.isNaN(suggested) &&
                        s.maxScore >= INTEGRITY_ALERT_THRESHOLD;
                      const busy = !!applying[s.userId];
                      const peerLabel = s.peerIds
                        .slice(0, 3)
                        .map((p) => shortName(p, userNames))
                        .join(", ");
                      return (
                        <TableRow key={s.userId}>
                          <TableCell className="font-medium">
                            {shortName(s.userId, userNames)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={scoreVariant(s.maxScore)}>
                              {formatScore(s.maxScore)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground hidden md:table-cell">
                            {peerLabel}
                            {s.peerIds.length > 3 && ` +${s.peerIds.length - 3}`}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {current != null ? current.toFixed(2) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <DecimalInput
                              min={0}
                              max={snap?.maxScore}
                              value={suggested}
                              onChange={(v) =>
                                setEditedSuggestion((prev) => ({ ...prev, [rowKey]: v }))
                              }
                              placeholder="—"
                              className="h-7 w-20 ml-auto text-xs text-right font-semibold text-amber-700 dark:text-amber-300"
                              aria-label="Nota sugerida editable"
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={!canApply || busy}
                              onClick={() => applyPenalty(s.userId, suggested)}
                              title={
                                canApply
                                  ? `Aplica nota ${suggested?.toFixed(2)} a la entrega`
                                  : "Sin nota previa, severidad < 60%, o nota inválida"
                              }
                            >
                              {busy ? (
                                <Spinner size="sm" className="mr-1" />
                              ) : (
                                <Check className="h-3 w-3 mr-1" />
                              )}
                              Aplicar
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                </div>
              </div>
            </>
          )}
        </div>
      </CardContent>

      {/* Modal: detalle por pregunta del par seleccionado. Lista cada
          coincidencia con su question label, similitud y razón. */}
      <Dialog open={detailOpen != null} onOpenChange={(o) => !o && setDetailOpen(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Detalle: {shortName(detailOpen?.a ?? "", userNames)} ↔{" "}
              {shortName(detailOpen?.b ?? "", userNames)}
            </DialogTitle>
            <DialogDescription>
              Preguntas donde Gemini marcó coincidencias con score ≥ 60%.
            </DialogDescription>
          </DialogHeader>
          {detailGroup && (
            <div className="space-y-3">
              {detailGroup.pairs
                .slice()
                .sort((a, b) => b.score - a.score)
                .map((p) => {
                  const label = p.question_id
                    ? (questionLabels[p.question_id] ?? "Pregunta")
                    : "Entrega general";
                  return (
                    <div key={p.id} className="rounded-md border p-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm font-medium">{label}</div>
                        <Badge variant={scoreVariant(p.score)}>{formatScore(p.score)}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground whitespace-pre-wrap">
                        {p.reasons ?? "(sin razón)"}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </DialogContent>
      </Dialog>
      {/* Gate IA — montado UNA vez para capturar las llamadas a
          aiGate.ensureAuthorized() desde runDetection. */}
      <aiGate.GateDialog />
    </Card>
  );
}
