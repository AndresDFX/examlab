/**
 * Página pública de verificación de certificados.
 *
 * Ruta: /verify/<short_code>
 *
 * Accesible SIN autenticación — cualquiera con el QR puede confirmar
 * que el certificado existe, no fue revocado, y los datos coinciden.
 *
 * Llama al RPC público `verify_certificate(short_code)` que devuelve
 * solo el snapshot inmutable de datos (sin sensibles).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  GraduationCap,
  Calendar,
  User,
  School,
  Hash,
} from "lucide-react";
import { formatDateLong } from "@/shared/lib/format";
import { downloadCertificate } from "@/modules/certificates/certificate-pdf";

export const Route = createFileRoute("/verify/$shortCode")({
  head: ({ params }) => ({
    meta: [
      { title: `Verificación de certificado · ${params.shortCode}` },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: VerifyPage,
});

interface VerifyResult {
  exists_flag: boolean;
  is_revoked: boolean;
  short_code: string;
  student_full_name: string | null;
  course_name: string | null;
  course_period: string | null;
  final_grade: number | null;
  grade_scale_max: number | null;
  university_name: string | null;
  university_logo_url: string | null;
  teacher_names: string[] | null;
  issued_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  payload_hash: string | null;
}

function VerifyPage() {
  const { shortCode } = Route.useParams();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcErr } = await (supabase as any).rpc("verify_certificate", {
        _short_code: shortCode,
      });
      if (cancelled) return;
      if (rpcErr) {
        setError(rpcErr.message);
      } else {
        const row = Array.isArray(data) ? data[0] : data;
        setResult(row as VerifyResult);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [shortCode]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30 py-10 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 hover:opacity-80">
            <GraduationCap className="h-6 w-6 text-indigo-600" />
            <span className="font-semibold text-lg">ExamLab</span>
          </Link>
          <Badge variant="outline">Verificación pública</Badge>
        </header>

        {loading ? (
          <Card>
            <CardContent className="p-12 text-center text-muted-foreground">
              <Spinner size="md" inline className="mr-2" />
              Verificando código <code>{shortCode}</code>…
            </CardContent>
          </Card>
        ) : error ? (
          <Card className="border-destructive/50">
            <CardContent className="p-8 text-center space-y-2">
              <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
              <p className="text-sm text-muted-foreground">No se pudo consultar el certificado.</p>
              <p className="text-xs text-destructive">{error}</p>
            </CardContent>
          </Card>
        ) : !result?.exists_flag ? (
          <NotFoundCard shortCode={shortCode} />
        ) : result.is_revoked ? (
          <RevokedCard data={result} />
        ) : (
          <ValidCard data={result} />
        )}

        <footer className="text-center text-xs text-muted-foreground pt-4">
          La verificación consulta directamente la base de datos de ExamLab. Los datos mostrados
          provienen del snapshot inmutable del certificado al momento de su emisión.
        </footer>
      </div>
    </div>
  );
}

function NotFoundCard({ shortCode }: { shortCode: string }) {
  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardHeader className="text-center pb-3">
        <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
          <XCircle className="h-10 w-10 text-destructive" />
        </div>
        <CardTitle className="text-lg pt-2">Certificado no encontrado</CardTitle>
      </CardHeader>
      <CardContent className="text-center text-sm text-muted-foreground space-y-2">
        <p>
          No existe un certificado con el código{" "}
          <code className="font-mono text-foreground">{shortCode}</code>.
        </p>
        <p>
          Verifica que escribiste correctamente el código o que el QR es del certificado original.
        </p>
      </CardContent>
    </Card>
  );
}

function RevokedCard({ data }: { data: VerifyResult }) {
  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardHeader className="text-center pb-3">
        <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
          <XCircle className="h-10 w-10 text-destructive" />
        </div>
        <CardTitle className="text-lg pt-2">Certificado REVOCADO</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-center text-sm text-muted-foreground">
          Este certificado fue revocado por la institución y NO debe considerarse válido.
        </div>
        {data.revoke_reason && (
          <div className="rounded border border-destructive/30 bg-background p-3 text-sm">
            <span className="font-medium">Motivo: </span>
            {data.revoke_reason}
          </div>
        )}
        <SnapshotDetails data={data} />
        <div className="text-xs text-muted-foreground text-center pt-2">
          Revocado el {data.revoked_at ? formatDateLong(new Date(data.revoked_at)) : "—"}
        </div>
      </CardContent>
    </Card>
  );
}

function ValidCard({ data }: { data: VerifyResult }) {
  const handleDownload = async () => {
    if (!data.short_code || !data.student_full_name || !data.course_name) return;
    await downloadCertificate({
      shortCode: data.short_code,
      studentFullName: data.student_full_name,
      courseName: data.course_name,
      coursePeriod: data.course_period,
      finalGrade: Number(data.final_grade ?? 0),
      gradeScaleMax: Number(data.grade_scale_max ?? 5),
      teacherNames: data.teacher_names ?? [],
      universityName: data.university_name,
      universityLogoUrl: data.university_logo_url,
      issuedAt: data.issued_at ?? new Date().toISOString(),
      payloadHash: data.payload_hash ?? "",
      revokedAt: null,
    });
  };

  return (
    <Card className="border-emerald-500/40 bg-emerald-500/5">
      <CardHeader className="text-center pb-3">
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-600" />
        </div>
        <CardTitle className="text-lg pt-2 text-emerald-700 dark:text-emerald-400">
          Certificado válido
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <SnapshotDetails data={data} />
        <div className="flex flex-wrap gap-2 justify-end pt-2">
          <Button onClick={() => void handleDownload()} size="sm">
            Descargar PDF
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SnapshotDetails({ data }: { data: VerifyResult }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm pt-2">
      <Detail icon={User} label="Estudiante" value={data.student_full_name ?? "—"} />
      <Detail icon={School} label="Curso" value={data.course_name ?? "—"} />
      <Detail
        icon={GraduationCap}
        label="Nota final"
        value={
          data.final_grade != null
            ? `${Number(data.final_grade).toFixed(2)} / ${data.grade_scale_max ?? "—"}`
            : "—"
        }
      />
      <Detail
        icon={Calendar}
        label="Emitido"
        value={data.issued_at ? formatDateLong(new Date(data.issued_at)) : "—"}
      />
      {data.course_period && <Detail icon={Calendar} label="Periodo" value={data.course_period} />}
      {data.teacher_names && data.teacher_names.length > 0 && (
        <Detail
          icon={User}
          label={data.teacher_names.length === 1 ? "Docente" : "Docentes"}
          value={data.teacher_names.join(", ")}
        />
      )}
      {data.university_name && (
        <Detail icon={School} label="Institución" value={data.university_name} />
      )}
      <Detail
        icon={Hash}
        label="Código"
        value={<code className="font-mono">{data.short_code}</code>}
      />
    </div>
  );
}

function Detail({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 rounded border bg-background/60 p-2.5">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className="text-sm font-medium break-words">{value}</div>
      </div>
    </div>
  );
}
