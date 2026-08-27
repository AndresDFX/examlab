/**
 * Pantalla de proyección del check-in de asistencia.
 *
 * El docente abre este componente al iniciar el check-in. Renderiza un
 * overlay fullscreen (vía Fullscreen API) con:
 *   - QR enorme (deep-link a /app/student/attendance?session=...&code=...)
 *   - Código de 6 dígitos como fallback manual
 *   - Countdown a la próxima rotación + a cierre de la ventana
 *   - Contador live "presentes/total" con realtime de attendance_records
 *   - Botones: cerrar fullscreen, cerrar check-in
 *
 * Recibe la `seed` (devuelta por la RPC al abrir) y deriva el código en
 * cliente. Eso evita una llamada a server por cada rotación.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Check, Link2 as LinkIcon, LogOut, Maximize2, Minimize2, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { friendlyError } from "@/shared/lib/db-errors";
import { partesCuentaAtras } from "./rotation-countdown";
import { formatTime } from "@/shared/lib/format";
import i18n from "@/i18n";
import {
  requestFullscreen as requestFullscreenCompat,
  exitFullscreen as exitFullscreenCompat,
  currentFullscreenElement,
  onFullscreenChange,
} from "@/shared/lib/fullscreen";
import {
  attendanceCodeIsStatic,
  attendancePeriod,
  attendanceSecondsToNextRotation,
  buildAttendanceCheckInUrl,
  computeAttendanceCode,
} from "@/modules/attendance/attendance-code";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type CheckInState = {
  sessionId: string;
  seed: string;
  rotationSeconds: number;
  closesAt: string; // ISO
  /** Total de matriculados en el curso — usado para el contador X/Y */
  totalEnrolled: number;
  sessionLabel?: string;
};

interface Props {
  state: CheckInState;
  /** Llamado cuando el docente cierra el check-in (o expira) */
  onClose: () => void;
  /** Llamado al extender la ventana, con el nuevo cierre en ISO. El padre es
   *  dueño de `state`, así que sin esto el contador seguiría con el viejo. */
  onExtended?: (closesAt: string) => void;
  /**
   * Salir de la proyección DEJANDO el check-in abierto.
   *
   * Hasta ahora la única salida era "Cerrar check-in", que cierra la ventana en
   * la base y además ofrece marcar ausentes a todos los que no alcanzaron a
   * marcar. O sea que el docente tenía que dejar esta pantalla abierta —y el
   * proyector encendido— todo el tiempo que quisiera recibir asistencias. Con
   * una ventana de 24 horas eso es directamente imposible.
   */
  onExit?: () => void;
}

/**
 * Tiempo restante hasta el cierre, en la unidad que se pueda leer de un vistazo.
 *
 * Devolvía `m:ss`, que con una ventana de 6 horas daba **"359:56"** — el mismo
 * defecto que el contador de rotación de al lado, y por la misma razón: el
 * formato se escribió cuando el check-in duraba minutos. Bajo una hora se sigue
 * mostrando `m:ss`, que es lo útil cuando la ventana se está cerrando.
 */
function textoRestante(ms: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  const cd = partesCuentaAtras(total);
  return t(`hc_modulesAttendanceAttendanceCheckInProjector.remaining_${cd.unidad}`, {
    count: cd.valor,
  });
}

export function AttendanceCheckInProjector({ state, onClose, onExtended, onExit }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [code, setCode] = useState("------");
  /** `null` = código fijo: no hay próxima rotación que contar. */
  const [secondsToRotation, setSecondsToRotation] = useState<number | null>(
    attendanceSecondsToNextRotation(state.rotationSeconds),
  );
  const codigoFijo = attendanceCodeIsStatic(state.rotationSeconds);
  const [msToClose, setMsToClose] = useState(() => new Date(state.closesAt).getTime() - Date.now());
  const [presentCount, setPresentCount] = useState(0);
  /**
   * Quiénes marcaron, del más reciente al más antiguo.
   *
   * Antes esta pantalla solo mostraba "0 / 23". Un número que sube no le sirve
   * al estudiante que acaba de escanear desde el fondo del salón: lo que
   * necesita es VER SU NOMBRE y dejar de escanear. Y al docente, saber quién
   * falta sin ir a la grilla.
   */
  const [presentes, setPresentes] = useState<
    Array<{ userId: string; nombre: string; hora: string; status: string }>
  >([]);
  const [extendiendo, setExtendiendo] = useState(false);

  /**
   * Copia el MISMO enlace que codifica el QR. Hasta ahora esa URL solo existía
   * dentro del código QR: en una sesión VIRTUAL no hay proyección que escanear,
   * así que el check-in por enlace era inalcanzable aunque el flujo público ya
   * estuviera implementado. El enlace lleva el código del período ACTUAL, así
   * que hay que pegarlo en el chat de la clase mientras la ventana está abierta
   * — igual que mostrar el QR.
   */
  const copiarEnlace = async () => {
    try {
      await navigator.clipboard.writeText(qrUrl);
      toast.success(i18n.t("toast.modules_attendance_AttendanceCheckInProjector.linkCopied"));
    } catch {
      toast.error(i18n.t("toast.modules_attendance_AttendanceCheckInProjector.linkCopyFailed"));
    }
  };

  /**
   * Suma minutos a la ventana SIN regenerar la semilla: el QR proyectado y el
   * que los alumnos tienen a medio escanear siguen sirviendo. Antes la única
   * forma de estirar era volver a abrir el check-in, que sí cambia todos los
   * códigos y deja afuera a quien estaba escaneando en ese momento.
   */
  const extender = async (minutos: number) => {
    if (extendiendo) return;
    setExtendiendo(true);
    try {
      const { data, error } = await db.rpc("teacher_extend_attendance_check_in", {
        p_session_id: state.sessionId,
        p_extra_minutes: minutos,
      });
      const r = data as { ok?: boolean; error?: string; closes_at?: string } | null;
      if (error || !r?.ok || !r.closes_at) {
        toast.error(
          r?.error === "max_window"
            ? i18n.t("toast.modules_attendance_AttendanceCheckInProjector.extendMaxWindow")
            : friendlyError(
                error,
                i18n.t("toast.modules_attendance_AttendanceCheckInProjector.extendFailed"),
              ),
        );
        return;
      }
      setMsToClose(new Date(r.closes_at).getTime() - Date.now());
      onExtended?.(r.closes_at);
      toast.success(
        i18n.t("toast.modules_attendance_AttendanceCheckInProjector.extendOk", { count: minutos }),
      );
    } finally {
      setExtendiendo(false);
    }
  };
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1024,
    h: typeof window !== "undefined" ? window.innerHeight : 768,
  }));

  // El QR se calcula contra ambas dimensiones del viewport — sin esto, en
  // móvil portrait el alto sobra pero el ancho es chico y el QR se sale.
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Recalcula el código cuando cambia el período actual.
  const recomputeCode = useCallback(async () => {
    const period = attendancePeriod(state.rotationSeconds);
    const c = await computeAttendanceCode(state.seed, period);
    setCode(c);
  }, [state.seed, state.rotationSeconds]);

  useEffect(() => {
    void recomputeCode();
  }, [recomputeCode]);

  // Tick cada 1s: actualiza countdowns y dispara nuevo cálculo del código en rotación.
  useEffect(() => {
    let cancelled = false;
    let prevPeriod = attendancePeriod(state.rotationSeconds);
    const tick = () => {
      if (cancelled) return;
      const remaining = attendanceSecondsToNextRotation(state.rotationSeconds);
      setSecondsToRotation(remaining);
      const period = attendancePeriod(state.rotationSeconds);
      if (period !== prevPeriod) {
        prevPeriod = period;
        void recomputeCode();
      }
      const ms = new Date(state.closesAt).getTime() - Date.now();
      setMsToClose(ms);
      if (ms <= 0) {
        // Auto-cierre por expiración. CRÍTICO: cerrar también la DB
        // (UPDATE check_in_open=false + DELETE state) antes de invocar
        // onClose. Si no, queda inconsistencia: sessions.check_in_open
        // sigue true pero la ventana ya pasó → al reabrir el proyector,
        // el tick vuelve a detectar expiración y se cierra en loop.
        cancelled = true;
        toast.info(
          i18n.t("toast.modules_attendance_AttendanceCheckInProjector.windowExpired", {
            defaultValue: "La ventana de check-in expiró",
          }),
        );
        void db
          .rpc("teacher_close_attendance_check_in", { p_session_id: state.sessionId })
          .finally(() => onClose());
      }
    };
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [state.rotationSeconds, state.closesAt, state.sessionId, recomputeCode, onClose]);

  // Carga inicial + realtime de quiénes marcaron, para esta sesión.
  useEffect(() => {
    let cancelled = false;

    /**
     * Trae la lista completa en vez de mantener un set local con los eventos del
     * canal. Es a propósito: son decenas de filas, y un set local se
     * desincroniza en cuanto se pierde un evento (pestaña dormida, reconexión) —
     * justo lo que pasa en una proyección que queda abierta una hora. Refetchear
     * es la versión que se auto-corrige.
     *
     * Dos consultas porque `attendance_records.user_id` apunta a `auth.users` y
     * NO a `profiles`: el embed de PostgREST falla en silencio (convención
     * documentada del proyecto).
     */
    const recargar = async () => {
      const { data } = await db
        .from("attendance_records")
        .select("user_id, status, created_at")
        .eq("session_id", state.sessionId)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      const filas = (data ?? []) as Array<{
        user_id: string;
        status: string;
        created_at: string;
      }>;
      // El contador conserva su significado: PRESENTES cuenta 'presente'. Los
      // demás estados (una tardanza que el docente puso desde su grilla) salen
      // en la lista con su etiqueta, así que no hay número que contradiga a la
      // lista.
      setPresentCount(filas.filter((f) => f.status === "presente").length);
      if (filas.length === 0) {
        setPresentes([]);
        return;
      }
      const { data: perfiles } = await db
        .from("profiles")
        .select("id, full_name")
        .in("id", [...new Set(filas.map((f) => f.user_id))]);
      if (cancelled) return;
      const nombrePorId = new Map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((perfiles ?? []) as any[]).map((x) => [x.id as string, x.full_name as string]),
      );
      setPresentes(
        filas.map((f) => ({
          userId: f.user_id,
          nombre: nombrePorId.get(f.user_id) ?? "—",
          hora: formatTime(f.created_at),
          status: f.status,
        })),
      );
    };

    void recargar();
    const channel = supabase
      .channel(`checkin-${state.sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "attendance_records",
          filter: `session_id=eq.${state.sessionId}`,
        },
        () => void recargar(),
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [state.sessionId]);

  // Fullscreen API, por el helper compartido. Safari solo expone la versión
  // prefijada (`webkitRequestFullscreen`), así que el `if (el.requestFullscreen)`
  // de antes lo salteaba en silencio: el docente proyectaba el QR con la barra
  // de direcciones y las pestañas a la vista del salón.
  const pedirFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    await requestFullscreenCompat(el);
  }, []);

  // Sale de fullscreen sin cerrar el check-in.
  const salirFullscreen = useCallback(async () => {
    await exitFullscreenCompat();
  }, []);

  // Auto-request fullscreen al montar (gesto del usuario que abrió el dialog).
  useEffect(() => {
    void pedirFullscreen();
  }, [pedirFullscreen]);

  useEffect(() => {
    // Los dos eventos: en Safari solo llega el prefijado, y sin él el botón
    // seguía diciendo "Pantalla completa" estando ya en pantalla completa.
    return onFullscreenChange(() => setIsFullscreen(currentFullscreenElement() != null));
  }, []);

  const handleCloseCheckIn = async () => {
    // No mostramos confirm aquí: estaríamos en fullscreen y el Dialog se
    // renderiza en document.body, fuera del elemento fullscreen-ed → queda
    // OCULTO y el botón parece colgarse. Si el docente cierra por error,
    // puede reabrir el check-in. La confirmación de "marcar pendientes
    // ausentes" sí aparece después porque ya salimos de fullscreen.
    setClosing(true);
    try {
      const { error } = await db.rpc("teacher_close_attendance_check_in", {
        p_session_id: state.sessionId,
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      // Fire-and-forget: en algunos browsers exitFullscreen no resuelve
      // hasta el próximo fullscreenchange y eso bloquea el handler.
      void salirFullscreen();
      onClose();
      toast.success(
        i18n.t("toast.modules_attendance_AttendanceCheckInProjector.closedOk", {
          defaultValue: "Check-in cerrado",
        }),
      );
    } finally {
      setClosing(false);
    }
  };

  const qrUrl = useMemo(
    () => buildAttendanceCheckInUrl(window.location.origin, state.sessionId, code),
    [state.sessionId, code],
  );

  // Formato bonito del código: "123 456"
  const codePretty = useMemo(() => `${code.slice(0, 3)} ${code.slice(3, 6)}`, [code]);
  const rotationPct =
    codigoFijo || secondsToRotation == null
      ? 0
      : Math.round(((state.rotationSeconds - secondsToRotation) / state.rotationSeconds) * 100);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[100] bg-background text-foreground flex flex-col"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between gap-2 px-3 sm:px-6 py-2 sm:py-3 border-b">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <div className="hidden sm:block text-sm sm:text-base font-medium truncate">
            {t("hc_modulesAttendanceAttendanceCheckInProjector.title")}
            {state.sessionLabel && (
              <span className="text-muted-foreground"> — {state.sessionLabel}</span>
            )}
          </div>
          <Badge variant="secondary" className="text-xs whitespace-nowrap">
            {t("hc_modulesAttendanceAttendanceCheckInProjector.closesIn", {
              time: textoRestante(msToClose, t),
            })}
          </Badge>
          {/* Pegado al contador a propósito: el docente mira el tiempo que
              queda y ahí mismo tiene cómo estirarlo, sin salir del proyector
              ni tener que cerrar y reabrir (que cambiaría todos los códigos). */}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void copiarEnlace()}
              title={t("hc_modulesAttendanceAttendanceCheckInProjector.copyLinkTitle")}
            >
              <LinkIcon className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_modulesAttendanceAttendanceCheckInProjector.copyLink")}
              </span>
            </Button>
            {[5, 10, 15].map((m) => (
              <Button
                key={m}
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs tabular-nums"
                disabled={extendiendo}
                onClick={() => void extender(m)}
                title={t("hc_modulesAttendanceAttendanceCheckInProjector.extendTitle", {
                  count: m,
                })}
              >
                {extendiendo ? <Spinner size="xs" /> : `+${m}`}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {isFullscreen ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void salirFullscreen()}
              aria-label={t("hc_modulesAttendanceAttendanceCheckInProjector.exitFullscreen")}
            >
              <Minimize2 className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_modulesAttendanceAttendanceCheckInProjector.exitFullscreen")}
              </span>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void pedirFullscreen()}
              aria-label={t("hc_modulesAttendanceAttendanceCheckInProjector.enterFullscreen")}
            >
              <Maximize2 className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_modulesAttendanceAttendanceCheckInProjector.enterFullscreen")}
              </span>
            </Button>
          )}
          {/* Salir sin cerrar: el check-in sigue recibiendo marcaciones y el
              docente puede volver a proyectarlo cuando quiera. Va ANTES del
              botón rojo y en tono neutro, para que la salida obvia no sea la
              destructiva. */}
          {onExit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await salirFullscreen();
                onExit();
              }}
              aria-label={t("hc_modulesAttendanceAttendanceCheckInProjector.exitKeepOpen")}
              title={t("hc_modulesAttendanceAttendanceCheckInProjector.exitKeepOpenHint")}
            >
              <LogOut className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_modulesAttendanceAttendanceCheckInProjector.exitKeepOpen")}
              </span>
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={handleCloseCheckIn}
            disabled={closing}
            aria-label={t("hc_modulesAttendanceAttendanceCheckInProjector.closeCheckIn")}
          >
            {closing ? (
              <Spinner size="md" className="sm:mr-1" />
            ) : (
              <X className="h-4 w-4 sm:mr-1" />
            )}
            <span className="hidden sm:inline">
              {t("hc_modulesAttendanceAttendanceCheckInProjector.closeCheckIn")}
            </span>
          </Button>
        </div>
      </div>

      {/* Main: QR centrado a la izquierda, info a la derecha */}
      <div className="flex-1 min-h-0 overflow-y-auto grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 sm:gap-6 p-3 sm:p-8 items-center justify-items-center">
        <div className="flex flex-col items-center gap-3 max-w-full">
          <div className="bg-white p-3 sm:p-6 rounded-xl shadow-lg">
            <QRCodeSVG
              value={qrUrl}
              // Cap por ancho (con padding de la card + p-3) Y por alto, para
              // que no rebase ni en móvil portrait ni en proyección.
              size={Math.max(
                160,
                Math.min(
                  viewport.h * 0.55,
                  viewport.w - 48, // 2 × p-3 del contenedor + 2 × p-3 de la card blanca
                  600,
                ),
              )}
              level="M"
              includeMargin={false}
            />
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground text-center max-w-md px-2">
            {t("hc_modulesAttendanceAttendanceCheckInProjector.scanHint")}
          </p>
        </div>

        <div className="flex flex-col gap-4 sm:gap-6 items-center lg:items-start min-w-0 sm:min-w-[260px] w-full sm:w-auto">
          <div className="flex flex-col items-center lg:items-start gap-1 w-full">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("hc_modulesAttendanceAttendanceCheckInProjector.manualCode")}
            </div>
            <div className="font-mono font-bold tabular-nums text-4xl sm:text-7xl tracking-wider">
              {codePretty}
            </div>
            {/* Barra de progreso a próxima rotación. Con código FIJO no hay
                nada que contar: mostrar una barra vacía y "rota en 0s" para
                siempre sería peor que no mostrar nada, así que se reemplaza por
                una línea que dice que el código no cambia. */}
            {codigoFijo ? (
              <div className="text-2xs text-muted-foreground mt-2">
                {t("hc_modulesAttendanceAttendanceCheckInProjector.codeFixed")}
              </div>
            ) : (
              <div className="w-full max-w-[300px] mt-2">
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-1000 ease-linear"
                    style={{ width: `${rotationPct}%` }}
                  />
                </div>
                {/* En palabras y con la unidad que corresponde: con ventanas de
                    días la rotación puede ser de 24 h, y decía literalmente
                    "Rota en 84797s" — cinco dígitos en la pantalla del salón,
                    que se leen como un error de configuración. */}
                <div className="text-2xs text-muted-foreground mt-1 tabular-nums">
                  {(() => {
                    const cd = partesCuentaAtras(secondsToRotation);
                    return t(
                      `hc_modulesAttendanceAttendanceCheckInProjector.rotatesIn_${cd.unidad}`,
                      { count: cd.valor },
                    );
                  })()}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col items-center lg:items-start gap-1">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("hc_modulesAttendanceAttendanceCheckInProjector.present")}
            </div>
            <div className="text-4xl sm:text-7xl font-semibold tabular-nums">
              {presentCount}
              <span className="text-xl sm:text-3xl text-muted-foreground">
                {" "}
                / {state.totalEnrolled}
              </span>
            </div>
          </div>

          {/* Quiénes van marcando, el último arriba.
              El primero de la lista va resaltado y más grande: quien acaba de
              escanear desde el fondo del salón tiene que poder confirmar de un
              vistazo que su marca entró, sin leer una lista de veinte nombres.
              La lista scrollea sola y no empuja el QR. */}
          {presentes.length > 0 && (
            <div className="flex flex-col gap-1 w-full min-w-0">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {t("hc_modulesAttendanceAttendanceCheckInProjector.arrivals")}
              </div>
              <ul className="flex flex-col gap-1 w-full max-h-[38dvh] overflow-y-auto pr-1">
                {presentes.map((pz, i) => (
                  <li
                    key={pz.userId}
                    className={
                      i === 0
                        ? "flex items-center gap-2 rounded-md bg-primary/15 px-2 py-1.5 text-base sm:text-xl font-semibold min-w-0"
                        : "flex items-center gap-2 px-2 py-0.5 text-sm sm:text-base text-muted-foreground min-w-0"
                    }
                  >
                    <Check
                      className={
                        i === 0
                          ? "h-4 w-4 sm:h-5 sm:w-5 shrink-0 text-primary"
                          : "h-3.5 w-3.5 shrink-0 opacity-60"
                      }
                    />
                    <span className="truncate">{pz.nombre}</span>
                    {/* Un estado que no sea 'presente' solo lo pone el docente
                        desde su grilla; se etiqueta para que la lista no
                        contradiga al contador de arriba. */}
                    {pz.status !== "presente" && (
                      <Badge variant="outline" className="text-3xs shrink-0">
                        {pz.status}
                      </Badge>
                    )}
                    <span className="ml-auto text-2xs tabular-nums opacity-70 shrink-0">
                      {pz.hora}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
