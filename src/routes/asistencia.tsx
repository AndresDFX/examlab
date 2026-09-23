/**
 * Check-in de asistencia PÚBLICO — marcar asistencia SIN loguearse.
 *
 * Ruta: /asistencia?session=<uuid>   (pública, fuera de /app →
 * El código NO viaja en la URL (ver `buildAttendanceCheckInUrl`): el QR solo
 * trae la sesión y los seis dígitos se teclean leyéndolos de la pantalla, que
 * es la prueba de presencia. Se sigue aceptando `?code=` de un enlace viejo,
 * porque el campo se inicializa con lo que venga en la query.
 * sin AppLayout ni auth guard). El QR del proyector y el link que el docente
 * comparte apuntan acá (ver buildAttendanceCheckInUrl).
 *
 * Espeja el patrón del "Reto en vivo" público (/reto/$pin), pero como la
 * asistencia se ata a la identidad REAL del alumno (no un nickname anónimo),
 * pide correo + CONTRASEÑA. La verificación de credenciales + el marcado los
 * hace el edge `public-attendance-check-in` (contraseña server-side, sin
 * loguear al alumno). Si el alumno YA está logueado, se salta las credenciales
 * y marca directo con el RPC `student_check_in_attendance` (auth.uid()).
 *
 * SEGURIDAD: el `session` fija la sesión → un solo curso → un solo tenant. El
 * check-in marca EXACTAMENTE esa sesión y solo si el alumno está matriculado
 * en ese curso (lo valida el edge/RPC). Sin fuga cross-curso ni cross-tenant,
 * aunque el alumno esté en varios cursos.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatDateOnly, formatDateOnlyShort, formatDateTime } from "@/shared/lib/format";
import {
  resumirTituloDeSesion,
  encabezadoDeCurso,
  TOPE_TITULO_SESION,
  TITULO_EN_FRASE,
} from "@/modules/attendance/titulo-sesion";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { CheckCircle2, XCircle, CalendarCheck, LogIn } from "lucide-react";

/** Lo que devuelven las RPC de marcado. `already` = la asistencia YA estaba. */
interface RequisitoPendiente {
  kind: "poll" | "workshop" | "project" | "exam" | "report_signature";
  id: string;
  title: string;
  public_token: string | null;
}

interface RespuestaCheckIn {
  /** Sesiones ADEMÁS de la escaneada que quedaron marcadas con el mismo código
   *  («asistencia múltiple», mig 20262310000000). 0 en el caso normal. */
  marcadas?: number;
  /** Los nombres de esas sesiones. */
  sesiones?: string[];
  ok?: boolean;
  error?: string;
  already?: boolean;
  status?: string;
  /** Ítems del curso que faltan completar. Pueden ser VARIOS. */
  requirements?: RequisitoPendiente[] | null;
  /** Formato anterior: una sola. Se sigue leyendo por compatibilidad. */
  requirement?: RequisitoPendiente | null;
}

/**
 * El enlace donde se resuelve un requisito, o `null` si no hay uno público.
 *
 * Esta página la abre gente SIN sesión (es su razón de existir), así que solo
 * sirven los enlaces públicos: mandar a `/app/...` deja a la persona en el login,
 * que es peor que no ofrecer nada.
 */
function enlacePublicoDeRequisito(r: RequisitoPendiente): string | null {
  if (!r.public_token) return null;
  if (r.kind === "poll") return `/encuesta/${r.public_token}`;
  if (r.kind === "report_signature") return `/documento/${r.public_token}`;
  return null;
}

/** Lo que devuelve `attendance_check_in_public_info`. */
interface InfoPublica {
  open: boolean;
  email_only: boolean;
  not_started?: boolean;
  opens_at?: string;
  course_name?: string;
  course_group?: string | null;
  session_title?: string | null;
  session_date?: string;
  session_type?: string;
  closes_at?: string;
  /** Las sesiones que este mismo código cubre. Vacío o ausente cuando el
   *  check-in es de una sola, que es el caso normal. */
  group_sessions?: Array<{
    title?: string | null;
    session_date?: string | null;
    /** La clase desde la que se abrió el código: la de hoy. */
    is_anchor?: boolean;
  }>;
}

export const Route = createFileRoute("/asistencia")({
  validateSearch: (s: Record<string, unknown>) => ({
    session: typeof s.session === "string" ? s.session : "",
    code: typeof s.code === "string" ? s.code : "",
  }),
  head: () => ({
    meta: [{ title: "Asistencia · ExamLab" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: PublicAttendance,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Mapea el error del RPC a un mensaje claro para el alumno. */
function errorText(
  t: (k: string, o?: Record<string, unknown>) => string,
  code: string | null,
): string {
  switch (code) {
    case "bad_credentials":
      return t("publicAttendance.errBadCredentials", {
        defaultValue: "Correo o contraseña inválidos.",
      });
    case "not_enrolled":
      return t("publicAttendance.errNotEnrolled", {
        defaultValue: "No estás matriculado en el curso de esta sesión.",
      });
    case "invalid_code":
      return t("publicAttendance.errInvalidCode", {
        defaultValue: "El código no es válido o expiró. Pedile al docente el código actual.",
      });
    case "not_started":
      return t("publicAttendance.errNotStarted", {
        defaultValue: "El check-in de esta sesión todavía no empezó.",
      });
    case "check_in_closed":
      return t("publicAttendance.errClosed", {
        defaultValue: "El check-in de esta sesión está cerrado.",
      });
    case "session_not_found":
      return t("publicAttendance.errSession", {
        defaultValue: "La sesión no existe o fue eliminada.",
      });
    case "requirement_pending":
      // Red de seguridad: el mensaje BUENO —con el nombre del ítem y su enlace— lo
      // arma el bloque de requisitos del render. Esta rama cubre el caso en que la
      // respuesta no traiga el detalle, para que nadie lea «Intentá de nuevo» sobre
      // algo que reintentar no arregla.
      return t("publicAttendance.errRequirement", {
        defaultValue: "Te falta completar un ítem del curso antes de poder marcar asistencia.",
      });
    case "invalid_email":
      return t("publicAttendance.errInvalidEmail", {
        defaultValue: "Ese correo no está registrado en el curso de esta sesión.",
      });
    case "password_required":
      return t("publicAttendance.errPasswordRequired", {
        defaultValue: "Esta sesión pide tu contraseña además del correo.",
      });
    default:
      return t("publicAttendance.errGeneric", {
        defaultValue: "No se pudo registrar la asistencia. Intentá de nuevo.",
      });
  }
}

type Status = "idle" | "submitting" | "success" | "error";

function PublicAttendance() {
  const { t } = useTranslation();
  const { session, code: codeFromUrl } = Route.useSearch();
  const { user, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState(codeFromUrl);
  const [status, setStatus] = useState<Status>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pendientes, setPendientes] = useState<RequisitoPendiente[]>([]);
  /** `null` mientras no se sabe: el campo de contraseña no se pinta hasta que
   *  el servidor dice si este check-in la pide. Asumir que sí y esconderla
   *  después haría saltar el formulario; asumir que no la pediría de más. */
  const [soloCorreo, setSoloCorreo] = useState<boolean | null>(null);
  /**
   * De qué es este check-in. `null` mientras carga.
   *
   * Antes la página mostraba un formulario pelado: el estudiante no sabía de qué
   * curso ni de qué sesión era lo que estaba a punto de marcar, y con varias
   * materias el mismo día eso es pedirle que firme a ciegas. El servidor solo lo
   * dice cuando el check-in está EFECTIVAMENTE abierto.
   */
  const [info, setInfo] = useState<InfoPublica | null>(null);
  /** La asistencia YA estaba puesta antes de este intento. */
  const [yaEstaba, setYaEstaba] = useState(false);
  /** En cuántas sesiones MÁS quedó marcado (0 = check-in de una sola sesión). */
  const [tambienEn, setTambienEn] = useState<string[]>([]);
  /** Estado registrado (presente / tardanza / justificado / ausente). */
  const [estadoPrevio, setEstadoPrevio] = useState<string | null>(null);

  // El modo lo decide el SERVIDOR. Esto es solo para no pedir un dato que no
  // hace falta: si el cliente mintiera y omitiera la contraseña, la RPC
  // responde `password_required` y el formulario la vuelve a pedir.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      // `as any`: los tipos de Supabase se generan desde la BASE y todavía no
      // conocen esta función (la migración viaja en este mismo cambio). Mismo
      // patrón que el resto de las RPC nuevas del proyecto.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any).rpc("attendance_check_in_public_info", {
        p_session_id: session,
      });
      if (cancelled) return;
      setInfo((data as InfoPublica | null) ?? { open: false, email_only: false });
      setSoloCorreo(!!(data as InfoPublica | null)?.email_only);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    setCode(codeFromUrl);
  }, [codeFromUrl]);

  const applyResult = (res: RespuestaCheckIn | null) => {
    if (res?.ok) {
      // `already` distingue "se registró recién" de "ya estaba". Sin esto, el
      // alumno que vuelve a escanear —porque no vio el mensaje, porque recargó,
      // porque el QR sigue proyectado— recibe otra vez "asistencia registrada"
      // y no puede saber si marcó dos veces.
      setYaEstaba(!!res.already);
      setTambienEn((res.sesiones ?? []).filter(Boolean));
      setEstadoPrevio(res.status ?? null);
      setStatus("success");
    } else {
      // Un requisito pendiente NO es un fallo genérico: hay algo concreto que hacer.
      // Sin esta rama la persona leía «Intentá de nuevo» —el `default` de
      // `errorText`— y reintentar no funciona nunca, así que el mensaje la manda a
      // un callejón sin salida justo cuando la clase está empezando.
      const pend = res?.requirements?.length
        ? res.requirements
        : res?.requirement
          ? [res.requirement]
          : [];
      setPendientes(pend);
      setErrorCode(res?.error ?? "unknown");
      setStatus("error");
    }
  };

  // Alumno YA logueado: marca directo con su sesión (auth.uid()), sin pedir
  // credenciales otra vez.
  const checkInLoggedIn = async () => {
    if (!code.trim()) return;
    setStatus("submitting");
    try {
      const { data, error } = await db.rpc("student_check_in_attendance", {
        p_session_id: session,
        p_code: code.trim(),
      });
      if (error) {
        setErrorCode("unknown");
        setStatus("error");
        return;
      }
      applyResult(data);
    } catch {
      setErrorCode("unknown");
      setStatus("error");
    }
  };

  // Alumno NO logueado: verifica correo+contraseña vía edge (server-side) y
  // marca asistencia sin crear sesión en la app.
  const checkInPublic = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || cleanEmail.indexOf("@") < 1 || !code.trim() || (!soloCorreo && !password)) {
      toast.error(
        soloCorreo
          ? t("publicAttendance.fillEmailCode", {
              defaultValue: "Completá tu correo y el código.",
            })
          : t("publicAttendance.fillAll", {
              defaultValue: "Completá correo, contraseña y código.",
            }),
      );
      return;
    }
    setStatus("submitting");
    try {
      const { data, error } = await supabase.functions.invoke("public-attendance-check-in", {
        // Sin contraseña en modo solo-correo: el edge toma la rama que exige
        // `email_only` server-side.
        body: {
          email: cleanEmail,
          password: soloCorreo ? "" : password,
          sessionId: session,
          code: code.trim(),
        },
      });
      if (error) {
        setErrorCode("unknown");
        setStatus("error");
        return;
      }
      applyResult(data as RespuestaCheckIn);
    } catch {
      setErrorCode("unknown");
      setStatus("error");
    }
  };

  const submitting = status === "submitting";

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="p-6 space-y-4">
          <div className="flex flex-col items-center text-center gap-2">
            <div className="rounded-full bg-primary/10 p-3">
              <CalendarCheck className="h-7 w-7 text-primary" />
            </div>
            <h1 className="text-xl font-bold">
              {t("publicAttendance.title", { defaultValue: "Marcar asistencia" })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("publicAttendance.subtitle", {
                defaultValue: "Confirmá tu asistencia a esta clase.",
              })}
            </p>
          </div>

          {/* De qué curso y qué sesión. Solo aparece cuando el servidor lo
              manda, o sea cuando el check-in está realmente abierto. */}
          {info?.open && (info.course_name || info.session_title) && (
            <div className="rounded-md border bg-background p-3 space-y-2">
              {info.course_name && (
                <p className="text-sm font-semibold leading-tight text-center">
                  {encabezadoDeCurso(info.course_name, info.course_group)}
                </p>
              )}

              {/* Con un check-in de varias clases, el enlace apunta a UNA —la de
                  hoy— y el resto lo marca el servidor. Sin la lista el estudiante
                  marcaba creyendo que registraba una sola sesión y se enteraba
                  del resto DESPUÉS, o sea cuando ya decidió. Y el caso de uso es
                  justamente ese: el docente abre un código que cubre las clases
                  anteriores para que quien faltó las recupere.

                  La sesión de hoy NO se repite arriba: aparece una sola vez,
                  dentro de la lista y marcada. Antes salía dos veces —como
                  encabezado y otra vez en la lista— y nada la distinguía de las
                  que se están recuperando, que es la diferencia que importa. */}
              {(info.group_sessions?.length ?? 0) > 1 ? (
                <div className="rounded-md border border-primary/30 bg-primary/5 overflow-hidden">
                  <p className="px-2.5 py-1.5 text-2xs font-medium border-b border-primary/20">
                    {t("publicAttendance.groupCovers", { count: info.group_sessions!.length })}
                  </p>
                  <ul className="divide-y divide-primary/15">
                    {info.group_sessions!.map((x, i) => {
                      // Resumido, UNA línea por clase. Los títulos reales llegan
                      // a 140 caracteres y tres de esos seguidos son un muro de
                      // texto en un teléfono: el estudiante vino a marcar
                      // asistencia, no a leer el temario. El título entero queda
                      // en el `title=`, así que no se pierde nada.
                      // La fila de HOY lleva además la etiqueta, que se come
                      // parte de la línea: se le baja el tope para que el corte
                      // lo haga el helper en un borde de palabra y no el
                      // `truncate` a mitad de una. El 16 está MEDIDO en el
                      // navegador a 390 px: la caja del título pasa de 216 px
                      // sin etiqueta a 153 px con ella, y con el tope de 34 que
                      // había probado primero el CSS volvía a cortar.
                      const titulo = resumirTituloDeSesion(
                        x.title,
                        x.is_anchor ? TOPE_TITULO_SESION - 16 : TOPE_TITULO_SESION,
                      );
                      return (
                        <li key={i} className="flex items-baseline gap-2 px-2.5 py-1.5">
                          {/* La fecha en columna propia, angosta y con cifras de
                              ancho fijo: así las fechas quedan alineadas entre sí
                              y se barren de un vistazo. Corta ("8 sep") porque el
                              año es el mismo en todas y solo robaría lugar. */}
                          <span className="w-12 shrink-0 text-2xs tabular-nums text-muted-foreground">
                            {x.session_date ? formatDateOnlyShort(x.session_date) : ""}
                          </span>
                          {/* `truncate` es la red de seguridad del resumen: un
                              título sin espacios no se puede cortar por palabra. */}
                          <span
                            className="min-w-0 flex-1 truncate text-2xs leading-tight"
                            title={titulo?.completo}
                          >
                            {titulo?.corto ?? t("publicAttendance.sessionWithoutTitle")}
                          </span>
                          {x.is_anchor && (
                            <span className="shrink-0 rounded-sm bg-primary/15 px-1.5 py-0.5 text-3xs font-medium text-primary">
                              {t("publicAttendance.thisClass")}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <div className="text-center space-y-0.5">
                  {info.session_title && (
                    <p className="text-xs text-muted-foreground leading-tight">
                      {info.session_title}
                    </p>
                  )}
                  {info.session_date && (
                    <p className="text-2xs text-muted-foreground">
                      {formatDateOnly(info.session_date)}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* La ventana existe pero todavía no empezó: decirle a qué hora
              vuelva, no "está cerrado". Antes la página ignoraba por completo el
              estado que el servidor ya le mandaba. */}
          {info && !info.open && info.not_started && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-center">
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t("publicAttendance.notStartedYet", {
                  time: info.opens_at ? formatDateTime(info.opens_at) : "",
                })}
              </p>
            </div>
          )}

          {!session ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <XCircle className="h-8 w-8 text-destructive" />
              <p className="text-sm text-muted-foreground">
                {t("publicAttendance.noSession", {
                  defaultValue: "Enlace inválido. Escaneá de nuevo el QR de la clase.",
                })}
              </p>
            </div>
          ) : status === "success" ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-500" />
              <p className="font-medium">
                {yaEstaba
                  ? t("publicAttendance.alreadyMarked")
                  : t("publicAttendance.success", { defaultValue: "¡Asistencia registrada!" })}
              </p>
              {/* El estado importa: si el docente puso "tardanza", el alumno
                  tiene que verlo y no creer que quedó presente. */}
              {yaEstaba && estadoPrevio && estadoPrevio !== "presente" && (
                <p className="text-xs font-medium">
                  {t("publicAttendance.markedAs", {
                    status: t(`attendanceStatus.${estadoPrevio}`, { defaultValue: estadoPrevio }),
                  })}
                </p>
              )}
              {/* En qué OTRAS sesiones quedó. Se muestra en la pantalla y no en
                  un toast: esto se lee de pie, con el celular en la mano y la
                  clase empezando, y es lo único que le permite verificar que el
                  código cubrió lo que el docente dijo que cubría. */}
              {tambienEn.length > 0 && (
                <p className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs">
                  {t("publicAttendance.alsoMarkedIn", {
                    count: tambienEn.length,
                    // Resumidos: acá van varios títulos seguidos en UNA
                    // frase, así que el tope es más corto que en la lista.
                    sessions: tambienEn
                      .map((n) => resumirTituloDeSesion(n, TITULO_EN_FRASE)?.corto ?? n)
                      .join(", "),
                  })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t("publicAttendance.successHint", {
                  defaultValue: "Ya podés cerrar esta pantalla.",
                })}
              </p>
            </div>
          ) : loading ? (
            <div className="flex justify-center py-6">
              <Spinner size="md" />
            </div>
          ) : (
            <>
              {/* Código de la clase (prellenado desde el QR; editable si vino por link). */}
              <div className="space-y-1">
                <Label htmlFor="pa-code" required>
                  {t("publicAttendance.codeLabel", { defaultValue: "Código de la clase" })}
                </Label>
                <Input
                  id="pa-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\s+/g, ""))}
                  inputMode="numeric"
                  maxLength={7}
                  placeholder="000000"
                  className="tracking-widest text-center text-lg"
                />
              </div>

              {user ? (
                // Ya logueado → no pedimos credenciales.
                <>
                  <p className="text-xs text-muted-foreground text-center">
                    {t("publicAttendance.loggedInAs", {
                      defaultValue: "Sesión iniciada. Se marcará con tu cuenta.",
                    })}
                  </p>
                  <Button
                    className="w-full"
                    onClick={() => void checkInLoggedIn()}
                    disabled={submitting || !code.trim()}
                  >
                    {submitting ? (
                      <Spinner size="sm" className="mr-1" />
                    ) : (
                      <CalendarCheck className="h-4 w-4 mr-1" />
                    )}
                    {t("publicAttendance.markBtn", { defaultValue: "Marcar asistencia" })}
                  </Button>
                </>
              ) : (
                // No logueado → correo + contraseña (verificados server-side).
                <>
                  <div className="space-y-1">
                    <Label htmlFor="pa-email" required>
                      {t("publicAttendance.emailLabel", { defaultValue: "Correo institucional" })}
                    </Label>
                    <Input
                      id="pa-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="username"
                      placeholder={t("publicAttendance.emailPlaceholder", {
                        defaultValue: "tu.correo@institucion.edu",
                      })}
                    />
                  </div>
                  {soloCorreo === false && (
                    <div className="space-y-1">
                      <Label htmlFor="pa-pass" required>
                        {t("publicAttendance.passwordLabel", { defaultValue: "Contraseña" })}
                      </Label>
                      <PasswordInput
                        id="pa-pass"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void checkInPublic();
                        }}
                      />
                    </div>
                  )}
                  <Button
                    className="w-full"
                    onClick={() => void checkInPublic()}
                    disabled={submitting}
                  >
                    {submitting ? (
                      <Spinner size="sm" className="mr-1" />
                    ) : (
                      <LogIn className="h-4 w-4 mr-1" />
                    )}
                    {t("publicAttendance.markBtn", { defaultValue: "Marcar asistencia" })}
                  </Button>
                  <p className="text-2xs text-muted-foreground text-center">
                    {t("publicAttendance.credsHint", {
                      defaultValue:
                        "Usamos tu correo y contraseña solo para confirmar tu identidad. No se inicia sesión.",
                    })}
                  </p>
                </>
              )}

              {status === "error" &&
              errorCode === "requirement_pending" &&
              pendientes.length > 0 ? (
                // Se listan TODOS: informar de a uno obliga a resolver, reintentar y
                // descubrir el siguiente, de pie y con el docente esperando.
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-xs font-medium">
                    {t("publicAttendance.reqTitle", {
                      defaultValue: "Antes de marcar asistencia te falta:",
                    })}
                  </p>
                  <ul className="space-y-1">
                    {pendientes.map((r) => {
                      const url = enlacePublicoDeRequisito(r);
                      return (
                        <li key={`${r.kind}:${r.id}`} className="text-xs">
                          <span className="font-medium">{r.title}</span>
                          {url ? (
                            <>
                              {" — "}
                              <a href={url} className="underline text-primary">
                                {t("publicAttendance.reqOpen", { defaultValue: "abrir" })}
                              </a>
                            </>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="text-2xs text-muted-foreground">
                    {t("publicAttendance.reqAfter", {
                      defaultValue: "Cuando lo completes, volvé a marcar con el mismo código.",
                    })}
                  </p>
                </div>
              ) : status === "error" ? (
                <p className="text-xs text-destructive text-center">{errorText(t, errorCode)}</p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
