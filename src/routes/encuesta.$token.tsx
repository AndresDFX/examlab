/**
 * Encuesta PÚBLICA — responder por enlace, sin iniciar sesión.
 *
 * Ruta: /encuesta/<token>   (pública, fuera de /app → sin AppLayout ni guard de
 * auth, igual que `reto/$pin` y `verify/$shortCode`).
 *
 * Dos pasos, en ese orden y por pedido explícito:
 *   1) Con el enlace solo se ve el TÍTULO y la descripción (`poll_public_info`).
 *      Las preguntas no se muestran todavía: el enunciado no queda expuesto a
 *      quien apenas tiene el enlace.
 *   2) El visitante escribe su correo institucional. `poll_public_open` valida
 *      que ese correo esté MATRICULADO en un curso de la encuesta y devuelve
 *      las preguntas + un id de sesión.
 *
 * ── Por qué se envía TODO junto al final ──────────────────────────────
 * El camino público es de SOLO ALTA (`poll_public_answer` no modifica una
 * respuesta que ya existe, ver mig 20261700000000): con identidad por correo
 * —adivinable— un UPSERT dejaría que un tercero pise las respuestas de un
 * compañero. Como no hay modificación, guardar pregunta por pregunta trabaría
 * cada una en el primer toque; así que el formulario se llena completo y se
 * manda una vez, que además es como funciona cualquier formulario público.
 *
 * ── Lo que este flujo NO hace, a propósito ────────────────────────────
 * No devuelve las respuestas ya guardadas (solo si la pregunta está respondida
 * o no), no muestra resultados, no dice cuántos respondieron, y no nombra el
 * curso ni la institución. Toda la autorización vive en el cuerpo de los RPC:
 * el GRANT no alcanza como frontera porque en este proyecto `anon` ya tiene
 * EXECUTE sobre casi todas las funciones SECURITY DEFINER.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { CheckCircle2, CheckSquare, GraduationCap, Mail, Square } from "lucide-react";

export const Route = createFileRoute("/encuesta/$token")({
  head: () => ({
    meta: [
      { title: "Encuesta · ExamLab" },
      // Sin esto el enunciado completo termina indexado por los buscadores.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: EncuestaPublica,
});

interface PreguntaPublica {
  id: string;
  position: number;
  type: "abierta" | "cerrada";
  text: string;
  options: { choices?: string[] } | null;
  required: boolean;
  max_chars: number | null;
  multi: boolean;
  ya_respondida: boolean;
}

function EncuestaPublica() {
  const { token } = Route.useParams();
  const { t } = useTranslation();

  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [info, setInfo] = useState<{ title: string; description: string | null } | null>(null);

  const [email, setEmail] = useState("");
  const [abriendo, setAbriendo] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [preguntas, setPreguntas] = useState<PreguntaPublica[]>([]);

  const [textos, setTextos] = useState<Record<string, string>>({});
  const [unica, setUnica] = useState<Record<string, number | null>>({});
  const [varias, setVarias] = useState<Record<string, number[]>>({});
  const [enviando, setEnviando] = useState(false);
  const [listo, setListo] = useState(false);

  // Paso 1: qué encuesta es. Guard `cancelled` porque el visitante puede cerrar
  // antes de que resuelva (convención del proyecto).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      const { data, error } = await db.rpc("poll_public_info", { _token: token });
      if (cancelled) return;
      if (error) {
        setErrorCarga(friendlyError(error));
      } else {
        setInfo({ title: data?.title ?? "", description: data?.description ?? null });
      }
      setCargando(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const abrirConCorreo = async () => {
    if (!email.trim() || abriendo) return;
    setAbriendo(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      const { data, error } = await db.rpc("poll_public_open", {
        _token: token,
        _email: email.trim(),
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      const qs = (data?.questions ?? []) as PreguntaPublica[];
      setPreguntas(qs);
      setSessionId(data?.session_id ?? null);
      // Si TODAS ya estaban respondidas, no tiene nada que hacer acá.
      if (qs.length > 0 && qs.every((q) => q.ya_respondida)) setListo(true);
    } finally {
      setAbriendo(false);
    }
  };

  // Al recargar la página se vuelve a pedir el correo. Es deliberado y NO se
  // persiste el id de sesión: guardarlo no evitaría el paso, porque las
  // preguntas solo las devuelve `poll_public_open` — la sesión no es una
  // credencial de lectura. Un localStorage acá sería código que promete
  // reanudar y no reanuda.
  const necesitaCorreo = !preguntas.length && !listo;

  const pendientes = useMemo(() => preguntas.filter((q) => !q.ya_respondida), [preguntas]);

  const faltanObligatorias = useMemo(
    () =>
      pendientes.filter((q) => {
        if (!q.required) return false;
        if (q.type === "abierta") return !(textos[q.id] ?? "").trim();
        return q.multi ? !(varias[q.id]?.length ?? 0) : unica[q.id] == null;
      }),
    [pendientes, textos, unica, varias],
  );

  const enviar = async () => {
    if (!sessionId || enviando) return;
    if (faltanObligatorias.length) {
      toast.error(
        t("publicPoll.missingRequired", {
          defaultValue: "Faltan {{count}} pregunta(s) obligatoria(s).",
          count: faltanObligatorias.length,
        }),
      );
      return;
    }
    setEnviando(true);
    let ok = 0;
    let primerError: string | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      for (const q of pendientes) {
        const payload: Record<string, unknown> = {
          _session_id: sessionId,
          _question_id: q.id,
        };
        if (q.type === "abierta") {
          const v = (textos[q.id] ?? "").trim();
          if (!v) continue; // opcional sin responder
          payload._answer_text = v;
        } else if (q.multi) {
          const v = varias[q.id] ?? [];
          if (!v.length) continue;
          payload._selected_indexes = v;
        } else {
          const v = unica[q.id];
          if (v == null) continue;
          payload._selected_index = v;
        }
        const { error } = await db.rpc("poll_public_answer", payload);
        if (error) {
          // Convención de bulk del proyecto: mostrar el PRIMER error real, no
          // solo "N con error".
          if (!primerError) primerError = `"${q.text.slice(0, 40)}" — ${friendlyError(error)}`;
        } else {
          ok += 1;
        }
      }
      if (primerError) {
        toast.error(
          t("publicPoll.partial", {
            defaultValue: "Se guardaron {{ok}}. Primer problema: {{err}}",
            ok,
            err: primerError,
          }),
          { duration: 12000 },
        );
        return;
      }
      setListo(true);
    } finally {
      setEnviando(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────
  // Esta ruta vive FUERA del shell, así que pone su propio padding.
  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <div className="flex items-center gap-2 font-semibold">
          <GraduationCap className="h-5 w-5 text-primary" />
          ExamLab
        </div>
        {children}
      </div>
    </div>
  );

  if (cargando) {
    return shell(
      <Card>
        <CardContent className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
          <Spinner size="md" />
          {t("common.loading", { defaultValue: "Cargando…" })}
        </CardContent>
      </Card>,
    );
  }

  if (errorCarga || !info) {
    return shell(
      // El mensaje del servidor YA es texto para el visitante (los rechazos van
      // con ERRCODE P0001, que `friendlyError` deja pasar tal cual), así que se
      // usa como título. Sin esto salía dos veces: una como título y otra como
      // pista, porque son el mismo texto.
      <ErrorState
        message={
          errorCarga ??
          t("publicPoll.unavailable", { defaultValue: "Este enlace no está disponible" })
        }
      />,
    );
  }

  if (listo) {
    return shell(
      <Card>
        <CardContent className="space-y-2 p-6 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
          <p className="text-lg font-semibold">
            {t("publicPoll.done", { defaultValue: "¡Listo, gracias!" })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("publicPoll.doneHint", {
              defaultValue: "Tus respuestas quedaron registradas. Ya puedes cerrar esta página.",
            })}
          </p>
        </CardContent>
      </Card>,
    );
  }

  return shell(
    <>
      <Card>
        <CardContent className="space-y-1 p-4 sm:p-6">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{info.title}</h1>
          {info.description && (
            <p className="text-sm leading-relaxed text-muted-foreground">{info.description}</p>
          )}
        </CardContent>
      </Card>

      {necesitaCorreo ? (
        <Card>
          <CardContent className="space-y-3 p-4 sm:p-6">
            <div className="space-y-1.5">
              <Label htmlFor="pp-email" required>
                {t("publicPoll.emailLabel", { defaultValue: "Tu correo institucional" })}
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="pp-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  className="pl-9"
                  placeholder="usuario@institucion.edu.co"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void abrirConCorreo();
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("publicPoll.emailHint", {
                  defaultValue:
                    "Con tu correo confirmamos que estás en el curso. No necesitas contraseña.",
                })}
              </p>
            </div>
            <Button className="w-full" onClick={() => void abrirConCorreo()} disabled={abriendo}>
              {abriendo && <Spinner size="sm" className="mr-2" />}
              {t("publicPoll.continue", { defaultValue: "Continuar" })}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {preguntas.map((q, i) => {
            const choices = q.options?.choices ?? [];
            return (
              <Card key={q.id}>
                <CardContent className="space-y-2 p-4 sm:p-6">
                  <p className="text-sm font-medium">
                    {i + 1}. {q.text}
                    {q.required && !q.ya_respondida && (
                      <span className="ml-0.5 text-destructive">*</span>
                    )}
                  </p>

                  {q.ya_respondida ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t("publicPoll.alreadyAnswered", {
                        defaultValue: "Ya respondiste esta pregunta.",
                      })}
                    </p>
                  ) : q.type === "abierta" ? (
                    <Textarea
                      rows={3}
                      maxLength={q.max_chars ?? undefined}
                      value={textos[q.id] ?? ""}
                      onChange={(e) => setTextos((p) => ({ ...p, [q.id]: e.target.value }))}
                      placeholder={t("publicPoll.openPlaceholder", {
                        defaultValue: "Escribe tu respuesta…",
                      })}
                    />
                  ) : q.multi ? (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">
                        {t("publicPoll.multiHint", {
                          defaultValue: "Puedes marcar varias opciones.",
                        })}
                      </p>
                      {choices.map((choice, ci) => {
                        const marcada = (varias[q.id] ?? []).includes(ci);
                        return (
                          <Button
                            key={ci}
                            type="button"
                            variant={marcada ? "default" : "outline"}
                            className="h-auto w-full justify-start py-2"
                            aria-pressed={marcada}
                            onClick={() =>
                              setVarias((p) => {
                                const act = p[q.id] ?? [];
                                return {
                                  ...p,
                                  [q.id]: act.includes(ci)
                                    ? act.filter((x) => x !== ci)
                                    : [...act, ci].sort((a, b) => a - b),
                                };
                              })
                            }
                          >
                            <span className="flex items-center gap-2 truncate text-sm">
                              {marcada ? (
                                <CheckSquare className="h-3.5 w-3.5" />
                              ) : (
                                <Square className="h-3.5 w-3.5 opacity-50" />
                              )}
                              {choice}
                            </span>
                          </Button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {choices.map((choice, ci) => (
                        <Button
                          key={ci}
                          type="button"
                          variant={unica[q.id] === ci ? "default" : "outline"}
                          className="h-auto w-full justify-start py-2"
                          aria-pressed={unica[q.id] === ci}
                          onClick={() => setUnica((p) => ({ ...p, [q.id]: ci }))}
                        >
                          <span className="truncate text-sm">{choice}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}

          <Card>
            <CardContent className="space-y-2 p-4 sm:p-6">
              <Button className="w-full" onClick={() => void enviar()} disabled={enviando}>
                {enviando && <Spinner size="sm" className="mr-2" />}
                {t("publicPoll.submit", { defaultValue: "Enviar respuestas" })}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t("publicPoll.submitHint", {
                  defaultValue:
                    "Se envía todo junto y no se puede modificar después. Revisa antes de enviar.",
                })}
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </>,
  );
}
