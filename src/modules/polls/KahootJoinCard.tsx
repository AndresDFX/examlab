/**
 * KahootJoinCard — punto de entrada del estudiante a un Kahoot en vivo.
 * Aparece en /app/student/polls. Caminos:
 *   1. RECONECTAR: juegos donde el alumno YA es jugador (status != ended, poll
 *      no borrado). Entra directo SIN PIN — su identidad es el usuario auth y
 *      kahoot_join_game upsertea por (game,user), así que recargar / volver
 *      nunca lo duplica ni le pide el PIN otra vez (persistencia server-side,
 *      más robusta que un sessionId en localStorage: sobrevive entre dispositivos).
 *   2. PIN manual: el alumno teclea el PIN que el docente proyecta.
 *   3. QR (autoPin): deep-link del QR del docente → auto-une una vez.
 *
 * SEGURIDAD: el PIN NO se expone al alumno. Antes la tarjeta listaba los
 * juegos activos con su `pin` (legible por RLS) y un botón que se unía en
 * 1-click → cualquier alumno del curso entraba SIN teclear el PIN. Ahora la
 * tarjeta NO lee el PIN: unirse a un juego NUEVO exige teclearlo (o escanear
 * el QR). kahoot_get_state tampoco devuelve el PIN a los alumnos.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { Gamepad2, ArrowRight, RotateCcw } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface MyGame {
  id: string;
  title: string;
}

export function KahootJoinCard({
  nonce,
  autoPin,
}: {
  nonce?: number;
  /** PIN recibido por deep-link (QR del docente). Si llega, se auto-une una
   *  sola vez al montar y navega al juego. */
  autoPin?: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  // Juegos activos donde YA soy jugador → puedo reconectar sin PIN.
  const [myGames, setMyGames] = useState<MyGame[]>([]);
  // ¿Hay ALGÚN Kahoot en vivo en mis cursos? Decide si mostrar la tarjeta (no
  // saturar la vista si no hay nada). NO seleccionamos `pin` (era la fuga).
  const [hasLive, setHasLive] = useState(false);
  const [pin, setPin] = useState("");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setMyGames([]);
      setHasLive(false);
      return;
    }
    void (async () => {
      // Existencia de juegos activos (sin PIN) + mis filas de jugador, en
      // paralelo. La RLS recorta a juegos de mis cursos; filtramos
      // estado/papelera en JS.
      const [liveRes, mineRes] = await Promise.all([
        db
          .from("kahoot_games")
          .select("id, status, poll:polls(deleted_at)")
          .neq("status", "ended"),
        db
          .from("kahoot_players")
          .select("game:kahoot_games(id, status, poll:polls(title, deleted_at))")
          .eq("user_id", user.id),
      ]);
      if (cancelled) return;
      const liveRows = ((liveRes.data ?? []) as { poll: { deleted_at: string | null } | null }[]).filter(
        (g) => g.poll && !g.poll.deleted_at,
      );
      setHasLive(liveRows.length > 0);
      const rows = ((mineRes.data ?? []) as { game: { id: string; status: string; poll: { title: string; deleted_at: string | null } | null } | null }[])
        .map((r) => r.game)
        .filter((g): g is { id: string; status: string; poll: { title: string; deleted_at: string | null } | null } =>
          !!g && g.status !== "ended" && !!g.poll && !g.poll.deleted_at,
        )
        .map((g) => ({ id: g.id, title: g.poll!.title }));
      const seen = new Set<string>();
      setMyGames(rows.filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true))));
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce, user]);

  const join = async (byPin: string) => {
    const clean = byPin.trim();
    if (!/^[0-9]{6}$/.test(clean)) {
      toast.error(t("kahoot.invalidPin"));
      setPin("");
      return;
    }
    setJoining(true);
    try {
      const { data, error } = await db.rpc("kahoot_join_game", { _pin: clean, _nickname: null });
      if (error || !data?.game_id) {
        // PIN incorrecto / no matriculado / tenant inválido / sala no
        // disponible → limpieza de estado: borrar el input, avisar y NO
        // navegar al módulo de juego (acceso bloqueado). El backend
        // (kahoot_join_game) devuelve el error específico ya en español.
        toast.error(friendlyError(error, t("kahoot.joinError")));
        setPin("");
        return;
      }
      navigate({ to: "/app/student/kahoot/$gameId", params: { gameId: data.game_id } });
    } finally {
      setJoining(false);
    }
  };

  // Reconectar a un juego donde YA soy jugador: navego directo (sin PIN, sin
  // RPC) — kahoot_get_state funciona porque ya tengo fila de jugador.
  const reconnect = (gameId: string) => {
    navigate({ to: "/app/student/kahoot/$gameId", params: { gameId } });
  };

  // Auto-join cuando llega un PIN por deep-link (QR del docente). Una sola vez
  // por montaje (ref). La seguridad la enforza kahoot_join_game (matrícula +
  // poll no borrado + host presente).
  const autoJoinedRef = useRef(false);
  useEffect(() => {
    if (autoPin && !autoJoinedRef.current) {
      autoJoinedRef.current = true;
      void join(autoPin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPin]);

  // No saturar la vista cuando no hay nada en vivo ni juegos para reconectar.
  // (El auto-join por QR no depende de este render — navega solo en éxito.)
  if (!hasLive && myGames.length === 0) return null;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Gamepad2 className="h-5 w-5 text-primary" />
          <h2 className="font-semibold">{t("kahoot.liveNow")}</h2>
        </div>

        {/* Reconexión: juegos en los que ya estoy. Entrar sin PIN. */}
        {myGames.length > 0 && (
          <div className="space-y-2">
            {myGames.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{g.title || t("kahoot.liveGame")}</p>
                  <p className="text-[11px] text-muted-foreground">{t("kahoot.reconnectHint")}</p>
                </div>
                <Button size="sm" disabled={joining} onClick={() => reconnect(g.id)}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  {t("kahoot.reconnect")}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Unirse a un juego NUEVO: SOLO con el PIN que proyecta el docente (o
            escaneando el QR). Nunca en 1-click — el PIN es el control de acceso. */}
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground">{t("kahoot.enterPinHint")}</p>
          <div className="flex items-center gap-2">
            <Input
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder={t("kahoot.pinPlaceholder")}
              className="w-32 tabular-nums tracking-widest text-center"
            />
            <Button size="sm" disabled={joining || pin.length !== 6} onClick={() => void join(pin)}>
              {joining ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <ArrowRight className="h-4 w-4 mr-1" />
              )}
              {t("kahoot.joinByPin")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
