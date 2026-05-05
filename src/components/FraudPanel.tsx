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
import { AlertTriangle, Bot, Loader2, Search, Users } from "lucide-react";

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
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);

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
      setPairs(((pairsData ?? []) as any[]).map((p) => p as SimilarityRow));
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
        toast.success(`Detección completada: ${found} par${found === 1 ? "" : "es"} sospechoso${found === 1 ? "" : "s"}.`);
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
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
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
              Ninguna entrega supera el umbral del 60% de probabilidad de IA. Las señales se actualizan automáticamente al calificar con IA.
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

        {/* Sección 2: pares de copia entre estudiantes */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Users className="h-4 w-4 text-muted-foreground" />
            Posibles copias entre estudiantes
            <Badge variant="outline" className="ml-auto text-[11px]">
              {hasPairs ? `${pairs.length} par${pairs.length === 1 ? "" : "es"}` : "Sin pares detectados"}
            </Badge>
          </div>
          {!hasPairs ? (
            <p className="text-xs text-muted-foreground">
              Ejecuta "Detectar copias" para comparar las entregas con Gemini. Solo se muestran pares con similitud ≥ 60%.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Estudiante A</TableHead>
                  <TableHead>Estudiante B</TableHead>
                  <TableHead className="w-28">Similitud</TableHead>
                  <TableHead>Razón</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pairs.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{shortName(p.user_a, userNames)}</TableCell>
                    <TableCell className="font-medium">{shortName(p.user_b, userNames)}</TableCell>
                    <TableCell>
                      <Badge variant={scoreVariant(p.score)}>{formatScore(p.score)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-pre-wrap">
                      {p.reasons ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
