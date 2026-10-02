/**
 * «Crear recuperatorio»: copia de un examen, enlazada a él, para quienes lo
 * perdieron o no lo presentaron.
 *
 * Hace en un paso lo que antes eran cuatro a mano y se hacían mal: duplicar,
 * marcar «es supletorio de» (que además solo sabía de supletorios: la nota del
 * recuperatorio se IGNORABA para quien había presentado el original), mover
 * las fechas y asignar a cada estudiante que corresponde — el formulario de
 * crear asigna a todo el curso, o sea que le ofrecía la recuperación a quien
 * aprobó.
 *
 * La copia nace en BORRADOR y se asigna en ese momento. Asignar no le avisa a
 * nadie mientras siga en borrador (mig 20262650000000): el aviso sale al
 * publicarla, y solo a los asignados. Así el docente cambia las preguntas con
 * calma y el curso no se entera de un examen que todavía no existe.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { SectionLoader } from "@/components/ui/loaders";
import { DateTimePicker } from "@/components/ui/date-picker";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatNumber } from "@/shared/lib/format";
import { courseEndOfDay } from "@/shared/lib/date-range";
import {
  candidatosParaRecuperacion,
  sugerirFechasDeRecuperacion,
  type Candidato,
} from "@/modules/grading/elegibles-recuperacion";
import {
  REGLAS_RECUPERATORIO,
  TIPOS_RECUPERACION,
  type FilaDeExamen,
  type ReglaRecuperatorio,
  type TipoRecuperacion,
} from "@/modules/grading/nota-con-recuperacion";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface ExamenOrigen extends FilaDeExamen {
  title: string;
  course_id: string;
  start_time: string;
  end_time: string;
  is_external?: boolean | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origen: ExamenOrigen;
  /** Exámenes del curso (sin papelera): de acá salen las recuperaciones que ya existen. */
  examenesDelCurso: readonly FilaDeExamen[];
  onCreated: (newExamId: string) => void;
}

interface Estudiante {
  id: string;
  nombre: string;
}

/** "yyyy-MM-ddTHH:mm" en hora local: el formato del `DateTimePicker`. */
function aLocal(d: Date): string {
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function CrearRecuperacionDialog({
  open,
  onOpenChange,
  origen,
  examenesDelCurso,
  onCreated,
}: Readonly<Props>) {
  const { t } = useTranslation();
  const externo = !!origen.is_external;
  // Las columnas de la recuperación llegan con la mig 20262650000000, y el
  // frontend puede desplegarse antes que ella. Sin ellas un recuperatorio se
  // comportaría como supletorio sin avisar, así que el diálogo no deja crear.
  const baseLista = "makeup_kind" in origen;

  const [tipo, setTipo] = useState<TipoRecuperacion>("recuperatorio");
  const [regla, setRegla] = useState<ReglaRecuperatorio>("mayor");
  const [titulo, setTitulo] = useState("");
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [copiarPreguntas, setCopiarPreguntas] = useState(true);

  const [cargando, setCargando] = useState(false);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [estudiantes, setEstudiantes] = useState<Estudiante[]>([]);
  const [intentos, setIntentos] = useState<
    Array<{
      user_id: string;
      exam_id: string;
      status: string | null;
      ai_grade: number | null;
      final_override_grade: number | null;
      created_at: string;
    }>
  >([]);
  const [escala, setEscala] = useState({ min: 0, max: 5, aprobacion: 3 });
  const [finCurso, setFinCurso] = useState<string | null>(null);
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);

  // Al abrir: defaults y la foto de quién presentó qué.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTipo("recuperatorio");
    setRegla("mayor");
    setCopiarPreguntas(true);
    setTitulo(t("recuperaciones.defaultTitle", { title: origen.title }));
    const f = sugerirFechasDeRecuperacion(
      new Date(origen.start_time),
      new Date(origen.end_time),
      new Date(),
    );
    setInicio(aLocal(f.inicio));
    setFin(aLocal(f.fin));
    setErrorCarga(null);
    setCargando(true);

    void (async () => {
      try {
        const idsExamenes = [
          origen.id,
          ...examenesDelCurso.filter((e) => e.parent_exam_id === origen.id).map((e) => e.id),
        ];
        const [curso, matriculas, docentes, subs] = await Promise.all([
          db
            .from("courses")
            .select("grade_scale_min, grade_scale_max, passing_grade, end_date")
            .eq("id", origen.course_id)
            .single(),
          db.from("course_enrollments").select("user_id").eq("course_id", origen.course_id),
          db.from("course_teachers").select("user_id").eq("course_id", origen.course_id),
          db
            .from("submissions")
            .select("user_id, exam_id, status, ai_grade, final_override_grade, created_at")
            .in("exam_id", idsExamenes),
        ]);
        const err = curso.error ?? matriculas.error ?? docentes.error ?? subs.error;
        if (err) throw err;

        // Quien dicta el curso no es candidato aunque esté matriculado (en
        // UNIAJ el dueño se matricula en todos sus cursos para ver la vista
        // del estudiante, y saldría como «no lo presentó»).
        const dictan = new Set(
          ((docentes.data ?? []) as Array<{ user_id: string }>).map((d) => d.user_id),
        );
        const ids = [
          ...new Set(
            ((matriculas.data ?? []) as Array<{ user_id: string }>)
              .map((m) => m.user_id)
              .filter((id) => !dictan.has(id)),
          ),
        ];
        const perfiles = ids.length
          ? await db.from("profiles").select("id, full_name, institutional_email").in("id", ids)
          : { data: [], error: null };
        if (perfiles.error) throw perfiles.error;
        const nombrePorId = new Map<string, string>(
          (
            (perfiles.data ?? []) as Array<{
              id: string;
              full_name: string | null;
              institutional_email: string | null;
            }>
          ).map((p) => [p.id, p.full_name || p.institutional_email || p.id]),
        );
        if (cancelled) return;
        setEstudiantes(
          ids
            .map((id) => ({ id, nombre: nombrePorId.get(id) ?? id }))
            .sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
        );
        setIntentos(subs.data ?? []);
        setFinCurso((curso.data?.end_date as string | null) ?? null);
        setEscala({
          min: Number(curso.data?.grade_scale_min ?? 0),
          max: Number(curso.data?.grade_scale_max ?? 5),
          aprobacion: Number(curso.data?.passing_grade ?? 3),
        });
      } catch (e) {
        if (!cancelled) setErrorCarga(friendlyError(e));
      } finally {
        if (!cancelled) setCargando(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, origen.id]);

  const resultado = useMemo(
    () =>
      candidatosParaRecuperacion({
        tipo,
        estudiantes: estudiantes.map((e) => e.id),
        examen: origen,
        examenes: examenesDelCurso,
        intentos,
        escala,
      }),
    [tipo, estudiantes, origen, examenesDelCurso, intentos, escala],
  );
  const nombre = useMemo(() => new Map(estudiantes.map((e) => [e.id, e.nombre])), [estudiantes]);

  // La selección se rehace cuando cambia la LISTA (otro tipo, o terminó de
  // cargar), y solo entonces: se marcan solos los sugeridos. La clave es el
  // contenido y no la identidad de `resultado`, que cambia cada vez que el
  // padre vuelve a renderizar y borraría lo que el docente ya destildó.
  const claveDeLista = resultado.candidatos.map((c) => `${c.userId}:${c.motivo}`).join(",");
  useEffect(() => {
    setElegidos(new Set(resultado.candidatos.filter((c) => c.sugerido).map((c) => c.userId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveDeLista]);

  // El título por defecto sigue al tipo mientras el docente no lo haya tocado.
  const cambiarTipo = (nuevo: TipoRecuperacion) => {
    const anteriorPorDefecto = t(
      tipo === "recuperatorio" ? "recuperaciones.defaultTitle" : "recuperaciones.defaultTitleSupletorio",
      { title: origen.title },
    );
    if (titulo === anteriorPorDefecto) {
      setTitulo(
        t(
          nuevo === "recuperatorio"
            ? "recuperaciones.defaultTitle"
            : "recuperaciones.defaultTitleSupletorio",
          { title: origen.title },
        ),
      );
    }
    setTipo(nuevo);
  };

  const alternar = (id: string, marcado: boolean) =>
    setElegidos((prev) => {
      const next = new Set(prev);
      if (marcado) next.add(id);
      else next.delete(id);
      return next;
    });

  const motivo = (c: Candidato) => {
    if (c.motivo === "perdio") {
      return t("recuperaciones.reasonFailed", {
        grade: formatNumber(c.nota, { maximumFractionDigits: 2 }),
      });
    }
    if (c.motivo === "no_presento") return t("recuperaciones.reasonAbsent");
    return t("recuperaciones.reasonPending");
  };

  const crear = async () => {
    if (enviando) return;
    if (!titulo.trim()) {
      toast.error(t("recuperaciones.titleRequired"));
      return;
    }
    const ini = new Date(inicio);
    // Una externa tiene inicio y fin como cualquier otra: se valida igual.
    const fi = new Date(fin);
    if (!Number.isFinite(ini.getTime()) || !Number.isFinite(fi.getTime())) {
      toast.error(t("recuperaciones.datesRequired"));
      return;
    }
    if (fi.getTime() <= ini.getTime()) {
      toast.error(t("common.endDateBeforeStart"));
      return;
    }
    // El trigger `cap_end_time_to_course` recorta el fin al del curso SIN error:
    // con un inicio posterior, la ventana quedaría invertida e inservible. A una
    // externa el trigger no la recorta (sus fechas registran lo que pasó), así
    // que acá no hay nada que prevenir.
    const tope = courseEndOfDay(finCurso);
    if (!externo && tope && ini.getTime() > tope.getTime()) {
      toast.error(t("recuperaciones.afterCourseEnd"));
      return;
    }
    setEnviando(true);
    try {
      const { data: nuevoId, error: errClon } = await db.rpc("clone_exam", {
        _source_id: origen.id,
        _target_course_id: origen.course_id,
        _new_title: titulo.trim(),
        _new_start_time: ini.toISOString(),
        _new_end_time: fi.toISOString(),
        _copy_questions: copiarPreguntas,
        _copy_proctoring: true,
      });
      if (errClon || !nuevoId) {
        toast.error(friendlyError(errClon));
        return;
      }
      const id = String(nuevoId);

      // El enlace es lo que hace que sea una RECUPERACIÓN y no un examen más:
      // sin él su nota entraría como otro examen del corte. Se pide la fila de
      // vuelta porque un UPDATE que la RLS filtra no da error, da 0 filas.
      const { data: enlazado, error: errEnlace } = await db
        .from("exams")
        .update({ parent_exam_id: origen.id, makeup_kind: tipo, recovery_rule: regla })
        .eq("id", id)
        .select("id");
      if (errEnlace || !enlazado?.length) {
        toast.error(
          t("recuperaciones.linkError", {
            error: errEnlace ? friendlyError(errEnlace) : t("recuperaciones.linkErrorNoRow"),
          }),
          { duration: 12000 },
        );
        onCreated(id);
        return;
      }

      const aAsignar = [...elegidos];
      if (aAsignar.length) {
        const { error: errAsig } = await db
          .from("exam_assignments")
          .insert(aAsignar.map((user_id) => ({ exam_id: id, user_id })));
        if (errAsig) {
          toast.error(t("recuperaciones.assignError", { error: friendlyError(errAsig) }), {
            duration: 12000,
          });
          onCreated(id);
          return;
        }
      }

      const clave =
        tipo === "recuperatorio" ? "recuperaciones.created" : "recuperaciones.createdSupletorio";
      toast.success(
        aAsignar.length
          ? t(clave, { count: aAsignar.length })
          : t(`${clave}None`),
        { duration: 9000 },
      );
      onCreated(id);
    } finally {
      setEnviando(false);
    }
  };

  const idTipo = (v: string) => `recuperacion-tipo-${v}`;
  const idRegla = (v: string) => `recuperacion-regla-${v}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !enviando && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            {t(tipo === "recuperatorio" ? "recuperaciones.dialogTitle" : "recuperaciones.dialogTitleSupletorio")}
          </DialogTitle>
          <DialogDescription>
            {t("recuperaciones.dialogDescription", { title: origen.title })}
          </DialogDescription>
        </DialogHeader>

        {!baseLista ? (
          <Alert>
            <AlertDescription>{t("recuperaciones.notReady")}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            {/* ── Qué se crea ─────────────────────────────────────────── */}
            <div className="rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">{t("recuperaciones.sectionWhat")}</p>
              <RadioGroup
                value={tipo}
                onValueChange={(v) => cambiarTipo(v as TipoRecuperacion)}
                className="grid grid-cols-1 sm:grid-cols-2 gap-2"
              >
                {TIPOS_RECUPERACION.map((v) => (
                  <label
                    key={v}
                    htmlFor={idTipo(v)}
                    className={`flex items-start gap-2 rounded-md border p-2.5 cursor-pointer transition-colors ${
                      tipo === v ? "border-primary bg-primary/5" : "hover:bg-accent"
                    }`}
                  >
                    <RadioGroupItem value={v} id={idTipo(v)} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="text-sm font-medium block">
                        {t(v === "recuperatorio" ? "recuperaciones.kindRecuperatorio" : "recuperaciones.kindSupletorio")}
                      </span>
                      <span className="text-2xs text-muted-foreground block">
                        {t(
                          v === "recuperatorio"
                            ? "recuperaciones.kindRecuperatorioHint"
                            : "recuperaciones.kindSupletorioHint",
                        )}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>

              {tipo === "recuperatorio" && (
                <div className="space-y-1.5">
                  <Label>{t("recuperaciones.ruleLabel")}</Label>
                  <RadioGroup
                    value={regla}
                    onValueChange={(v) => setRegla(v as ReglaRecuperatorio)}
                    className="grid grid-cols-1 sm:grid-cols-2 gap-2"
                  >
                    {REGLAS_RECUPERATORIO.map((v) => (
                      <label
                        key={v}
                        htmlFor={idRegla(v)}
                        className={`flex items-start gap-2 rounded-md border p-2.5 cursor-pointer transition-colors ${
                          regla === v ? "border-primary bg-primary/5" : "hover:bg-accent"
                        }`}
                      >
                        <RadioGroupItem value={v} id={idRegla(v)} className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="text-sm font-medium block">
                            {t(v === "mayor" ? "recuperaciones.ruleMayor" : "recuperaciones.ruleReemplaza")}
                          </span>
                          <span className="text-2xs text-muted-foreground block">
                            {t(v === "mayor" ? "recuperaciones.ruleMayorHint" : "recuperaciones.ruleReemplazaHint")}
                          </span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="recuperacion-titulo" required>
                  {t("recuperaciones.titleLabel")}
                </Label>
                <Input
                  id="recuperacion-titulo"
                  value={titulo}
                  onChange={(e) => setTitulo(e.target.value)}
                  disabled={enviando}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label required>{t("recuperaciones.startLabel")}</Label>
                  <DateTimePicker value={inicio} onChange={setInicio} disabled={enviando} />
                </div>
                <div className="space-y-1.5">
                  <Label required>{t("recuperaciones.endLabel")}</Label>
                  <DateTimePicker value={fin} onChange={setFin} disabled={enviando} />
                </div>
              </div>

              {!externo && (
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <Checkbox
                    checked={copiarPreguntas}
                    onCheckedChange={(v) => setCopiarPreguntas(v === true)}
                    disabled={enviando}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="text-sm font-medium block">
                      {t("recuperaciones.copyQuestionsLabel")}
                    </span>
                    <span className="text-2xs text-muted-foreground block">
                      {t("recuperaciones.copyQuestionsHint")}
                    </span>
                  </span>
                </label>
              )}
            </div>

            {/* ── A quién se asigna ───────────────────────────────────── */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{t("recuperaciones.sectionWho")}</p>
                {!cargando && resultado.candidatos.length > 0 && (
                  <span className="text-2xs text-muted-foreground tabular-nums">
                    {t("recuperaciones.selectedCount", {
                      selected: elegidos.size,
                      total: resultado.candidatos.length,
                    })}
                  </span>
                )}
              </div>
              <p className="text-2xs text-muted-foreground">
                {tipo === "recuperatorio"
                  ? t("recuperaciones.whoHint", {
                      passing: formatNumber(escala.aprobacion, { maximumFractionDigits: 2 }),
                    })
                  : t("recuperaciones.whoHintSupletorio")}
              </p>
              {cargando ? (
                <SectionLoader />
              ) : errorCarga ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {t("recuperaciones.loadError")} {errorCarga}
                  </AlertDescription>
                </Alert>
              ) : resultado.candidatos.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t(
                    tipo === "recuperatorio"
                      ? "recuperaciones.noneEligible"
                      : "recuperaciones.noneEligibleSupletorio",
                  )}
                </p>
              ) : (
                <ul className="max-h-56 overflow-y-auto divide-y rounded-md border">
                  {resultado.candidatos.map((c) => (
                    <li key={c.userId}>
                      <label className="flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-accent">
                        <Checkbox
                          checked={elegidos.has(c.userId)}
                          onCheckedChange={(v) => alternar(c.userId, v === true)}
                          disabled={enviando}
                        />
                        <span className="text-sm truncate flex-1 min-w-0" title={nombre.get(c.userId)}>
                          {nombre.get(c.userId) ?? c.userId}
                        </span>
                        <Badge
                          variant={c.motivo === "perdio" ? "outline" : "secondary"}
                          className="text-3xs shrink-0"
                        >
                          {motivo(c)}
                        </Badge>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {!cargando && !errorCarga && (
                <p className="text-2xs text-muted-foreground tabular-nums">
                  {tipo === "recuperatorio"
                    ? t("recuperaciones.notListedApproved", { count: resultado.aprobaron })
                    : t("recuperaciones.notListedPresented", { count: resultado.presentaron })}
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void crear()}
            disabled={!baseLista || enviando || cargando || !!errorCarga}
          >
            {enviando ? <Spinner size="sm" className="mr-1" /> : <GitBranch className="h-4 w-4 mr-1" />}
            {t(tipo === "recuperatorio" ? "recuperaciones.submit" : "recuperaciones.submitSupletorio")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
