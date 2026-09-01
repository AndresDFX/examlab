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
import { Eraser, PenLine, Users } from "lucide-react";
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
import { RowAction } from "@/components/ui/row-action";
import { useConfirm } from "@/shared/components/ConfirmDialog";

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
  /** Token del enlace PERSONAL de firma. Es la credencial de esa persona. */
  public_token: string | null;
}

export function SendToSignDialog({
  reportId,
  courseId,
  reportName,
  studentId = null,
  onOpenChange,
}: {
  /** `null` cierra el diálogo. */
  reportId: string | null;
  courseId: string | null;
  reportName: string;
  /**
   * De quién es el informe, cuando es POR ESTUDIANTE
   * (`generated_reports.student_id`). Con esto la lista muestra a esa persona y
   * no a los 93 matriculados: el documento habla de UNA sola, y ofrecer el curso
   * completo invita a mandarle a un estudiante el informe de otro.
   */
  studentId?: string | null;
  onOpenChange: (abierto: boolean) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [cargando, setCargando] = useState(false);
  /** Qué firma se está borrando, para deshabilitar solo esa fila. */
  const [borrando, setBorrando] = useState<string | null>(null);
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
        .select("user_id, signed_at, public_token")
        .eq("report_id", reportId);
      const mapa = new Map<string, Solicitud>();
      for (const f of (firmas ?? []) as Solicitud[]) mapa.set(f.user_id, f);
      // Informe de UN estudiante: se muestra solo a esa persona (y a quien ya
      // tuviera una solicitud, para no esconder algo que ya se pidió). Si ese
      // estudiante no está entre los matriculados —se retiró del curso— se deja
      // la lista completa antes que un diálogo vacío sin explicación.
      const acotada = studentId
        ? perfiles.filter((p) => p.id === studentId || mapa.has(p.id))
        : perfiles;
      const lista = acotada.length > 0 ? acotada : perfiles;
      setAlumnos(lista);
      setSolicitudes(mapa);
      // Se preseleccionan los que ya tienen solicitud, para que el diálogo
      // muestre el estado real en vez de arrancar en blanco y dar la impresión
      // de que no se le pidió a nadie. En un informe por estudiante, además,
      // arranca marcado el destinatario: es el único que puede firmarlo.
      const marcados = new Set(mapa.keys());
      if (studentId && lista.some((p) => p.id === studentId)) marcados.add(studentId);
      setElegidos(marcados);
    } finally {
      setCargando(false);
    }
  }, [reportId, courseId, studentId]);

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

  /**
   * Borra la firma de UNA persona y deja la solicitud pendiente.
   *
   * Se borra la FIRMA, no la solicitud: el caso real es "firmó por error" o
   * "firmó el equivocado", y hay que poder pedirle que lo haga de nuevo. Quitarlo
   * del documento dejaría a alguien fuera sin que nadie lo note.
   *
   * Tono `warning` y no `destructive`: se puede volver a firmar. Pero el aviso
   * dice el NOMBRE, porque borrarle la firma a la persona equivocada es
   * exactamente el error que hay que evitar.
   */
  const borrarFirma = async (userId: string, nombre: string) => {
    const ok = await confirm({
      title: t("reportSign.clearTitle", { name: nombre }),
      description: t("reportSign.clearBody"),
      confirmLabel: t("reportSign.clearConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    setBorrando(userId);
    try {
      const { data, error } = await db.rpc("teacher_clear_report_signature", {
        _report_id: reportId,
        _user_id: userId,
      });
      const r = data as { ok?: boolean; error?: string } | null;
      if (error || !r?.ok) {
        toast.error(friendlyError(error, t("reportSign.clearError")));
        return;
      }
      toast.success(t("reportSign.clearOk"));
      await cargar();
    } finally {
      setBorrando(null);
    }
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
                    {yaFirmo ? (
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <span className="text-2xs text-emerald-600 dark:text-emerald-400">
                          {t("reportSign.signedOn", {
                            date: formatDateTime(sol!.signed_at as string),
                          })}
                        </span>
                        {/* Borrar la firma vive acá y no en un menú aparte: es el
                            único lugar donde el docente ya está viendo QUIÉN firmó
                            y cuándo, que es lo que necesita para decidir. */}
                        <RowAction
                          label={t("reportSign.clearAction")}
                          icon={Eraser}
                          disabled={borrando === a.id}
                          onClick={() => void borrarFirma(a.id, a.nombre)}
                        />
                      </span>
                    ) : (
                      sol?.public_token && (
                        /* Enlace PERSONAL: identifica al firmante, así que es su
                           credencial. Se copia uno por uno a propósito — un botón
                           de "copiar todos" invita a pegarlos en un grupo, y ahí
                           cualquiera podría firmar por cualquiera. */
                        <button
                          type="button"
                          className="text-2xs text-muted-foreground hover:text-foreground underline underline-offset-2 whitespace-nowrap shrink-0"
                          onClick={(e) => {
                            e.preventDefault();
                            const url = `${window.location.origin}/acuerdo/${sol.public_token}`;
                            void navigator.clipboard
                              .writeText(url)
                              .then(() => toast.success(t("reportSign.linkCopied")))
                              .catch(() => toast.error(t("reportSign.linkCopyFailed")));
                          }}
                        >
                          {t("reportSign.copyLink")}
                        </button>
                      )
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
