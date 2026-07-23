/**
 * Historial de juegos de un Reto en vivo.
 *
 * Cada vez que el docente "Hospeda en vivo" un reto se crea una fila en
 * `kahoot_games` (nunca se borra), así que ese es el historial natural de
 * "cuántas veces se ha usado". Este diálogo lo surface por reto: fecha,
 * PIN, estado, cuántos jugadores participaron y quién ganó.
 *
 * Todo client-side respetando RLS: el docente (miembro/ancla del poll) puede
 * leer `kahoot_games` + `kahoot_players` de sus propios retos.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { DateCell } from "@/components/ui/date-cell";
import { StatCard } from "@/components/ui/stat-card";
import { History, Users, Trophy, Gamepad2 } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface GameRow {
  id: string;
  pin: string;
  status: string;
  created_at: string;
  players: number;
  winner: string | null;
  winnerScore: number | null;
}

export function KahootHistoryDialog({
  pollId,
  pollTitle,
  onClose,
}: {
  pollId: string;
  pollTitle: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: games, error: gErr } = await db
          .from("kahoot_games")
          .select("id, pin, status, created_at")
          .eq("poll_id", pollId)
          .order("created_at", { ascending: false });
        if (cancelled) return;
        if (gErr) {
          setError(friendlyError(gErr));
          return;
        }
        const list = (games ?? []) as Array<{ id: string; pin: string; status: string; created_at: string }>;
        const ids = list.map((g) => g.id);
        let players: Array<{ game_id: string; nickname: string; score: number }> = [];
        if (ids.length) {
          const { data: pl } = await db
            .from("kahoot_players")
            .select("game_id, nickname, score")
            .in("game_id", ids);
          players = (pl ?? []) as typeof players;
        }
        if (cancelled) return;
        const byGame = new Map<string, { count: number; winner: string | null; score: number | null }>();
        for (const p of players) {
          const cur = byGame.get(p.game_id) ?? { count: 0, winner: null, score: null };
          cur.count += 1;
          if (cur.score == null || (p.score ?? 0) > cur.score) {
            cur.score = p.score ?? 0;
            cur.winner = p.nickname;
          }
          byGame.set(p.game_id, cur);
        }
        setRows(
          list.map((g) => {
            const agg = byGame.get(g.id);
            return {
              id: g.id,
              pin: g.pin,
              status: g.status,
              created_at: g.created_at,
              players: agg?.count ?? 0,
              winner: agg?.winner ?? null,
              winnerScore: agg?.score ?? null,
            };
          }),
        );
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pollId]);

  const totals = useMemo(() => {
    const games = rows.length;
    const players = rows.reduce((s, r) => s + r.players, 0);
    const finished = rows.filter((r) => r.status === "ended" || r.status === "podium").length;
    return { games, players, finished };
  }, [rows]);

  const statusLabel = (s: string) =>
    s === "ended" || s === "podium"
      ? t("kahoot.historyFinished", { defaultValue: "Finalizado" })
      : t("kahoot.historyUnfinished", { defaultValue: "Sin terminar" });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {t("kahoot.historyTitle", { defaultValue: "Historial de juegos" })}
          </DialogTitle>
          <DialogDescription>
            {t("kahoot.historySubtitle", {
              defaultValue: "Cada vez que hospedaste este reto en vivo queda registrado aquí.",
            })}{" "}
            <span className="font-medium text-foreground">{pollTitle}</span>
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-10 flex justify-center">
            <Spinner size="lg" />
          </div>
        ) : error ? (
          <EmptyState text={error} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Gamepad2}
            text={t("kahoot.historyEmpty", { defaultValue: "Todavía no has hospedado este reto" })}
            hint={t("kahoot.historyEmptyHint", {
              defaultValue: "Cuando lo hospedes en vivo, cada partida aparecerá acá.",
            })}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatCard icon={Gamepad2} label={t("kahoot.historyStatGames", { defaultValue: "Veces jugado" })} value={String(totals.games)} />
              <StatCard icon={Users} label={t("kahoot.historyStatPlayers", { defaultValue: "Jugadores (total)" })} value={String(totals.players)} />
              <StatCard icon={Trophy} label={t("kahoot.historyStatFinished", { defaultValue: "Finalizados" })} value={String(totals.finished)} />
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("kahoot.historyColDate", { defaultValue: "Fecha" })}</TableHead>
                    <TableHead className="hidden sm:table-cell">PIN</TableHead>
                    <TableHead>{t("kahoot.historyColStatus", { defaultValue: "Estado" })}</TableHead>
                    <TableHead className="text-right">{t("kahoot.historyColPlayers", { defaultValue: "Jugadores" })}</TableHead>
                    <TableHead>{t("kahoot.historyColWinner", { defaultValue: "Ganador" })}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <DateCell value={r.created_at} variant="datetime" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell tabular-nums text-muted-foreground">{r.pin}</TableCell>
                      <TableCell>
                        <Badge
                          variant={r.status === "ended" || r.status === "podium" ? "default" : "secondary"}
                          className="text-[10px]"
                        >
                          {statusLabel(r.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.players}</TableCell>
                      <TableCell className="truncate max-w-[12rem]">
                        {r.winner ? (
                          <span className="flex items-center gap-1">
                            <Trophy className="h-3 w-3 text-amber-500 shrink-0" />
                            {r.winner}
                            {r.winnerScore != null && (
                              <span className="text-muted-foreground tabular-nums">· {r.winnerScore}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
