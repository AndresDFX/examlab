/**
 * Enviar un informe generado a firmar, a uno o a varios estudiantes del curso.
 *
 * ── Qué se firma ──────────────────────────────────────────────────────
 * El informe GENERADO, no la plantilla. `generated_reports.html` guarda el
 * documento tal como quedó al generarse: es lo único que hace que la firma
 * signifique algo, porque la plantilla se puede editar después y el estudiante
 * quedaría atado a un texto que nunca leyó.
 *
 * ── Por qué el estado de cada firma se lee de la base y no se asume ───
 * Al reabrir el diálogo se recargan las solicitudes existentes. Quien ya firmó
 * aparece con su fecha y NO se puede desmarcar: retirar una firma puesta sería
 * reescribir la historia del documento, y la policy de DELETE de la base
 * tampoco lo permite (solo borra pendientes). Lo que sí se puede es retirar una
 * solicitud que nadie firmó todavía.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PenLine, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { SectionLoader } from "@/components/ui/loaders";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Matriculado {
  id: string;
  nombre: string;
  email: string | null;
}

interface Solicitud {
  user_id: string;
  signed_at: string | null;
}

export function SendToSignDialog({
  reportId,
  courseId,
  reportName,
  onOpenChange,
}: {
  /** `null` cierra el diálogo. */
  reportId: string | null;
  courseId: string | null;
  reportName: string;
  onOpenChange: (abierto: boolean) => void;
}) {
  const { t } = useTranslation();
  const [cargando, setCargando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [alumnos, setAlumnos] = useState<Matriculado[]>([]);
  const [solicitudes, setSolicitudes] = useState<Map<string, Solicitud>>(new Map());
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());

  const cargar = useCallback(async () => {
    if (!reportId || !courseId) return;
    setCargando(true);
    try {
      const { data: matriculas, error: e1 } = await db
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", courseId);
      if (e1) {
        toast.error(friendlyError(e1));
        return;
      }
      const ids = (matriculas ?? []).map((m: { user_id: string }) => m.user_id);
      // Patrón 2-query: `course_enrollments.user_id` apunta a `auth.users`, así
      // que no se puede embeber `profiles` (el embed falla en silencio).
      let perfiles: Matriculado[] = [];
      if (ids.length > 0) {
        const { data: profs } = await db
          .from("profiles")
          .select("id, full_name, institutional_email")
          .in("id", ids);
        perfiles = (
          (profs ?? []) as Array<{
            id: string;
            full_name: string | null;
            institutional_email: string | null;
          }>
        )
          .map((p) => ({
            id: p.id,
            nombre: p.full_name ?? p.institutional_email ?? "—",
            email: p.institutional_email,
          }))
          .sort((a, b) => a.nombre.localeCompare(b.nombre, "es-CO"));
      }
      const { data: firmas } = await db
        .from("report_signatures")
        .select("user_id, signed_at")
        .eq("report_id", reportId);
      const mapa = new Map<string, Solicitud>();
      for (const f of (firmas ?? []) as Solicitud[]) mapa.set(f.user_id, f);
      setAlumnos(perfiles);
      setSolicitudes(mapa);
      // Se preseleccionan los que ya tienen solicitud, para que el diálogo
      // muestre el estado real en vez de arrancar en blanco y dar la impresión
      // de que no se le pidió a nadie.
      setElegidos(new Set(mapa.keys()));
    } finally {
      setCargando(false);
    }
  }, [reportId, courseId]);

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

  const alternar = (id: string) => {
    // Una firma puesta no se toca.
    if (solicitudes.get(id)?.signed_at) return;
    setElegidos((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  };

  const firmados = alumnos.filter((a) => solicitudes.get(a.id)?.signed_at).length;
  const pendientes = alumnos.filter(
    (a) => solicitudes.has(a.id) && !solicitudes.get(a.id)?.signed_at,
  ).length;

  const enviar = async () => {
    if (!reportId || enviando) return;
    // Solo los NUEVOS: pedir de nuevo a quien ya tiene solicitud no hace nada
    // (la RPC lo omite por el UNIQUE) pero mandarlos igual haría que el
    // resultado diga "0 enviadas" y parezca un fallo.
    const nuevos = [...elegidos].filter((id) => !solicitudes.has(id));
    const retirados = alumnos
      .filter((a) => solicitudes.has(a.id) && !solicitudes.get(a.id)?.signed_at)
      .filter((a) => !elegidos.has(a.id))
      .map((a) => a.id);

    if (nuevos.length === 0 && retirados.length === 0) {
      toast.info(t("reportSign.nothingToDo"));
      return;
    }
    setEnviando(true);
    try {
      if (retirados.length > 0) {
        const { error } = await db
          .from("report_signatures")
          .delete()
          .eq("report_id", reportId)
          .in("user_id", retirados)
          .is("signed_at", null);
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
      }
      if (nuevos.length > 0) {
        const { data, error } = await db.rpc("request_report_signatures", {
          _report_id: reportId,
          _user_ids: nuevos,
        });
        const r = data as { ok?: boolean; requested?: number; error?: string } | null;
        if (error || !r?.ok) {
          toast.error(friendlyError(error, t("reportSign.errRequest")));
          return;
        }
        toast.success(t("reportSign.requestedOk", { count: r.requested ?? nuevos.length }));
      } else {
        toast.success(t("reportSign.withdrawnOk", { count: retirados.length }));
      }
      await cargar();
    } catch (e) {
      toast.error(friendlyError(e, t("reportSign.errRequest")));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={!!reportId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="h-4 w-4" />
            {t("reportSign.dialogTitle")}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {t("reportSign.dialogHint", { name: reportName })}
        </p>

        {cargando ? (
          <SectionLoader />
        ) : alumnos.length === 0 ? (
          <EmptyState icon={Users} title={t("reportSign.noStudents")} />
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="text-3xs">
                {t("reportSign.signedCount", { count: firmados })}
              </Badge>
              <Badge variant="outline" className="text-3xs">
                {t("reportSign.pendingCount", { count: pendientes })}
              </Badge>
            </div>
            <div className="max-h-[45dvh] overflow-y-auto space-y-1 rounded-md border p-2">
              {alumnos.map((a) => {
                const sol = solicitudes.get(a.id);
                const yaFirmo = !!sol?.signed_at;
                return (
                  <label
                    key={a.id}
                    className={`flex items-center gap-2 rounded p-1.5 text-sm ${
                      yaFirmo ? "opacity-70" : "cursor-pointer hover:bg-accent"
                    }`}
                  >
                    <Checkbox
                      checked={elegidos.has(a.id)}
                      disabled={yaFirmo}
                      onCheckedChange={() => alternar(a.id)}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate">{a.nombre}</span>
                      {a.email && (
                        <span className="block truncate text-2xs text-muted-foreground">
                          {a.email}
                        </span>
                      )}
                    </span>
                    {yaFirmo && (
                      <span className="text-2xs text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                        {t("reportSign.signedOn", {
                          date: formatDateTime(sol!.signed_at as string),
                        })}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button onClick={() => void enviar()} disabled={enviando || cargando}>
            {enviando ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <PenLine className="h-4 w-4 mr-1" />
            )}
            {t("reportSign.sendBtn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
