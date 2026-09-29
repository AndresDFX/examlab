/**
 * «Pendientes para la próxima sesión» en el tablero del curso — la misma
 * tarjeta para el docente y para el estudiante.
 *
 * El estudiante solo lee. El docente además puede tacharlos acá: es donde los
 * está mirando, y mandarlo a Asistencia para marcar uno como hecho sería un
 * viaje por nada.
 *
 * No se dibuja si la institución no activó la función o si no hay nada
 * vigente: una tarjeta vacía en el tablero se aprende a ignorar.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ListTodo } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDateShort, todayLocalISO } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { gruposDePendientes, type SesionOrdenable } from "./pendientes-sesion";
import { usePendientesDeSesiones } from "./use-pendientes-sesion";
import { usePendientesHabilitados } from "./use-pendientes-habilitados";

export function PendientesProximaSesionCard({
  courseId,
  modo,
}: {
  courseId: string;
  modo: "docente" | "estudiante";
}) {
  const { t } = useTranslation();
  const habilitado = usePendientesHabilitados();
  const [sesiones, setSesiones] = useState<SesionOrdenable[]>([]);
  // `hoy` se fija DESPUÉS del montaje: una fecha en el initializer es justo lo
  // que rompe la hidratación (#418).
  const [hoy, setHoy] = useState<string | null>(null);
  // Tachados en esta visita: se siguen mostrando (tachados) para que el que se
  // acaba de marcar no desaparezca bajo el cursor.
  const [tachadosAhora, setTachadosAhora] = useState<Set<string>>(new Set());

  useEffect(() => {
    setHoy(todayLocalISO());
  }, []);

  useEffect(() => {
    if (!habilitado) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("attendance_sessions")
        .select("id, session_date, start_time")
        .eq("course_id", courseId)
        // Papelera: una sesión borrada no ordena ni recibe pendientes.
        .is("deleted_at", null);
      if (cancelled || error) return;
      setSesiones((data ?? []) as SesionOrdenable[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId, habilitado]);

  const pendientes = usePendientesDeSesiones(habilitado ? sesiones.map((s) => s.id) : []);

  const grupos = useMemo(() => {
    if (!hoy) return [];
    // Los tachados en esta visita se agrupan como si siguieran abiertos; el
    // render los pinta tachados leyendo el estado real.
    const paraAgrupar = pendientes.items.map((p) =>
      tachadosAhora.has(p.id) ? { ...p, done_at: null } : p,
    );
    return gruposDePendientes(sesiones, paraAgrupar, hoy);
  }, [sesiones, pendientes.items, tachadosAhora, hoy]);

  if (!habilitado || !hoy || grupos.length === 0) return null;

  const hechoDe = new Map(pendientes.items.map((p) => [p.id, !!p.done_at]));

  return (
    <Card className="border-warning/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTodo className="h-4 w-4 text-warning-on-subtle" />
          {t("pendientesSesion.cardTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {grupos.map((g) => {
          const fecha = formatDateShort(`${g.sesion.session_date}T12:00:00`);
          return (
            <div key={g.sesion.id} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {g.sesion.session_date === hoy
                  ? t("pendientesSesion.groupToday", { date: fecha })
                  : t("pendientesSesion.groupSession", { date: fecha })}
              </p>
              <ul className="space-y-1">
                {g.items.map((item) => {
                  const hecho = hechoDe.get(item.id) ?? false;
                  return modo === "docente" ? (
                    <li key={item.id} className="flex items-start gap-2">
                      <Checkbox
                        checked={hecho}
                        onCheckedChange={() => {
                          setTachadosAhora((prev) => new Set(prev).add(item.id));
                          // El ítem REAL, no el del grupo: ahí un tachado viene
                          // con `done_at` en null para seguir listado, y
                          // `alternar` decide y revierte según ese campo.
                          const real = pendientes.items.find((p) => p.id === item.id) ?? item;
                          void pendientes.alternar(real).then((err) => {
                            if (err) toast.error(err);
                          });
                        }}
                        aria-label={
                          hecho ? t("pendientesSesion.markOpen") : t("pendientesSesion.markDone")
                        }
                        className="mt-0.5"
                      />
                      <span
                        className={cn(
                          "text-sm break-words",
                          hecho && "line-through text-muted-foreground",
                        )}
                      >
                        {item.body}
                      </span>
                    </li>
                  ) : (
                    <li key={item.id} className="flex items-start gap-2 text-sm">
                      <span
                        aria-hidden
                        className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                      />
                      <span className="break-words">{item.body}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
