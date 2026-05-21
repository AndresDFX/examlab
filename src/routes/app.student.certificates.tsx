/**
 * Vista estudiante: "Mis certificados".
 * Lista los certificados emitidos al usuario, permite descargar el PDF
 * y compartir el link público de verificación.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { Award, Download, Copy, ExternalLink, Hash, Lock } from "lucide-react";
import { formatDateLong, formatDateOnly } from "@/shared/lib/format";
import { downloadCertificate, buildVerifyUrl } from "@/modules/certificates/certificate-pdf";
import { friendlyError } from "@/shared/lib/db-errors";

export const Route = createFileRoute("/app/student/certificates")({
  component: StudentCertificates,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface CertificateRow {
  id: string;
  short_code: string;
  student_full_name: string;
  student_identification: string | null;
  course_name: string;
  course_period: string | null;
  final_grade: number;
  grade_scale_max: number;
  teacher_names: string[];
  university_name: string | null;
  university_logo_url: string | null;
  certificate_message: string | null;
  signature_name: string | null;
  signature_title: string | null;
  signature_image_url: string | null;
  footer_text: string | null;
  issued_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  payload_hash: string;
  // Join con courses para chequear la fecha de fin. El estudiante solo
  // puede descargar el PDF a partir del end_date del curso — antes
  // alguien podía descargar el certificado en mitad del curso si el
  // docente lo emitía por adelantado. Esto NO bloquea el link público
  // de verificación (siempre activo) ni a docente/admin.
  course?: { end_date: string | null } | null;
}

function StudentCertificates() {
  const { user } = useAuth();
  const [items, setItems] = useState<CertificateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await db
        .from("certificates")
        .select("*, course:courses(end_date)")
        .eq("user_id", user.id)
        .order("issued_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        setLoadError(friendlyError(error, "No pudimos cargar tus certificados."));
      } else {
        setItems((data ?? []) as CertificateRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  /** Helper: determina si el certificado ya está disponible para
   *  descarga del estudiante. Bloqueado mientras la fecha fin del curso
   *  sea posterior a hoy. Si el cert NO tiene join con curso (datos
   *  legacy o curso sin end_date configurado), permitimos descarga
   *  por compatibilidad — no penalizamos al estudiante por config
   *  faltante del docente.
   *
   *  Anclamos a 12:00 local para evitar el bug UTC -1 día con `DATE`
   *  sin TZ — mismo patrón que `formatDateOnly`. */
  const isUnlocked = (cert: CertificateRow): boolean => {
    const endDate = cert.course?.end_date;
    if (!endDate) return true;
    const unlockMs = new Date(endDate + "T12:00:00").getTime();
    return Date.now() >= unlockMs;
  };

  const handleDownload = async (cert: CertificateRow) => {
    if (!isUnlocked(cert)) {
      toast.error(
        `Aún no puedes descargar este certificado. Estará disponible desde el ${formatDateOnly(cert.course!.end_date!)}.`,
      );
      return;
    }
    try {
      await downloadCertificate({
        shortCode: cert.short_code,
        studentFullName: cert.student_full_name,
        studentIdentification: cert.student_identification,
        courseName: cert.course_name,
        coursePeriod: cert.course_period,
        finalGrade: Number(cert.final_grade),
        gradeScaleMax: Number(cert.grade_scale_max),
        teacherNames: cert.teacher_names,
        universityName: cert.university_name,
        universityLogoUrl: cert.university_logo_url,
        certificateMessage: cert.certificate_message,
        signatureName: cert.signature_name,
        signatureTitle: cert.signature_title,
        signatureImageUrl: cert.signature_image_url,
        footerText: cert.footer_text,
        issuedAt: cert.issued_at,
        payloadHash: cert.payload_hash,
        revokedAt: cert.revoked_at,
      });
    } catch (e) {
      toast.error(friendlyError(e, "Error generando PDF"));
    }
  };

  const handleCopyLink = (cert: CertificateRow) => {
    const url = buildVerifyUrl(cert.short_code);
    void navigator.clipboard.writeText(url);
    toast.success("Link de verificación copiado");
  };

  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        icon={<Award className="h-6 w-6 text-amber-500" />}
        title="Certificaciones"
        subtitle="Descarga el PDF firmado o comparte el link de verificación pública."
      />

      {loading ? (
        <Card>
          <CardContent className="p-4 sm:p-8 text-center text-muted-foreground">
            <Spinner size="md" /> Cargando…
          </CardContent>
        </Card>
      ) : loadError ? (
        <ErrorState
          message="No pudimos cargar tus certificados"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <TableEmpty
              title="Aún no tienes certificados"
              description="Tu docente emite el certificado cuando apruebas el curso. Volverás a ver esta pantalla cuando esté disponible."
              icon={Award}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {items.map((cert) => (
            <Card
              key={cert.id}
              className={cert.revoked_at ? "border-destructive/40 bg-destructive/5" : undefined}
            >
              <CardContent className="p-4 sm:p-5 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-base truncate">{cert.course_name}</h3>
                      {cert.revoked_at ? (
                        <Badge variant="destructive" className="text-[10px]">
                          Revocado
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
                        >
                          Válido
                        </Badge>
                      )}
                      {cert.course_period && (
                        <Badge variant="secondary" className="text-[10px]">
                          {cert.course_period}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                      <Hash className="h-3 w-3" />
                      <code className="font-mono">{cert.short_code}</code>
                      <span className="mx-1">·</span>
                      <span>Emitido el {formatDateLong(new Date(cert.issued_at))}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-2xl font-bold tabular-nums">
                      {Number(cert.final_grade).toFixed(2)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      / {cert.grade_scale_max}
                    </div>
                  </div>
                </div>

                {cert.revoked_at && cert.revoke_reason && (
                  <div className="text-xs rounded border border-destructive/30 bg-background p-2.5">
                    <span className="font-medium">Motivo: </span>
                    {cert.revoke_reason}
                  </div>
                )}

                {/* Aviso de bloqueo previo a end_date — solo si no está
                    revocado (revocado tiene prioridad visual). El link
                    público y "Copiar link" siguen activos para que el
                    docente/empleador pueda verificar el cert antes de
                    que el estudiante pueda descargarlo. */}
                {!cert.revoked_at && !isUnlocked(cert) && cert.course?.end_date && (
                  <div className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 px-3 py-2 text-xs">
                    <Lock className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0" />
                    <span className="text-amber-900 dark:text-amber-200">
                      Disponible para descarga desde el{" "}
                      <strong>{formatDateOnly(cert.course.end_date)}</strong> (fin del curso).
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 justify-end pt-1">
                  <Button size="sm" variant="outline" onClick={() => handleCopyLink(cert)}>
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    Copiar link de verificación
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <a
                      href={buildVerifyUrl(cert.short_code)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-1" />
                      Abrir verificación
                    </a>
                  </Button>
                  {(() => {
                    const unlocked = isUnlocked(cert);
                    const disabled = !!cert.revoked_at || !unlocked;
                    const lockedTooltip =
                      !cert.revoked_at && !unlocked && cert.course?.end_date
                        ? `Disponible desde el ${formatDateOnly(cert.course.end_date)}`
                        : undefined;
                    return (
                      <Button
                        size="sm"
                        onClick={() => void handleDownload(cert)}
                        disabled={disabled}
                        title={lockedTooltip}
                      >
                        {!unlocked && !cert.revoked_at ? (
                          <Lock className="h-3.5 w-3.5 mr-1" />
                        ) : (
                          <Download className="h-3.5 w-3.5 mr-1" />
                        )}
                        Descargar PDF
                      </Button>
                    );
                  })()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
