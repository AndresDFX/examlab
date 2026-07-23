/**
 * Check-in de asistencia PÚBLICO — marcar asistencia SIN loguearse.
 *
 * Ruta: /asistencia?session=<uuid>&code=<6díg>   (pública, fuera de /app →
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
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { CheckCircle2, XCircle, CalendarCheck, LogIn } from "lucide-react";

export const Route = createFileRoute("/asistencia")({
  validateSearch: (s: Record<string, unknown>) => ({
    session: typeof s.session === "string" ? s.session : "",
    code: typeof s.code === "string" ? s.code : "",
  }),
  head: () => ({
    meta: [
      { title: "Asistencia · ExamLab" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: PublicAttendance,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Mapea el error del RPC a un mensaje claro para el alumno. */
function errorText(t: (k: string, o?: Record<string, unknown>) => string, code: string | null): string {
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
    case "check_in_closed":
      return t("publicAttendance.errClosed", {
        defaultValue: "El check-in de esta sesión está cerrado.",
      });
    case "session_not_found":
      return t("publicAttendance.errSession", {
        defaultValue: "La sesión no existe o fue eliminada.",
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

  useEffect(() => {
    setCode(codeFromUrl);
  }, [codeFromUrl]);

  const applyResult = (res: { ok?: boolean; error?: string } | null) => {
    if (res?.ok) {
      setStatus("success");
    } else {
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
    if (!cleanEmail || cleanEmail.indexOf("@") < 1 || !password || !code.trim()) {
      toast.error(
        t("publicAttendance.fillAll", {
          defaultValue: "Completá correo, contraseña y código.",
        }),
      );
      return;
    }
    setStatus("submitting");
    try {
      const { data, error } = await supabase.functions.invoke("public-attendance-check-in", {
        body: { email: cleanEmail, password, sessionId: session, code: code.trim() },
      });
      if (error) {
        setErrorCode("unknown");
        setStatus("error");
        return;
      }
      applyResult(data as { ok?: boolean; error?: string });
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
                {t("publicAttendance.success", { defaultValue: "¡Asistencia registrada!" })}
              </p>
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
                  <Button className="w-full" onClick={() => void checkInLoggedIn()} disabled={submitting || !code.trim()}>
                    {submitting ? <Spinner size="sm" className="mr-1" /> : <CalendarCheck className="h-4 w-4 mr-1" />}
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
                  <Button className="w-full" onClick={() => void checkInPublic()} disabled={submitting}>
                    {submitting ? <Spinner size="sm" className="mr-1" /> : <LogIn className="h-4 w-4 mr-1" />}
                    {t("publicAttendance.markBtn", { defaultValue: "Marcar asistencia" })}
                  </Button>
                  <p className="text-[11px] text-muted-foreground text-center">
                    {t("publicAttendance.credsHint", {
                      defaultValue:
                        "Usamos tu correo y contraseña solo para confirmar tu identidad. No se inicia sesión.",
                    })}
                  </p>
                </>
              )}

              {status === "error" && (
                <p className="text-xs text-destructive text-center">{errorText(t, errorCode)}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
