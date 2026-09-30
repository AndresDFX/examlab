/**
 * «Crear recuperatorio» para TALLERES: copia de un taller, enlazada a él, para
 * quienes lo perdieron o no lo presentaron. Espejo de
 * `CrearRecuperacionDialog` (exámenes); comparte los textos `recuperaciones.*`
 * y los helpers de elegibilidad, cambiando lo específico del taller:
 *
 *  - Duplica con `clone_workshop` (con `_copy_groups=true` y fechas explícitas
 *    — con `false` falla 23502 por `group_size_min NOT NULL`).
 *  - La copia nace en BORRADOR, se enlaza con `parent_workshop_id` +
 *    `makeup_kind`/`recovery_rule`, y se le crea su fila `workshop_courses` con
 *    el MISMO peso y corte que el ORIGINAL tiene en ESTE curso (talleres son
 *    M:N; desde la mig 20262670000000 `clone_workshop` vuelve a crearla, pero
 *    se reemplaza igual para no depender de la versión). La recuperación se excluye de
 *    las sumas de bucket, así que ese peso no suma aparte.
 *  - Se asigna por `workshop_assignments` (como el estudiante ve los talleres):
 *    solo los elegidos lo ven. Asignar en borrador no avisa.
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
  candidatosDeTallerParaRecuperacion,
  sugerirFechasDeRecuperacion,
  type Candidato,
} from "@/modules/grading/elegibles-recuperacion";
import {
  REGLAS_RECUPERATORIO,
  TIPOS_RECUPERACION,
  type FilaDeTaller,
  type ItemResuelto,
  type ReglaRecuperatorio,
  type TipoRecuperacion,
} from "@/modules/grading/nota-con-recuperacion";
import { notaEfectivaDeTaller } from "@/modules/grading/nota-efectiva";
import { entregaHecha } from "@/modules/submissions/entrega-hecha";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface TallerOrigen extends FilaDeTaller {
  title: string;
  course_id: string;
  start_date: string | null;
  due_date: string | null;
  is_external?: boolean | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origen: TallerOrigen;
  /** Talleres del curso (sin papelera): de acá salen las recuperaciones ya creadas. */
  talleresDelCurso: readonly FilaDeTaller[];
  onCreated: (newWorkshopId: string) => void;
}

interface Estudiante {
  id: string;
  nombre: string;
}
interface EntregaTaller {
  workshop_id: string;
  user_id: string;
  group_id: string | null;
  status: string | null;
  ai_grade: number | null;
  final_grade: number | null;
}

function aLocal(d: Date): string {
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function CrearRecuperacionTallerDialog({
  open,
  onOpenChange,
  origen,
  talleresDelCurso,
  onCreated,
}: Readonly<Props>) {
  const { t } = useTranslation();
  const externo = !!origen.is_external;
  // Las columnas de la recuperación llegan con la mig 20262660000000, y el
  // frontend puede desplegarse antes que ella.
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
  const [entregas, setEntregas] = useState<EntregaTaller[]>([]);
  const [gruposPorUsuario, setGruposPorUsuario] = useState<Map<string, Set<string>>>(new Map());
  const [defensaPorTaller, setDefensaPorTaller] = useState<Map<string, boolean>>(new Map());
  const [maxScorePorTaller, setMaxScorePorTaller] = useState<Map<string, number>>(new Map());
  const [escala, setEscala] = useState({ min: 0, max: 5, aprobacion: 3 });
  const [finCurso, setFinCurso] = useState<string | null>(null);
  const [origenWc, setOrigenWc] = useState<{ cut_id: string | null; weight: number | null } | null>(null);
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTipo("recuperatorio");
    setRegla("mayor");
    setCopiarPreguntas(true);
    setTitulo(t("recuperaciones.defaultTitle", { title: origen.title }));
    const f = sugerirFechasDeRecuperacion(
      new Date(origen.start_date ?? Date.now()),
      new Date(origen.due_date ?? origen.start_date ?? Date.now()),
      new Date(),
    );
    setInicio(aLocal(f.inicio));
    setFin(aLocal(f.fin));
    setErrorCarga(null);
    setCargando(true);

    void (async () => {
      try {
        const idsTalleres = [
          origen.id,
          ...talleresDelCurso.filter((w) => w.parent_workshop_id === origen.id).map((w) => w.id),
        ];
        const [curso, matriculas, docentes, subs, wsMeta, wcOrig] = await Promise.all([
          db
            .from("courses")
            .select("grade_scale_min, grade_scale_max, passing_grade, end_date")
            .eq("id", origen.course_id)
            .single(),
          db.from("course_enrollments").select("user_id").eq("course_id", origen.course_id),
          db.from("course_teachers").select("user_id").eq("course_id", origen.course_id),
          db
            .from("workshop_submissions")
            .select("workshop_id, user_id, group_id, status, ai_grade, final_grade")
            .in("workshop_id", idsTalleres),
          db.from("workshops").select("id, max_score, is_external, requires_defense").in("id", idsTalleres),
          db
            .from("workshop_courses")
            .select("cut_id, weight")
            .eq("workshop_id", origen.id)
            .eq("course_id", origen.course_id)
            .maybeSingle(),
        ]);
        const err = curso.error ?? matriculas.error ?? docentes.error ?? subs.error ?? wsMeta.error;
        if (err) throw err;

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

        // Membresía de grupo por usuario (para elegir la entrega grupal).
        const grupos = idsTalleres.length
          ? await db
              .from("workshop_group_members")
              .select("user_id, group:workshop_groups!inner(id, workshop_id)")
          : { data: [], error: null };
        const gruposMap = new Map<string, Set<string>>();
        for (const m of ((grupos.data ?? []) as Array<{
          user_id: string;
          group: { id: string; workshop_id: string } | null;
        }>)) {
          if (!m.group || !idsTalleres.includes(m.group.workshop_id)) continue;
          if (!gruposMap.has(m.user_id)) gruposMap.set(m.user_id, new Set());
          gruposMap.get(m.user_id)!.add(m.group.id);
        }

        if (cancelled) return;
        setEstudiantes(
          ids
            .map((id) => ({ id, nombre: nombrePorId.get(id) ?? id }))
            .sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
        );
        setEntregas((subs.data ?? []) as EntregaTaller[]);
        setGruposPorUsuario(gruposMap);
        setDefensaPorTaller(
          new Map(
            ((wsMeta.data ?? []) as Array<{ id: string; requires_defense: boolean | null }>).map(
              (w) => [w.id, !!w.requires_defense],
            ),
          ),
        );
        const scaleMax = Number(curso.data?.grade_scale_max ?? 5);
        setMaxScorePorTaller(
          new Map(
            ((wsMeta.data ?? []) as Array<{ id: string; max_score: number; is_external: boolean | null }>).map(
              (w) => [w.id, w.is_external ? scaleMax : Number(w.max_score ?? 100)],
            ),
          ),
        );
        setFinCurso((curso.data?.end_date as string | null) ?? null);
        setEscala({
          min: Number(curso.data?.grade_scale_min ?? 0),
          max: scaleMax,
          aprobacion: Number(curso.data?.passing_grade ?? 3),
        });
        setOrigenWc(
          wcOrig?.data
            ? { cut_id: wcOrig.data.cut_id ?? null, weight: wcOrig.data.weight ?? null }
            : null,
        );
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

  // Nota EN ESCALA DEL CURSO de un (taller, usuario): entrega grupal con
  // precedencia sobre la individual, luego notaEfectivaDeTaller escalada.
  const notaDe = (tallerId: string, userId: string): ItemResuelto => {
    const gruposUser = gruposPorUsuario.get(userId);
    const sub =
      entregas.find(
        (s) => s.workshop_id === tallerId && !!s.group_id && !!gruposUser?.has(s.group_id),
      ) ?? entregas.find((s) => s.workshop_id === tallerId && s.user_id === userId);
    const raw = notaEfectivaDeTaller(sub, defensaPorTaller.get(tallerId));
    const max = maxScorePorTaller.get(tallerId) ?? escala.max;
    const nota =
      raw == null
        ? null
        : escala.min + (max > 0 ? raw / max : 0) * (escala.max - escala.min);
    return { id: tallerId, presento: entregaHecha(sub), nota };
  };

  const resultado = useMemo(
    () =>
      candidatosDeTallerParaRecuperacion({
        tipo,
        estudiantes: estudiantes.map((e) => e.id),
        taller: origen,
        talleres: talleresDelCurso,
        notaDe,
        escala,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tipo, estudiantes, origen, talleresDelCurso, entregas, gruposPorUsuario, defensaPorTaller, maxScorePorTaller, escala],
  );
  const nombre = useMemo(() => new Map(estudiantes.map((e) => [e.id, e.nombre])), [estudiantes]);

  const claveDeLista = resultado.candidatos.map((c) => `${c.userId}:${c.motivo}`).join(",");
  useEffect(() => {
    setElegidos(new Set(resultado.candidatos.filter((c) => c.sugerido).map((c) => c.userId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveDeLista]);

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
    const fi = externo ? ini : new Date(fin);
    if (!Number.isFinite(ini.getTime()) || !Number.isFinite(fi.getTime())) {
      toast.error(t("recuperaciones.datesRequired"));
      return;
    }
    if (!externo && fi.getTime() <= ini.getTime()) {
      toast.error(t("common.endDateBeforeStart"));
      return;
    }
    const tope = courseEndOfDay(finCurso);
    if (tope && ini.getTime() > tope.getTime()) {
      toast.error(t("recuperaciones.afterCourseEnd"));
      return;
    }
    setEnviando(true);
    try {
      // _copy_groups=true SIEMPRE: con false falla 23502 (group_size_min NOT NULL).
      const { data: nuevoId, error: errClon } = await db.rpc("clone_workshop", {
        _source_id: origen.id,
        _target_course_id: origen.course_id,
        _new_title: titulo.trim(),
        _new_start_date: ini.toISOString(),
        _new_due_date: fi.toISOString(),
        _copy_questions: copiarPreguntas,
        _copy_groups: true,
      });
      if (errClon || !nuevoId) {
        toast.error(friendlyError(errClon));
        return;
      }
      const id = String(nuevoId);

      // Enlace + tipo/regla. Se pide la fila de vuelta: un UPDATE que la RLS
      // filtra no da error, da 0 filas.
      const { data: enlazado, error: errEnlace } = await db
        .from("workshops")
        .update({ parent_workshop_id: origen.id, makeup_kind: tipo, recovery_rule: regla })
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

      // workshop_courses de la copia: MISMO peso y corte que el original en
      // ESTE curso: se borra y se crea aunque `clone_workshop` ya la haya creado
      // (mig 20262670000000), para no depender de la versión. Se excluye de las
      // sumas de bucket, así que ese peso no suma aparte.
      await db
        .from("workshop_courses")
        .delete()
        .eq("workshop_id", id)
        .eq("course_id", origen.course_id);
      const { error: errWc } = await db.from("workshop_courses").insert({
        workshop_id: id,
        course_id: origen.course_id,
        weight: origenWc?.weight ?? null,
        cut_id: origenWc?.cut_id ?? null,
      });
      if (errWc) {
        toast.error(t("recuperaciones.linkError", { error: friendlyError(errWc) }), {
          duration: 12000,
        });
        onCreated(id);
        return;
      }

      const aAsignar = [...elegidos];
      if (aAsignar.length) {
        const { error: errAsig } = await db
          .from("workshop_assignments")
          .insert(aAsignar.map((user_id) => ({ workshop_id: id, user_id })));
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
        aAsignar.length ? t(clave, { count: aAsignar.length }) : t(`${clave}None`),
        { duration: 9000 },
      );
      onCreated(id);
    } finally {
      setEnviando(false);
    }
  };

  const idTipo = (v: string) => `recuperacion-taller-tipo-${v}`;
  const idRegla = (v: string) => `recuperacion-taller-regla-${v}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !enviando && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            {t(tipo === "recuperatorio" ? "recuperaciones.dialogTitle" : "recuperaciones.dialogTitleSupletorio")}
          </DialogTitle>
          <DialogDescription>
            {t("recuperaciones.dialogDescriptionTaller", { title: origen.title })}
          </DialogDescription>
        </DialogHeader>

        {!baseLista ? (
          <Alert>
            <AlertDescription>{t("recuperaciones.notReady")}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
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
                <Label htmlFor="recuperacion-taller-titulo" required>
                  {t("recuperaciones.titleLabel")}
                </Label>
                <Input
                  id="recuperacion-taller-titulo"
                  value={titulo}
                  onChange={(e) => setTitulo(e.target.value)}
                  disabled={enviando}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label required>
                    {t(externo ? "recuperaciones.dateLabel" : "recuperaciones.startLabel")}
                  </Label>
                  <DateTimePicker value={inicio} onChange={setInicio} disabled={enviando} />
                </div>
                {!externo && (
                  <div className="space-y-1.5">
                    <Label required>{t("recuperaciones.endLabel")}</Label>
                    <DateTimePicker value={fin} onChange={setFin} disabled={enviando} />
                  </div>
                )}
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
