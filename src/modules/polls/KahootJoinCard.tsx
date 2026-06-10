/**
 * KahootJoinCard — punto de entrada del estudiante a un Kahoot en vivo.
 * Aparece en /app/student/polls. Dos caminos:
 *   1. Auto-descubrimiento: lista los juegos activos (status != ended) de
 *      sus cursos (la RLS ya recorta a juegos de cursos donde es miembro).
 *   2. PIN manual: ingresa el PIN que muestra el docente en la pantalla.
 * Al unirse llama `kahoot_join_game` y navega a la vista de jugador.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { Gamepad2, ArrowRight } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface ActiveGame {
  id: string;
  pin: string;
  status: string;
  poll: { title: string } | null;
}

export function KahootJoinCard({ nonce }: { nonce?: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [games, setGames] = useState<ActiveGame[]>([]);
  const [pin, setPin] = useState("");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // RLS recorta a juegos de cursos donde el alumno es miembro.
      const { data } = await db
        .from("kahoot_games")
        .select("id, pin, status, poll:polls(title)")
        .neq("status", "ended")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setGames((data ?? []) as ActiveGame[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const join = async (byPin: string) => {
    const clean = byPin.trim();
    if (!/^[0-9]{6}$/.test(clean)) {
      toast.error(t("kahoot.invalidPin"));
      return;
    }
    setJoining(true);
    try {
      const { data, error } = await db.rpc("kahoot_join_game", { _pin: clean, _nickname: null });
      if (error || !data?.game_id) {
        toast.error(friendlyError(error, t("kahoot.joinError")));
        return;
      }
      navigate({ to: "/app/student/kahoot/$gameId", params: { gameId: data.game_id } });
    } finally {
      setJoining(false);
    }
  };

  // Solo mostramos la tarjeta si hay juegos activos (no saturar la vista
  // cuando no hay nada en vivo). El PIN manual aparece dentro.
  if (games.length === 0) return null;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Gamepad2 className="h-5 w-5 text-primary" />
          <h2 className="font-semibold">{t("kahoot.liveNow")}</h2>
        </div>
        <div className="space-y-2">
          {games.map((g) => (
            <div
              key={g.id}
              className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2"
            >
              <div className="min-w-0">
                <p className="font-medium truncate">{g.poll?.title ?? t("kahoot.liveGame")}</p>
                <Badge variant="secondary" className="text-[10px] tabular-nums mt-0.5">
                  PIN {g.pin}
                </Badge>
              </div>
              <Button size="sm" disabled={joining} onClick={() => void join(g.pin)}>
                {joining ? <Spinner size="sm" className="mr-1" /> : <ArrowRight className="h-4 w-4 mr-1" />}
                {t("kahoot.join")}
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Input
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder={t("kahoot.pinPlaceholder")}
            className="w-32 tabular-nums tracking-widest text-center"
          />
          <Button variant="outline" size="sm" disabled={joining} onClick={() => void join(pin)}>
            {t("kahoot.joinByPin")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
