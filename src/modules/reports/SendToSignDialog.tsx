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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BellOff, Eraser, PenLine, Search, Users } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { useAuth } from "@/hooks/use-auth";
import { SignaturePadDialog } from "./SignaturePadDialog";
import { uidsDeRanuras } from "./signature-slots";
import {
  alternarVisibles,
  calcularDiff,
  filtrarFirmantes,
  seleccionables,
  todosVisiblesMarcados,
} from "./send-to-sign-selection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Matriculado {
  id: string;
  nombre: string;
  email: string | null;
  /** Docente del curso. Su casilla en el Acuerdo es "El Docente / Tutor". */
  esDocente?: boolean;
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
  html = null,
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
  /**
   * El HTML del informe generado. Cuando viene, la lista de firmantes se deriva de
   * las RANURAS que el documento ancla, y no de la matrícula del curso.
   *
   * Es lo correcto porque el documento es la fuente de verdad de quién firma, y
   * arregla dos casos que la matrícula responde mal: un informe del que el docente
   * EXCLUYÓ estudiantes (siguen matriculados, pero no están en el documento) y un
   * informe por estudiante con la ranura del docente (que no está matriculado).
   */
  html?: string | null;
  onOpenChange: (abierto: boolean) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { user, profile } = useAuth();
  const [cargando, setCargando] = useState(false);
  /** Qué firma se está borrando, para deshabilitar solo esa fila. */
  const [borrando, setBorrando] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [alumnos, setAlumnos] = useState<Matriculado[]>([]);
  const [solicitudes, setSolicitudes] = useState<Map<string, Solicitud>>(new Map());
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  /** Pedir la firma SIN avisar: el docente reparte los enlaces el mismo. */
  const [notificar, setNotificar] = useState(true);
  const [lienzoAbierto, setLienzoAbierto] = useState(false);
  const [firmandoPropia, setFirmandoPropia] = useState(false);

  const cargar = useCallback(async (cancelado?: () => boolean) => {
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
      // El o los DOCENTES del curso también firman: el Acuerdo Pedagógico tiene
      // una casilla "El Docente / Tutor", y hasta ahora no había forma de
      // llenarla porque la lista salía solo de las matrículas.
      const { data: docentes } = await db
        .from("course_teachers")
        .select("user_id")
        .eq("course_id", courseId);
      const idsDocentes = new Set(
        (docentes ?? []).map((d: { user_id: string }) => d.user_id),
      );
      const idsMatriculados = (matriculas ?? []).map((m: { user_id: string }) => m.user_id);
      // Un mismo usuario puede ser docente Y estar matriculado (pasa en los cursos
      // de prueba): se pide su perfil una sola vez.
      const ids = [...new Set([...idsMatriculados, ...idsDocentes])];
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
            esDocente: idsDocentes.has(p.id),
          }))
          // El docente primero: su casilla va arriba en el documento y es la que
          // el propio docente viene a firmar.
          .sort(
            (a, b) =>
              Number(!!b.esDocente) - Number(!!a.esDocente) ||
              a.nombre.localeCompare(b.nombre, "es-CO"),
          );
      }
      const { data: firmas } = await db
        .from("report_signatures")
        .select("user_id, signed_at, public_token")
        .eq("report_id", reportId);
      const mapa = new Map<string, Solicitud>();
      for (const f of (firmas ?? []) as Solicitud[]) mapa.set(f.user_id, f);
      // Quién firma lo dice el DOCUMENTO, no la matrícula.
      //
      // El snapshot ancla una ranura por firmante (`data-firma-uid`), así que de
      // ahí sale la lista exacta: sin los estudiantes que el docente excluyó del
      // informe —que siguen matriculados y a los que no hay que pedirles firmar un
      // documento donde no aparecen— y CON el docente, que no está matriculado y
      // hasta ahora quedaba fuera de la lista aunque su casilla existiera.
      //
      // Se suma siempre a quien ya tenga una solicitud: esconder algo que ya se
      // pidió sería peor que mostrarlo.
      const anclados = uidsDeRanuras(html);
      let lista: Matriculado[];
      if (anclados.length > 0) {
        const permitidos = new Set([...anclados, ...mapa.keys()]);
        lista = perfiles.filter((p) => permitidos.has(p.id));
        // Un ancla cuyo perfil no vino en la consulta (se retiró del curso y ya no
        // está en `course_enrollments` ni en `course_teachers`) no se puede mostrar
        // con nombre; se omite en vez de inventar una fila.
      } else {
        // Sin ranuras: es un documento que se firma "en general" (o de antes de que
        // existieran). Se conserva el comportamiento previo — en un informe POR
        // ESTUDIANTE, solo esa persona.
        const acotada = studentId
          ? perfiles.filter((p) => p.id === studentId || mapa.has(p.id))
          : perfiles;
        lista = acotada.length > 0 ? acotada : perfiles;
      }
      // Se preseleccionan los que ya tienen solicitud, para que el diálogo
      // muestre el estado real en vez de arrancar en blanco y dar la impresión
      // de que no se le pidió a nadie. En un informe por estudiante, además,
      // arranca marcado el destinatario: es el único que puede firmarlo.
      const marcados = new Set(mapa.keys());
      if (studentId && lista.some((p) => p.id === studentId)) marcados.add(studentId);
      // Se comprueba DESPUÉS de los await: si el docente ya abrió el diálogo de otro
      // informe, esta carga vieja no puede pisar la nueva.
      if (cancelado?.()) return;
      setAlumnos(lista);
      setSolicitudes(mapa);
      setElegidos(marcados);
    } finally {
      if (!cancelado?.()) setCargando(false);
    }
  }, [reportId, courseId, studentId, html]);

  useEffect(() => {
    let cancelado = false;
    void cargar(() => cancelado);
    return () => {
      cancelado = true;
    };
  }, [cargar]);

  // El buscador es de ESTA sesión del diálogo. No se limpia dentro de `cargar()`
  // porque `cargar()` también corre después de borrar una firma, y ahí borrarle el
  // filtro al docente le hace perder de vista a quien estaba mirando.
  useEffect(() => {
    setQ("");
    // Y se vacía la lista del informe ANTERIOR: mientras carga la nueva, el diálogo
    // mostraba sus firmantes y sus contadores de firmas, que son de otro documento.
    setAlumnos([]);
    setSolicitudes(new Map());
    setElegidos(new Set());
    // "No avisar" también se reinicia: es una decision sobre ESTE envio. Sin esto
    // se hereda del informe anterior y el docente manda 40 solicitudes sin
    // notificacion ni correo creyendo que si avisaron — y no hay forma de darse
    // cuenta despues, porque no queda nada que mirar.
    setNotificar(true);
  }, [reportId]);

  const firmoYa = useCallback(
    (id: string) => !!solicitudes.get(id)?.signed_at,
    [solicitudes],
  );
  const filtrados = useMemo(() => filtrarFirmantes(alumnos, q), [alumnos, q]);
  /** Sobre lo que la acción masiva puede operar: lo visible y sin firmar. */
  const masivos = useMemo(() => seleccionables(filtrados, firmoYa), [filtrados, firmoYa]);
  const todosMarcados = useMemo(
    () => todosVisiblesMarcados(elegidos, filtrados, firmoYa),
    [elegidos, filtrados, firmoYa],
  );
  // El diff se calcula sobre la lista COMPLETA, nunca sobre la filtrada: con la
  // filtrada, los pendientes que el buscador esconde caerían en `retirados` y se
  // borrarían sus solicitudes.
  const diff = useMemo(
    () =>
      calcularDiff(alumnos, elegidos, (id) => {
        const s = solicitudes.get(id);
        return s ? { firmada: !!s.signed_at } : undefined;
      }),
    [alumnos, elegidos, solicitudes],
  );

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

  /**
   * Mi propia firma, desde acá.
   *
   * Sin esto el docente tendría que pedirse la firma a sí mismo, esperar la
   * notificación —que ya no se manda, porque avisarle de algo que acaba de hacer
   * es ruido— y buscar el enlace. Firma en el mismo lugar donde acaba de pedirla.
   */
  const firmarMiPropia = async (dibujo: string | null) => {
    if (!reportId || !user?.id) return;
    setFirmandoPropia(true);
    try {
      const { data, error } = await db.rpc("sign_report", {
        _report_id: reportId,
        _user_agent: navigator.userAgent,
        _drawing: dibujo,
      });
      const r = data as { ok?: boolean; already?: boolean; error?: string } | null;
      if (error || !r?.ok) {
        toast.error(friendlyError(error, t("reportSign.signMineError")));
        return;
      }
      toast.success(t("reportSign.signMineOk"));
      setLienzoAbierto(false);
      await cargar();
    } finally {
      setFirmandoPropia(false);
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
    const { nuevos, retirados } = diff;

    if (nuevos.length === 0 && retirados.length === 0) {
      toast.info(t("reportSign.nothingToDo"));
      return;
    }
    // Retirar borra la solicitud, y con ella el enlace personal de esa persona: el
    // que ya le compartieron deja de funcionar y volver a pedirla genera otro
    // distinto. Antes había que desmarcar de a uno; con la acción masiva son N de
    // un clic, así que se confirma. Tono `warning` y no `destructive` porque se
    // puede volver a pedir, pero el aviso dice CUÁNTOS.
    if (retirados.length > 0) {
      const ok = await confirm({
        title: t("reportSign.withdrawTitle", { count: retirados.length }),
        description: t("reportSign.withdrawBody"),
        confirmLabel: t("reportSign.withdrawConfirm"),
        tone: "warning",
      });
      if (!ok) return;
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
          _notificar: notificar,
        });
        const r = data as {
          ok?: boolean;
          requested?: number;
          skipped?: number;
          not_eligible?: number;
          error?: string;
        } | null;
        if (error || !r?.ok) {
          toast.error(friendlyError(error, t("reportSign.errRequest")));
          return;
        }
        toast.success(t("reportSign.requestedOk", { count: r.requested ?? nuevos.length }));
        // `not_eligible` es gente que NO puede firmar este documento (no es del
        // curso). Antes se sumaba a `skipped` y desaparecía: el docente veía
        // "se pidió a 0" sin ninguna pista de por qué.
        if ((r.not_eligible ?? 0) > 0) {
          toast.warning(t("reportSign.notEligible", { count: r.not_eligible }));
        }
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
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-3xs">
                  {t("reportSign.signedCount", { count: firmados })}
                </Badge>
                <Badge variant="outline" className="text-3xs">
                  {t("reportSign.pendingCount", { count: pendientes })}
                </Badge>
              </div>
              {masivos.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-2xs"
                  onClick={() =>
                    setElegidos((prev) =>
                      alternarVisibles(prev, filtrados, firmoYa, !todosMarcados),
                    )
                  }
                >
                  {q.trim()
                    ? todosMarcados
                      ? t("reportSign.deselectShown", { count: masivos.length })
                      : t("reportSign.selectShown", { count: masivos.length })
                    : todosMarcados
                      ? t("common.deselectAll")
                      : t("common.selectAll")}
                </Button>
              )}
            </div>
            {/* El buscador aparece cuando la lista deja de caber de un vistazo. En
                producción hay cursos de 96, 66 y 64 matriculados: ahí marcar a mano
                es scrollear una caja de 45dvh. */}
            {alumnos.length > 8 && (
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("assignSelector.searchPlaceholder")}
                  className="pl-7 h-8 text-xs"
                />
              </div>
            )}
            <div className="max-h-[45dvh] overflow-y-auto space-y-1 rounded-md border p-2">
              {filtrados.length === 0 ? (
                <p className="text-2xs text-muted-foreground py-3 text-center">
                  {t("common.noResults")}
                </p>
              ) : (
                filtrados.map((a) => {
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
                    {a.esDocente && (
                      <Badge variant="secondary" className="text-3xs shrink-0">
                        {t("reportSign.roleTeacher")}
                      </Badge>
                    )}
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
                      a.id === user?.id ? (
                        /* Mi propia fila: firmo acá mismo. Pedirme el enlace a mí
                           mismo y buscarlo en el correo no tiene sentido. */
                        <RowAction
                          label={t("reportSign.signMine")}
                          icon={PenLine}
                          disabled={!sol}
                          onClick={(e) => {
                            e.preventDefault();
                            setLienzoAbierto(true);
                          }}
                        />
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
                      )
                    )}
                  </label>
                );
                })
              )}
            </div>
            {/* Qué va a pasar al pulsar Guardar. Sin esto el botón no dice si
                dispara 3 correos o 96, y son irreversibles. */}
            {(diff.nuevos.length > 0 || diff.retirados.length > 0) && (
              <p className="text-2xs text-muted-foreground">
                {[
                  diff.nuevos.length > 0
                    ? t("reportSign.willRequest", { count: diff.nuevos.length })
                    : null,
                  diff.retirados.length > 0
                    ? t("reportSign.willWithdraw", { count: diff.retirados.length })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </>
        )}

        {/* Pedir la firma sin avisar. El caso real: el docente reparte los enlaces
            él mismo (en clase, por el grupo del curso) y no quiere que salgan 21
            correos antes de haberlo explicado. */}
        {!cargando && alumnos.length > 0 && (
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={!notificar}
              onCheckedChange={(v) => setNotificar(!v)}
              className="mt-0.5"
            />
            <span>
              <span className="flex items-center gap-1.5 font-medium">
                <BellOff className="h-3.5 w-3.5" />
                {t("reportSign.dontNotify")}
              </span>
              <span className="block text-2xs text-muted-foreground">
                {t("reportSign.dontNotifyHint")}
              </span>
            </span>
          </label>
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
      <SignaturePadDialog
        open={lienzoAbierto}
        onOpenChange={setLienzoAbierto}
        onConfirmar={(dibujo) => void firmarMiPropia(dibujo)}
        firmando={firmandoPropia}
        nombre={profile?.full_name}
      />
    </Dialog>
  );
}
