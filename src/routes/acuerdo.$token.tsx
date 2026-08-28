/**
 * Firmar un documento por ENLACE, sin iniciar sesión.
 *
 * Ruta: `/acuerdo/<token>` — pública, fuera de `/app`, así que sin AppLayout ni
 * guard de auth. Pensada para el Acuerdo Pedagógico, pero sirve para cualquier
 * informe que el docente mande a firmar.
 *
 * ── El token identifica al firmante ───────────────────────────────────
 * Es un token POR SOLICITUD, no por documento: la fila que lo guarda es
 * (informe, persona), así que el enlace ya sabe quién es y no hay que pedirle
 * correo ni contraseña. Es como funcionan las plataformas de firma —un enlace
 * único por firmante— y el mismo patrón del token del calendario ICS que este
 * repo ya usa.
 *
 * Lo que eso cuesta: el enlace ES la credencial. Quien lo tenga puede firmar en
 * nombre de esa persona. Por eso la pantalla lo dice, el registro guarda que la
 * firma entró por enlace (`signed_via`), y la vía autenticada dentro de la app
 * sigue siendo la principal.
 *
 * ── Se muestra el documento COMPLETO antes de poder firmar ────────────
 * El botón aparece debajo del documento, no arriba. Firmar algo que no se leyó
 * no es aceptar: es apretar un botón.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, FileSignature, PenLine, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";
import { SignableDocument } from "@/modules/reports/SignableDocument";
import { SignaturePadDialog } from "@/modules/reports/SignaturePadDialog";
import type { FirmaDeInforme } from "@/modules/reports/signature-slots";

export const Route = createFileRoute("/acuerdo/$token")({
  component: FirmaPublica,
  head: () => ({
    // Igual que /asistencia y /reto/$pin: un documento con el nombre de una
    // persona no tiene por qué quedar indexado.
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Info {
  ok?: boolean;
  error?: string;
  html?: string;
  template_name?: string;
  course_name?: string | null;
  signer_name?: string | null;
  requested_at?: string;
  signed_at?: string | null;
  signed_via?: string | null;
  /** A quién corresponde ESTE enlace: identifica su ranura en el documento. */
  signer_id?: string | null;
  /** Firmas ya puestas, para dibujarlas dentro del documento. */
  firmas?: FirmaDeInforme[] | null;
}

function FirmaPublica() {
  const { t } = useTranslation();
  const { token } = Route.useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [cargando, setCargando] = useState(true);
  const [firmando, setFirmando] = useState(false);
  /**
   * La página es pública, pero al aviso de la campana se le puede haber hecho
   * clic desde dentro de la app. Sin esto, ese estudiante queda en una pantalla
   * sin salida: la ruta está fuera de `/app`, así que no hay barra lateral.
   *
   * Solo se muestra el enlace de vuelta si HAY sesión. A quien no tiene cuenta,
   * un botón que lo lleva a una pantalla de inicio de sesión no le sirve de
   * nada; lo confunde.
   */
  const [conSesion, setConSesion] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const { data } = await db.rpc("report_signature_public_info", { p_token: token });
      setInfo((data as Info | null) ?? { ok: false, error: "invalid_token" });
    } finally {
      setCargando(false);
    }
  }, [token]);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      if (cancelado) return;
      await cargar();
    })();
    return () => {
      cancelado = true;
    };
  }, [cargar]);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelado) return;
      setConSesion(!!data.session);
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  // El lienzo se abre al pulsar la ranura; firmar de verdad ocurre al confirmarlo.
  const [lienzoAbierto, setLienzoAbierto] = useState(false);

  const firmar = async (dibujo: string | null) => {
    if (firmando) return;
    setFirmando(true);
    try {
      const { data, error } = await db.rpc("sign_report_public", {
        p_token: token,
        p_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        p_drawing: dibujo,
      });
      const r = data as { ok?: boolean; error?: string; already?: boolean } | null;
      if (error || !r?.ok) {
        toast.error(friendlyError(error, t("publicSignature.errSign")));
        return;
      }
      toast.success(r.already ? t("publicSignature.alreadySigned") : t("publicSignature.signedOk"));
      setLienzoAbierto(false);
      await cargar();
    } finally {
      setFirmando(false);
    }
  };

  if (cargando) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30">
        <Spinner size="lg" />
      </div>
    );
  }

  // Token inválido, inexistente o de un curso en papelera: todos igual.
  if (!info?.ok) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="p-6 flex flex-col items-center gap-2 text-center">
            <XCircle className="h-8 w-8 text-destructive" />
            <p className="font-medium">{t("publicSignature.invalidTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("publicSignature.invalidHint")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const yaFirmado = !!info.signed_at;

  return (
    <div className="min-h-screen bg-muted/30 p-4">
      <div className="mx-auto max-w-4xl space-y-4">
        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2.5 shrink-0">
                <FileSignature className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-bold leading-tight">{info.template_name}</h1>
                {info.course_name && (
                  <p className="text-sm text-muted-foreground">{info.course_name}</p>
                )}
                {info.signer_name && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {/* "Para firmar: X" deja de ser cierto en cuanto se firma:
                        ahí el nombre pasa a ser quién firmó, no quién debe. */}
                    {t(yaFirmado ? "publicSignature.signedBy" : "publicSignature.forSigner", {
                      name: info.signer_name,
                    })}
                  </p>
                )}
              </div>
            </div>

            {yaFirmado ? (
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
                <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  {t("publicSignature.alreadySignedOn", {
                    date: formatDateTime(info.signed_at as string),
                  })}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("publicSignature.readFirst")}</p>
            )}
          </CardContent>
        </Card>

        {/* El documento, con las firmas puestas y —si todavía no firmó— el botón
            en SU renglón. El aislamiento y por qué el sandbox deja pasar
            `allow-same-origin` está explicado en `SignableDocument`. */}
        <Card>
          <CardContent className="p-0">
            <SignableDocument
              title={info.template_name ?? ""}
              html={info.html ?? ""}
              firmas={info.firmas ?? []}
              firmanteId={info.signer_id ?? null}
              onFirmar={yaFirmado || firmando ? null : () => setLienzoAbierto(true)}
              className="w-full h-[70dvh] rounded-md bg-white"
            />
          </CardContent>
        </Card>

        {!yaFirmado && (
          <Card>
            <CardContent className="p-5 space-y-3">
              {/* Se dice qué implica firmar Y que el enlace es la credencial: el
                  estudiante tiene que saber que no lo comparta. */}
              <p className="text-sm">{t("publicSignature.consent")}</p>
              <p className="text-2xs text-muted-foreground">{t("publicSignature.linkWarning")}</p>
              <Button className="w-full" onClick={() => setLienzoAbierto(true)} disabled={firmando}>
                {firmando ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <PenLine className="h-4 w-4 mr-1" />
                )}
                {t("publicSignature.signBtn")}
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col items-center gap-2 pb-4">
          {yaFirmado && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              {t("publicSignature.canClose")}
            </div>
          )}
          {conSesion && (
            <Link
              to="/app"
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              {t("publicSignature.backToApp")}
            </Link>
          )}
        </div>
      </div>
      <SignaturePadDialog
        open={lienzoAbierto}
        onOpenChange={setLienzoAbierto}
        onConfirmar={(dibujo) => void firmar(dibujo)}
        firmando={firmando}
        nombre={info.signer_name}
      />
    </div>
  );
}
