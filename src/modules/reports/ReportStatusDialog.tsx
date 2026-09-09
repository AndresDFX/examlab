/**
 * Estado del documento: el informe generado tal como se ve, con la lista de
 * quién firmó y quién falta al lado.
 *
 * ── Por qué existe, teniendo el diálogo de «Enviar a firmar» ───────────
 * Ese diálogo es de ESCRITURA: sus casillas modelan el estado deseado, así que
 * desmarcar una RETIRA la solicitud y con ella el enlace personal que la persona
 * ya recibió. Mirar quién firmó no puede pasar por una pantalla donde el clic
 * equivocado destruye. Acá no hay una sola acción destructiva: el único primario
 * salta al diálogo de escritura, que sigue siendo el que escribe.
 *
 * Hasta ahora, para saber si faltaban firmas había dos caminos y los dos malos:
 * abrir el diálogo de escritura, o bajar el Word. Y para VER el documento, el
 * único era publicar su enlace público — o sea provocar un efecto secundario
 * (volverlo legible por cualquiera que tenga el enlace) para poder mirarlo.
 *
 * ── Solo lectura, y por eso se puede ordenar por estado ────────────────
 * `SendToSignDialog` ordena por nombre porque una fila que salta de lugar al
 * firmar alguien haría que el clic siguiente caiga sobre otra persona. Acá las
 * filas no tienen casillas, así que van primero las que el docente vino a
 * buscar: a quién no se le pidió, quién falta, y al final quién ya firmó.
 *
 * ── El documento se reusa TAL CUAL ─────────────────────────────────────
 * `SignableDocument` sin `onFirmar` ya es su modo de lectura (no dibuja el botón
 * de firmar y pasa `firmanteId: null` al renderizador), así que enfocar una fila
 * NO cambia el `srcDoc` y el iframe no se recarga: solo corre el `scrollIntoView`
 * de su `onLoad`. No hace falta tocar ese componente ni su sandbox.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileSearch, PenLine } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SectionLoader } from "@/components/ui/loaders";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";
import { SignableDocument } from "./SignableDocument";
import {
  codigoVerificacion,
  tieneRanuras,
  uidsDeRanuras,
  type FirmaDeInforme,
} from "./signature-slots";
import {
  filasDeFirmantes,
  hashDivergente,
  loteDeSolicitud,
  resumirFirmas,
  type FilaFirmante,
} from "./estado-firmas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/**
 * Lo que el diálogo necesita del informe. Se declara acá y no se importa el tipo
 * de la ruta para que el componente no dependa de ella.
 */
export interface InformeParaEstado {
  id: string;
  template_name: string;
  course_id: string | null;
  course_name: string | null;
  student_name: string | null;
  created_at: string;
  html: string;
}

/** Todas las solicitudes del informe, firmadas y pendientes. */
interface SolicitudCruda {
  user_id: string;
  signed_at: string | null;
  requested_at: string | null;
  signed_via: string | null;
  signed_hash: string | null;
}

export function ReportStatusDialog({
  informe,
  onOpenChange,
  onEnviarAFirmar,
}: {
  /** `null` cierra el diálogo. */
  informe: InformeParaEstado | null;
  onOpenChange: (abierto: boolean) => void;
  /** Salto al diálogo de escritura. Sin curso no hay a quién pedirle la firma. */
  onEnviarAFirmar?: (r: InformeParaEstado) => void;
}) {
  const { t } = useTranslation();
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [solicitudes, setSolicitudes] = useState<SolicitudCruda[]>([]);
  const [firmadas, setFirmadas] = useState<FirmaDeInforme[]>([]);
  const [filas, setFilas] = useState<FilaFirmante[]>([]);
  /** Fila enfocada: lleva la vista del documento a su renglón. */
  const [enfocado, setEnfocado] = useState<string | null>(null);

  const reportId = informe?.id ?? null;
  const courseId = informe?.course_id ?? null;
  const html = informe?.html ?? "";
  const anclados = useMemo(() => uidsDeRanuras(html), [html]);
  const conRanuras = useMemo(() => anclados.length > 0, [anclados]);

  useEffect(() => {
    // El informe cambió: se limpia el estado del anterior antes de cargar. Sin
    // esto el diálogo muestra los firmantes y los contadores de otro documento
    // mientras llega la consulta nueva.
    setSolicitudes([]);
    setFirmadas([]);
    setFilas([]);
    setEnfocado(null);
    setError(null);
  }, [reportId]);

  useEffect(() => {
    if (!reportId) return;
    // Un documento sin ninguna ranura anclada no tiene firmantes que listar: se
    // muestra el documento y nada más, sin gastar cuatro consultas.
    if (!conRanuras && !tieneRanuras(html)) return;
    let cancelado = false;
    setCargando(true);
    void (async () => {
      try {
        const [rFirmadas, rSolicitudes, rDocentes] = await Promise.all([
          // La MISMA llamada que usan la descarga del Word y del PDF, así que la
          // vista previa queda igual a lo que se baja.
          db.rpc("report_signatures_of", { _report_id: reportId }),
          db
            .from("report_signatures")
            // Sin `signed_drawing`: ya viene por la RPC de arriba, y pedirlo dos
            // veces puede mover megas (el CHECK admite 120 000 caracteres por
            // firma).
            .select("user_id, signed_at, requested_at, signed_via, signed_hash")
            .eq("report_id", reportId),
          courseId
            ? db.from("course_teachers").select("user_id").eq("course_id", courseId)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (cancelado) return;
        // `error` se distingue de `data: []`: pintar «nadie firmó» cuando la
        // consulta falló es la peor salida posible en esta pantalla.
        if (rSolicitudes.error) {
          setError(friendlyError(rSolicitudes.error, t("reportStatus.loadError")));
          return;
        }
        const sols = (rSolicitudes.data ?? []) as SolicitudCruda[];
        const puestas = (Array.isArray(rFirmadas.data) ? rFirmadas.data : []) as FirmaDeInforme[];
        const idsDocentes = new Set<string>(
          ((rDocentes.data ?? []) as Array<{ user_id: string }>).map((d) => d.user_id),
        );

        // Patrón 2-query obligatorio: `report_signatures.user_id` apunta a
        // `auth.users`, así que el embed `profiles:user_id(...)` devuelve
        // PGRST200 y deja la data VACÍA, en silencio.
        const yaNombrados = new Set(
          puestas.filter((f) => (f.nombre ?? "").trim()).map((f) => f.user_id),
        );
        const faltantes = [...new Set([...anclados, ...sols.map((s) => s.user_id)])].filter(
          (id) => !yaNombrados.has(id),
        );
        let perfiles: Array<{
          id: string;
          full_name: string | null;
          institutional_email: string | null;
        }> = [];
        if (faltantes.length > 0) {
          // El guard de longitud no es defensivo por gusto: un `.in("id", [])`
          // en PostgREST devuelve TODAS las filas.
          const { data } = await db
            .from("profiles")
            .select("id, full_name, institutional_email")
            .in("id", faltantes);
          if (cancelado) return;
          perfiles = data ?? [];
        }

        setSolicitudes(sols);
        setFirmadas(puestas);
        setFilas(
          filasDeFirmantes({
            anclados,
            solicitudes: sols,
            firmadas: puestas,
            perfiles,
            idsDocentes,
          }),
        );
      } catch (e) {
        if (!cancelado) setError(friendlyError(e, t("reportStatus.loadError")));
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, courseId, conRanuras, nonce]);

  const resumen = useMemo(() => resumirFirmas(solicitudes, html), [solicitudes, html]);
  const lote = useMemo(() => loteDeSolicitud(solicitudes), [solicitudes]);
  const divergente = useMemo(() => hashDivergente(solicitudes), [solicitudes]);
  const sinFirmantes = resumen.clase === "sin-ranuras";
  const hayPuertas = filas.some((f) => f.anclada);

  const detalleFirma = useCallback(
    (f: FilaFirmante) =>
      [
        f.via === "app"
          ? t("reportStatus.viaApp")
          : f.via === "link"
            ? t("reportStatus.viaLink")
            : null,
        f.conDibujo ? t("reportStatus.withDrawing") : null,
        f.firmaId ? codigoVerificacion(f.firmaId) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    [t],
  );

  const documento = informe ? (
    <SignableDocument
      title={informe.template_name}
      html={informe.html}
      firmas={firmadas}
      firmanteId={enfocado}
      className="w-full h-[45dvh] md:h-[70dvh] rounded-md border bg-background"
    />
  ) : null;

  return (
    <Dialog open={!!informe} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-6xl max-h-[92dvh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSearch className="h-4 w-4" />
            {t("reportStatus.dialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {informe
              ? [
                  informe.template_name,
                  informe.course_name,
                  informe.student_name,
                  formatDateTime(informe.created_at),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : ""}
          </DialogDescription>
        </DialogHeader>

        {/* La respuesta va arriba y NO scrollea con el documento. */}
        {sinFirmantes ? (
          <p className="text-2xs text-muted-foreground">{t("reportStatus.noSlots")}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">
              {t("reportStatus.signedOfTotal", {
                signed: resumen.firmadas,
                total: resumen.total,
              })}
            </span>
            {resumen.total - resumen.firmadas > 0 && (
              <Badge variant="outline" className="text-3xs">
                {t("reportSign.pendingCount", { count: resumen.total - resumen.firmadas })}
              </Badge>
            )}
            {resumen.sinSolicitar > 0 && (
              <Badge variant="outline" className="text-3xs">
                {t("reportStatus.notRequestedCount", { count: resumen.sinSolicitar })}
              </Badge>
            )}
            {resumen.clase === "completo" && (
              <span className="text-2xs text-emerald-600 dark:text-emerald-400">
                {t("reportStatus.allSigned")}
              </span>
            )}
            {lote && (
              <span className="text-2xs text-muted-foreground">
                {t("reportStatus.requestedBatch", { date: formatDateTime(lote) })}
              </span>
            )}
            {divergente && (
              <span className="text-2xs text-amber-600 dark:text-amber-400">
                {t("reportStatus.hashMismatch")}
              </span>
            )}
          </div>
        )}

        <div
          className={`grid gap-3 flex-1 min-h-0 overflow-hidden ${
            sinFirmantes ? "md:grid-cols-1" : "md:grid-cols-[minmax(0,1fr)_18rem]"
          }`}
        >
          {/* La LISTA va PRIMERA en el DOM para que a 375px la respuesta esté
              arriba; en md+ la colocación explícita la manda a la derecha sin
              necesidad de `order-*`. */}
          {!sinFirmantes && (
            <div className="md:col-start-2 md:row-start-1 min-h-0 flex flex-col gap-1.5">
              {error ? (
                <ErrorState
                  message={t("reportStatus.loadError")}
                  hint={error}
                  onRetry={() => {
                    setError(null);
                    setNonce((n) => n + 1);
                  }}
                />
              ) : cargando ? (
                <SectionLoader />
              ) : filas.length === 0 ? (
                /* Sin acción propia: el primario de «Enviar a firmar» ya está en
                   el pie del diálogo, y dos primarios en la misma pantalla dejan
                   de decir qué se vino a hacer. */
                <EmptyState icon={PenLine} title={t("reportStatus.noneRequested")} />
              ) : (
                <>
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-1 rounded-md border p-2">
                    {filas.map((f) => {
                      const cuerpo = (
                        <>
                          <span className="flex-1 min-w-0">
                            <span className="block truncate">{f.nombre}</span>
                            {f.email && (
                              <span className="block truncate text-2xs text-muted-foreground">
                                {f.email}
                              </span>
                            )}
                            {f.estado === "firmada" && (
                              <>
                                <span className="block text-2xs text-emerald-600 dark:text-emerald-400">
                                  {t("reportSign.signedOn", {
                                    date: formatDateTime(f.signedAt as string),
                                  })}
                                </span>
                                {detalleFirma(f) && (
                                  <span className="block truncate text-3xs text-muted-foreground">
                                    {detalleFirma(f)}
                                  </span>
                                )}
                              </>
                            )}
                            {f.estado === "pendiente" && !lote && f.requestedAt && (
                              <span className="block text-2xs text-muted-foreground">
                                {t("reportStatus.requestedOn", {
                                  date: formatDateTime(f.requestedAt),
                                })}
                              </span>
                            )}
                            {f.estado === "sin_solicitar" && (
                              <span className="block text-2xs text-amber-600 dark:text-amber-400">
                                {t("reportStatus.notRequested")}
                              </span>
                            )}
                          </span>
                          {f.esDocente && (
                            <Badge variant="secondary" className="text-3xs shrink-0">
                              {t("reportSign.roleTeacher")}
                            </Badge>
                          )}
                        </>
                      );
                      // Una fila sin ranura en el documento no es puerta a nada:
                      // no hay renglón al que llevar la vista.
                      return f.anclada ? (
                        <button
                          key={f.userId}
                          type="button"
                          className="w-full text-left flex items-start gap-2 rounded p-1.5 text-sm hover:bg-accent"
                          onClick={() => setEnfocado(f.userId)}
                        >
                          {cuerpo}
                        </button>
                      ) : (
                        <div
                          key={f.userId}
                          className="w-full flex items-start gap-2 rounded p-1.5 text-sm"
                        >
                          {cuerpo}
                        </div>
                      );
                    })}
                  </div>
                  {hayPuertas && (
                    <p className="text-3xs text-muted-foreground">{t("reportStatus.focusHint")}</p>
                  )}
                </>
              )}
            </div>
          )}

          <div
            className={`min-h-0 overflow-hidden ${
              sinFirmantes ? "" : "md:col-start-1 md:row-start-1"
            }`}
          >
            {/* El documento se monta recién con las firmas resueltas: pintarlo
                primero en blanco y después con las firmas es un salto que en esta
                pantalla se lee como información y engaña. */}
            {cargando && !error ? (
              <div className="w-full h-[45dvh] md:h-[70dvh] rounded-md border">
                <SectionLoader />
              </div>
            ) : (
              documento
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          {informe && informe.course_id && onEnviarAFirmar && (
            <Button onClick={() => onEnviarAFirmar(informe)}>
              <PenLine className="h-4 w-4 mr-1" />
              {t("reportSign.rowAction")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
