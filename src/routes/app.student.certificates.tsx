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
import { TableEmpty } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { Award, Download, Copy, ExternalLink, Hash } from "lucide-react";
import { formatDateLong } from "@/lib/format";
import { downloadCertificate, buildVerifyUrl } from "@/lib/certificate-pdf";

export const Route = createFileRoute("/app/student/certificates")({ component: StudentCertificates });

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
  issued_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  payload_hash: string;
}

function StudentCertificates() {
  const { user } = useAuth();
  const [items, setItems] = useState<CertificateRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await db
        .from("certificates")
        .select("*")
        .eq("user_id", user.id)
        .order("issued_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        toast.error(error.message);
      } else {
        setItems((data ?? []) as CertificateRow[]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  const handleDownload = async (cert: CertificateRow) => {
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
        issuedAt: cert.issued_at,
        payloadHash: cert.payload_hash,
        revokedAt: cert.revoked_at,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error generando PDF");
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
        backTo="/app"
        icon={<Award className="h-6 w-6 text-amber-500" />}
        title="Mis certificados"
        subtitle="Descarga el PDF firmado o comparte el link de verificación pública."
      />

      {loading ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <Spinner size="md" /> Cargando…
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <TableEmpty
              title="Aún no tienes certificados"
              description="Tu docente emite el certificado cuando apruebas el curso. Volverás a ver esta pantalla cuando esté disponible."
              icon={<Award className="h-8 w-8 text-muted-foreground" />}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {items.map((cert) => (
            <Card key={cert.id} className={cert.revoked_at ? "border-destructive/40 bg-destructive/5" : undefined}>
              <CardContent className="p-4 sm:p-5 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-base truncate">{cert.course_name}</h3>
                      {cert.revoked_at ? (
                        <Badge variant="destructive" className="text-[10px]">Revocado</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10">
                          Válido
                        </Badge>
                      )}
                      {cert.course_period && (
                        <Badge variant="secondary" className="text-[10px]">{cert.course_period}</Badge>
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
                  <Button
                    size="sm"
                    onClick={() => void handleDownload(cert)}
                    disabled={!!cert.revoked_at}
                  >
                    <Download className="h-3.5 w-3.5 mr-1" />
                    Descargar PDF
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
