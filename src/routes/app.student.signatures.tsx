/**
 * Documentos que el estudiante tiene para firmar (y los que ya firmó).
 *
 * ── Por qué el documento se pide por RPC y no se lee de la tabla ──────
 * `generated_reports` es una tabla del DOCENTE: su policy de SELECT no tiene
 * rama de alumno matriculado. Sin `get_report_to_sign`, el estudiante vería
 * "tienes algo para firmar" y no podría abrirlo. Ese RPC devuelve SOLO el
 * informe que le pidieron a él.
 *
 * ── Por qué se muestra el documento antes de poder firmar ─────────────
 * El botón de firmar solo se habilita después de abrirlo. Firmar algo que no se
 * puede leer no es aceptar: es apretar un botón.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileSignature, PenLine } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageLoader } from "@/components/ui/loaders";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";

export const Route = createFileRoute("/app/student/signatures")({
  component: StudentSignatures,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Pendiente {
  report_id: string;
  signed_at: string | null;
  requested_at: string;
  template_name: string;
  course_name: string | null;
}

function StudentSignatures() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Pendiente[]>([]);
  const [abierto, setAbierto] = useState<{ id: string; html: string; nombre: string } | null>(null);
  const [firmando, setFirmando] = useState(false);
  const [intento, setIntento] = useState(0);

  const cargar = useCallback(async () => {
    if (!user) return;
    setCargando(true);
    setError(null);
    try {
      // La policy de SELECT de `report_signatures` ya acota a `user_id =
      // auth.uid()`, así que no hace falta filtrar acá — pero se filtra igual:
      // depender solo de la RLS para el alcance de una lista deja la pantalla a
      // merced de un cambio de policy.
      const { data, error: e } = await db
        .from("report_signatures")
        .select("report_id, signed_at, requested_at")
        .eq("user_id", user.id)
        .order("requested_at", { ascending: false });
      if (e) {
        setError(friendlyError(e));
        return;
      }
      const filas = (data ?? []) as Array<{
        report_id: string;
        signed_at: string | null;
        requested_at: string;
      }>;
      // El nombre del informe y del curso salen del RPC: la tabla de informes no
      // es legible por el alumno.
      const enriquecidos: Pendiente[] = [];
      for (const f of filas) {
        const { data: r } = await db.rpc("get_report_to_sign", { _report_id: f.report_id });
        const info = r as { template_name?: string; course_name?: string | null } | null;
        enriquecidos.push({
          ...f,
          template_name: info?.template_name ?? t("studentSignatures.untitled"),
          course_name: info?.course_name ?? null,
        });
      }
      setItems(enriquecidos);
    } finally {
      setCargando(false);
    }
    // `intento` no se usa en el cuerpo: es el nonce del patrón "Reintentar" que
    // el proyecto ya usa con `ErrorState`. Está en las deps a propósito, para
    // que bumpearlo vuelva a disparar la carga.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, t, intento]);

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

  const abrir = async (p: Pendiente) => {
    const { data, error: e } = await db.rpc("get_report_to_sign", { _report_id: p.report_id });
    const r = data as { ok?: boolean; html?: string; error?: string } | null;
    if (e || !r?.ok || typeof r.html !== "string") {
      toast.error(friendlyError(e, t("studentSignatures.errOpen")));
      return;
    }
    setAbierto({ id: p.report_id, html: r.html, nombre: p.template_name });
  };

  const firmar = async () => {
    if (!abierto || firmando) return;
    const ok = await confirm({
      title: t("studentSignatures.confirmTitle"),
      description: t("studentSignatures.confirmDesc"),
      confirmLabel: t("studentSignatures.confirmBtn"),
      tone: "warning",
    });
    if (!ok) return;
    setFirmando(true);
    try {
      const { data, error: e } = await db.rpc("sign_report", {
        _report_id: abierto.id,
        _user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      });
      const r = data as { ok?: boolean; error?: string } | null;
      if (e || !r?.ok) {
        toast.error(friendlyError(e, t("studentSignatures.errSign")));
        return;
      }
      toast.success(t("studentSignatures.signedOk"));
      setAbierto(null);
      setIntento((n) => n + 1);
    } finally {
      setFirmando(false);
    }
  };

  if (cargando) return <PageLoader />;
  if (error) {
    return (
      <ErrorState
        message={t("studentSignatures.errLoad")}
        hint={error}
        onRetry={() => setIntento((n) => n + 1)}
      />
    );
  }

  const pendientes = items.filter((i) => !i.signed_at);

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<FileSignature className="h-6 w-6" />}
        title={t("studentSignatures.title")}
        subtitle={t("studentSignatures.subtitle", { count: pendientes.length })}
      />

      {items.length === 0 ? (
        <EmptyState
          icon={FileSignature}
          title={t("studentSignatures.emptyTitle")}
          description={t("studentSignatures.emptyDesc")}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map((i) => (
            <Card key={i.report_id}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate" title={i.template_name}>
                      {i.template_name}
                    </p>
                    {i.course_name && (
                      <p className="text-xs text-muted-foreground truncate">{i.course_name}</p>
                    )}
                  </div>
                  {i.signed_at ? (
                    <Badge
                      variant="outline"
                      className="text-3xs shrink-0 text-emerald-600 dark:text-emerald-400"
                    >
                      {t("studentSignatures.badgeSigned")}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-3xs shrink-0">
                      {t("studentSignatures.badgePending")}
                    </Badge>
                  )}
                </div>
                <p className="text-2xs text-muted-foreground">
                  {i.signed_at
                    ? t("studentSignatures.signedOn", { date: formatDateTime(i.signed_at) })
                    : t("studentSignatures.requestedOn", { date: formatDateTime(i.requested_at) })}
                </p>
                <Button
                  size="sm"
                  variant={i.signed_at ? "outline" : "default"}
                  className="w-full"
                  onClick={() => void abrir(i)}
                >
                  {i.signed_at
                    ? t("studentSignatures.viewBtn")
                    : t("studentSignatures.reviewAndSignBtn")}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!abierto} onOpenChange={(o) => !o && setAbierto(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate">{abierto?.nombre}</DialogTitle>
          </DialogHeader>
          {/* El documento se pinta en un iframe con `sandbox` vacío: es HTML
              compuesto por una plantilla que un docente puede editar, así que no
              se le da acceso a scripts ni al origen de la app. */}
          <iframe
            title={abierto?.nombre ?? ""}
            sandbox=""
            srcDoc={abierto?.html ?? ""}
            className="w-full h-[60dvh] rounded-md border bg-white"
          />
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setAbierto(null)}>
              {t("common.close")}
            </Button>
            {abierto && !items.find((i) => i.report_id === abierto.id)?.signed_at && (
              <Button onClick={() => void firmar()} disabled={firmando}>
                {firmando ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <PenLine className="h-4 w-4 mr-1" />
                )}
                {t("studentSignatures.signBtn")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
