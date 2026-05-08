import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
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
import { AlertTriangle, Bot, Eye, Search, Users } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { RowAction } from "@/components/ui/row-action";

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
}

interface SimilarityRow {
  id: string;
  question_id: string | null;
  user_a: string;
  user_b: string;
  score: number;
  reasons: string | null;
  created_at: string;
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
  const [aiSignals, setAiSignals] = useState<AiSignalRow[]>([]);
  const [pairs, setPairs] = useState<SimilarityRow[]>([]);
  const [questionLabels, setQuestionLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detailOpen, setDetailOpen] = useState<{ a: string; b: string } | null>(null);

  const table = TABLES[kind];
  const refColumn = REF_COLUMN[kind];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: subs, error: sErr }, { data: pairsData, error: pErr }] = await Promise.all([
        supabase
          .from(table as any)
          .select("id, user_id, ai_detected, ai_detected_score, ai_detected_reasons")
          .eq(refColumn, refId)
          .eq("ai_detected", true)
          .order("ai_detected_score", { ascending: false }),
        supabase
          .from("similarity_pairs" as any)
          .select("id, question_id, user_a, user_b, score, reasons, created_at")
          .eq("kind", kind)
          .eq("ref_id", refId)
          .order("score", { ascending: false }),
      ]);
      if (sErr) console.warn("[fraud] ai signals", sErr);
      if (pErr) console.warn("[fraud] pairs", pErr);
      setAiSignals(
        ((subs ?? []) as any[]).map((s) => ({
          submissionId: s.id,
          userId: s.user_id,
          score: Number(s.ai_detected_score) || 0,
          reasons: s.ai_detected_reasons ?? null,
        })),
      );
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

  const runDetection = async () => {
    setDetecting(true);
    try {
      const { data, error } = await supabase.functions.invoke("detect-plagiarism", {
        body: { kind, refId },
      });
      if (error) throw error;
      const summary = data as { pairs?: unknown[]; groups_compared?: number; message?: string };
      const found = Array.isArray(summary?.pairs) ? summary.pairs.length : 0;
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
          </div>
          {!hasAi ? (
            <p className="text-xs text-muted-foreground">
              Ninguna entrega supera el umbral del 60% de probabilidad de IA. Las señales se
              actualizan automáticamente al calificar con IA.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Estudiante</TableHead>
                  <TableHead className="w-32">Probabilidad</TableHead>
                  <TableHead>Razones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {aiSignals.map((row) => (
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Estudiante A</TableHead>
                  <TableHead>Estudiante B</TableHead>
                  <TableHead className="w-32">Similitud máx</TableHead>
                  <TableHead className="w-24">Preguntas</TableHead>
                  <TableHead className="text-right">Detalle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupedPairs.map((g) => (
                  <TableRow key={`${g.userA}::${g.userB}`}>
                    <TableCell className="font-medium">{shortName(g.userA, userNames)}</TableCell>
                    <TableCell className="font-medium">{shortName(g.userB, userNames)}</TableCell>
                    <TableCell>
                      <Badge variant={scoreVariant(g.maxScore)}>{formatScore(g.maxScore)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{g.questionCount}</TableCell>
                    <TableCell className="text-right">
                      <RowAction
                        label="Ver preguntas con posible copia"
                        icon={Eye}
                        onClick={() => setDetailOpen({ a: g.userA, b: g.userB })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>

      {/* Modal: detalle por pregunta del par seleccionado. Lista cada
          coincidencia con su question label, similitud y razón. */}
      <Dialog open={detailOpen != null} onOpenChange={(o) => !o && setDetailOpen(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
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
    </Card>
  );
}
