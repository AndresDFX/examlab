/**
 * Enlace PÚBLICO de un documento: uno solo para compartir, y se firma con correo
 * y contraseña.
 *
 * ── En qué se diferencia de `/acuerdo/$token` ─────────────────────────
 * `/acuerdo/$token` lleva un token POR FIRMANTE: el enlace ES la credencial, así
 * que identifica a la persona sin pedirle nada — y quien lo tenga puede firmar en
 * su nombre. Eso está escrito de frente en la migración que lo creó.
 *
 * Esta pantalla es el intercambio inverso, y las dos coexisten a propósito. El
 * token es del DOCUMENTO, sirve para pegarlo una vez en el grupo del curso, y
 * **no identifica a nadie**: solo habilita LEER. Para firmar hay que iniciar
 * sesión con correo y contraseña.
 *
 * ── Por qué esto es MÁS fuerte y no más débil ─────────────────────────
 * Firmar sigue pasando por `sign_report`, el RPC autenticado de siempre, que
 * exige `auth.uid()` y que la persona esté entre las solicitudes de ESE informe.
 * O sea que no hay ningún camino de escritura nuevo — que es la parte que habría
 * sido peligrosa. Y como hay sesión de verdad, la firma queda registrada con
 * `signed_via='app'`: mejor evidencia que la del enlace personal.
 *
 * ── Iniciar sesión SIN sacar a nadie de la página ─────────────────────
 * El formulario autentica ahí mismo en vez de redirigir a `/auth`. Quien abre
 * esto llegó por un enlace de WhatsApp, probablemente en el teléfono: mandarlo a
 * otra pantalla y esperar que vuelva es donde se pierde la gente. Después de
 * entrar, la misma página resuelve si esa cuenta está entre los firmantes y le
 * marca SU renglón.
 *
 * ── Lo que se ve antes de entrar ──────────────────────────────────────
 * El documento COMPLETO, igual que el enlace por firmante: hay que poder leer
 * antes de aceptar. Un acuerdo de curso ES la lista del curso, y los nombres ya
 * están ahí. No se muestran correos, ni notas, ni quién falta por firmar (eso lo
 * dice la ranura en blanco).
 */
import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LogIn, ShieldCheck } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { SignableDocument } from "@/modules/reports/SignableDocument";
import { SignaturePadDialog } from "@/modules/reports/SignaturePadDialog";
import type { FirmaDeInforme } from "@/modules/reports/signature-slots";

export const Route = createFileRoute("/documento/$token")({
  component: DocumentoPublico,
  head: () => ({
    // Igual que /acuerdo/$token, /asistencia y /reto/$pin: un documento con
    // nombres de personas no tiene por qué quedar indexado.
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Documento {
  ok?: boolean;
  error?: string;
  report_id?: string;
  html?: string;
  template_name?: string;
  course_name?: string | null;
  firmas?: FirmaDeInforme[];
  pendientes?: number;
}

function DocumentoPublico() {
  const { token } = Route.useParams();
  const { t } = useTranslation();

  const [cargando, setCargando] = useState(true);
  const [doc, setDoc] = useState<Documento | null>(null);
  /** `null` = todavía no sabemos; `""` = con sesión pero NO es firmante. */
  const [miId, setMiId] = useState<string | null>(null);
  const [yaFirme, setYaFirme] = useState(false);
  const [correo, setCorreo] = useState("");
  const [clave, setClave] = useState("");
  const [entrando, setEntrando] = useState(false);
  const [firmando, setFirmando] = useState(false);
  const [lienzoAbierto, setLienzoAbierto] = useState(false);

  const cargarDocumento = useCallback(async () => {
    const { data } = await db.rpc("report_public_document", { p_token: token });
    return (data ?? null) as Documento | null;
  }, [token]);

  /**
   * Resuelve si la sesión actual está entre los firmantes de ESTE informe.
   *
   * Se pregunta al servidor (`get_report_to_sign`) en vez de buscar el id en la
   * lista de firmas que ya trae el documento: esa lista solo tiene las FIRMADAS,
   * así que a quien todavía no firmó —que es justamente quien viene a firmar— no
   * lo encontraría nunca.
   */
  const resolverFirmante = useCallback(async (reportId: string) => {
    const { data: sesion } = await supabase.auth.getSession();
    if (!sesion.session) return { id: null as string | null, firmado: false };
    const { data } = await db.rpc("get_report_to_sign", { _report_id: reportId });
    const r = data as { ok?: boolean; signer_id?: string; signed_at?: string | null } | null;
    if (!r?.ok) return { id: "", firmado: false };
    return { id: r.signer_id ?? "", firmado: !!r.signed_at };
  }, []);

  const recargar = useCallback(async () => {
    const d = await cargarDocumento();
    if (!d?.ok || !d.report_id) return d;
    const quien = await resolverFirmante(d.report_id);
    setMiId(quien.id);
    setYaFirme(quien.firmado);
    return d;
  }, [cargarDocumento, resolverFirmante]);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      const d = await recargar();
      if (cancelado) return;
      setDoc(d);
      setCargando(false);
    })();
    return () => {
      cancelado = true;
    };
  }, [recargar]);

  const entrar = async () => {
    if (entrando || !correo.trim() || !clave) return;
    setEntrando(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: correo.trim(),
        password: clave,
      });
      if (error) {
        toast.error(t("publicDocument.errLogin"));
        return;
      }
      setClave("");
      const d = await recargar();
      setDoc(d);
      // Se dice explícitamente cuando la cuenta entró pero no le corresponde
      // firmar: si no, el documento queda igual que antes y parece que no pasó
      // nada.
      const quien = d?.report_id ? await resolverFirmante(d.report_id) : { id: "", firmado: false };
      if (!quien.id) toast.error(t("publicDocument.notASigner"));
    } finally {
      setEntrando(false);
    }
  };

  const firmar = async (dibujo: string | null) => {
    if (firmando || !doc?.report_id) return;
    setFirmando(true);
    try {
      const { data, error } = await db.rpc("sign_report", {
        _report_id: doc.report_id,
        _user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        _drawing: dibujo,
      });
      const r = data as { ok?: boolean; already?: boolean } | null;
      if (error || !r?.ok) {
        toast.error(friendlyError(error, t("publicDocument.errSign")));
        return;
      }
      toast.success(r.already ? t("publicDocument.alreadySigned") : t("publicDocument.signedOk"));
      setLienzoAbierto(false);
      const d = await recargar();
      setDoc(d);
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

  if (!doc?.ok) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4 sm:p-8">
        <Card className="max-w-md">
          <CardContent className="p-6 space-y-2 text-center">
            <p className="font-semibold">{t("publicDocument.invalidTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("publicDocument.invalidBody")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const puedeFirmar = !!miId && !yaFirme;

  return (
    <div className="min-h-screen bg-muted/30 p-4 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{doc.template_name}</h1>
          {doc.course_name && (
            <p className="text-sm text-muted-foreground">{doc.course_name}</p>
          )}
        </div>

        {/* El estado de arriba, antes del documento: quien abre esto en el
            teléfono no debería tener que bajar tres páginas para saber si tiene
            algo que hacer. */}
        {!miId && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <p className="flex items-start gap-2 text-sm">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  {miId === "" ? t("publicDocument.notASigner") : t("publicDocument.loginToSign")}
                </span>
              </p>
              {miId === null && (
                <form
                  className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void entrar();
                  }}
                >
                  <div className="space-y-1">
                    <Label htmlFor="doc-correo" required>
                      {t("publicDocument.email")}
                    </Label>
                    <Input
                      id="doc-correo"
                      type="email"
                      autoComplete="username"
                      value={correo}
                      onChange={(e) => setCorreo(e.target.value)}
                      disabled={entrando}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="doc-clave" required>
                      {t("publicDocument.password")}
                    </Label>
                    <PasswordInput
                      id="doc-clave"
                      autoComplete="current-password"
                      value={clave}
                      onChange={(e) => setClave(e.target.value)}
                      disabled={entrando}
                    />
                  </div>
                  <Button type="submit" disabled={entrando || !correo.trim() || !clave}>
                    {entrando ? (
                      <Spinner size="sm" className="mr-1" />
                    ) : (
                      <LogIn className="mr-1 h-4 w-4" />
                    )}
                    {t("publicDocument.login")}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        )}

        {yaFirme && (
          <Card>
            <CardContent className="p-4">
              <p className="text-sm">{t("publicDocument.alreadySigned")}</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-0">
            <SignableDocument
              title={doc.template_name ?? ""}
              html={doc.html ?? ""}
              firmas={doc.firmas ?? []}
              firmanteId={puedeFirmar ? miId : null}
              onFirmar={puedeFirmar ? () => setLienzoAbierto(true) : null}
            />
          </CardContent>
        </Card>

        <p className="text-2xs text-muted-foreground">{t("publicDocument.footerNote")}</p>
      </div>

      <SignaturePadDialog
        open={lienzoAbierto}
        onOpenChange={setLienzoAbierto}
        firmando={firmando}
        onConfirmar={(dibujo) => void firmar(dibujo)}
      />
    </div>
  );
}
