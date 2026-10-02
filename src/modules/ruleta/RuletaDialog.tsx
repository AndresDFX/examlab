import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Copy, LoaderPinwheel, RotateCcw, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchInput } from "@/components/ui/search-input";
import { SectionLoader } from "@/components/ui/loaders";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatSessionLabel, todayLocalISO } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { matchesQuery } from "@/modules/search/search-text";
import { countsAsPresent } from "@/modules/grading/grade";
import { conPerfilOfrecible } from "@/modules/admin/profile-scope";
import { RuedaSvg } from "./RuedaSvg";
import {
  azarCripto,
  claveDeRonda,
  elegirIndice,
  enLaRueda,
  leerRondaGuardada,
  pareceIdentificador,
  rotacionParaCaerEn,
  sigueCursando,
  textoDeElegidos,
  type FuenteDeRuleta,
  type Participante,
  type RondaGuardada,
} from "./ruleta";

interface Sesion {
  id: string;
  fecha: string;
  etiqueta: string;
}
interface ActividadConGrupos {
  key: string;
  tipo: "workshop" | "project";
  titulo: string;
  grupos: { id: string; nombre: string }[];
}

/** Cuántos de los que ya salieron se nombran en la zona proyectada. */
const SALIDOS_A_LA_VISTA = 5;

interface Props {
  courseId: string;
  courseName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Abrir ya sobre los presentes de esta sesión (desde Asistencia). Si la ronda
   * guardada era de otra fuente o sesión, empieza una nueva.
   */
  sesionInicial?: string | null;
}

/**
 * Ruleta del curso: elige al azar entre los estudiantes del curso, los
 * presentes en una sesión o los grupos de un taller o proyecto (por ejemplo,
 * el orden de una exposición). Lo que se proyecta —la rueda, el resultado, el
 * número de giro y quiénes ya salieron— puede ir a pantalla completa; la lista
 * de participantes queda afuera.
 *
 * El número de giro y «ya salieron» van A LA VISTA a propósito: el único truco
 * real con una ruleta es girar otra vez hasta que salga quien uno quiere, y eso
 * solo lo ataja que la clase vea cuántos giros hubo. Por eso no hay «deshacer».
 *
 * La ronda se guarda en `sessionStorage`: sobrevive a una recarga en clase,
 * pero no se arrastra a la semana siguiente como lo haría `localStorage`.
 * La ruleta no escribe nada en la base.
 */
export function RuletaDialog({ courseId, courseName, open, onOpenChange, sesionInicial }: Props) {
  const { t } = useTranslation();
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reintento, setReintento] = useState(0);
  const [estudiantes, setEstudiantes] = useState<Participante[]>([]);
  const [sesiones, setSesiones] = useState<Sesion[]>([]);
  const [actividades, setActividades] = useState<ActividadConGrupos[]>([]);

  const [fuente, setFuente] = useState<FuenteDeRuleta>("curso");
  const [sesionId, setSesionId] = useState("");
  const [actividadKey, setActividadKey] = useState("");
  /** null = cargando; `registros` = la sesión tiene asistencia tomada. */
  const [presentes, setPresentes] = useState<{ ids: Set<string>; registros: number } | null>(null);
  const [grupos, setGrupos] = useState<Participante[] | null>(null);

  const [desmarcados, setDesmarcados] = useState<Set<string>>(new Set());
  const [elegidos, setElegidos] = useState<Participante[]>([]);
  const [giros, setGiros] = useState(0);
  const [noRepetir, setNoRepetir] = useState(true);
  const [sinAnimacion, setSinAnimacion] = useState(false);
  const [busqueda, setBusqueda] = useState("");

  const [rotacion, setRotacion] = useState(0);
  const [girando, setGirando] = useState(false);
  /** Duración del giro en curso (0 = salta al resultado). */
  const [duracionGiro, setDuracionGiro] = useState(0);
  /** El último elegido mientras se muestra su resultado (sigue en la rueda). */
  const [mostrandoA, setMostrandoA] = useState<string | null>(null);
  const ganadorRef = useRef<Participante | null>(null);
  const temporizador = useRef<number | null>(null);
  const restaurado = useRef(false);
  const girarRef = useRef<HTMLButtonElement | null>(null);
  const clave = claveDeRonda(courseId);

  const { ref: proyeccionRef, isFullscreen, supported, toggle } = useFullscreen<HTMLDivElement>();

  // Post-montaje: leer el navegador en un initializer rompe la hidratación.
  useEffect(() => {
    try {
      setSinAnimacion(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    } catch {
      setSinAnimacion(false);
    }
  }, []);

  // ── Carga: estudiantes, sesiones y actividades con grupos ────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    restaurado.current = false;
    setCargando(true);
    setError(null);
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = supabase as any;
        const [enr, docentes, ses, wsAncla, wsUnion, pjAncla, pjUnion] = await Promise.all([
          db.from("course_enrollments").select("user_id").eq("course_id", courseId),
          db.from("course_teachers").select("user_id").eq("course_id", courseId),
          db
            .from("attendance_sessions")
            .select("id, session_date, title")
            .eq("course_id", courseId)
            .is("deleted_at", null)
            .order("session_date", { ascending: false })
            .limit(60),
          db.from("workshops").select("id, title").eq("course_id", courseId).is("deleted_at", null),
          db.from("workshop_courses").select("workshop_id").eq("course_id", courseId),
          db.from("projects").select("id, title").eq("course_id", courseId).is("deleted_at", null),
          db.from("project_courses").select("project_id").eq("course_id", courseId),
        ]);
        const primerError = [enr, docentes, ses, wsAncla, wsUnion, pjAncla, pjUnion].find(
          (r) => r.error,
        )?.error;
        if (primerError) throw primerError;

        // Quien dicta el curso no entra aunque esté matriculado (las cuentas del
        // dueño se matriculan para ver la vista del estudiante).
        const dictan = new Set(((docentes.data ?? []) as { user_id: string }[]).map((r) => r.user_id));
        const ids = Array.from(
          new Set(((enr.data ?? []) as { user_id: string }[]).map((r) => r.user_id)),
        ).filter((id) => !dictan.has(id));
        let lista: Participante[] = [];
        if (ids.length > 0) {
          const { data: profs, error: pErr } = await conPerfilOfrecible(
            db.from("profiles").select("id, full_name, institutional_email, estado").in("id", ids),
          );
          if (pErr) throw pErr;
          lista = (
            (profs ?? []) as {
              id: string;
              full_name: string | null;
              institutional_email: string | null;
              estado: string | null;
            }[]
          )
            .filter((p) => sigueCursando(p.estado))
            .map((p) => ({
              id: p.id,
              etiqueta: pareceIdentificador(p.full_name ?? "", p.institutional_email)
                ? t("ruleta.sinNombre")
                : (p.full_name ?? "").trim(),
            }))
            .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, "es"));
        }

        // Talleres y proyectos del curso (ancla + M:N), sin papelera, y sus grupos.
        const conTitulo = async (
          tabla: "workshops" | "projects",
          ancla: { id: string; title: string }[],
          extra: string[],
        ) => {
          const faltan = extra.filter((id) => !ancla.some((a) => a.id === id));
          if (faltan.length === 0) return ancla;
          const { data } = await db.from(tabla).select("id, title").in("id", faltan).is("deleted_at", null);
          return [...ancla, ...((data ?? []) as { id: string; title: string }[])];
        };
        const talleres = await conTitulo(
          "workshops",
          (wsAncla.data ?? []) as { id: string; title: string }[],
          ((wsUnion.data ?? []) as { workshop_id: string }[]).map((r) => r.workshop_id),
        );
        const proyectos = await conTitulo(
          "projects",
          (pjAncla.data ?? []) as { id: string; title: string }[],
          ((pjUnion.data ?? []) as { project_id: string }[]).map((r) => r.project_id),
        );
        const [gw, gp] = await Promise.all([
          talleres.length
            ? db.from("workshop_groups").select("id, name, workshop_id").in("workshop_id", talleres.map((w) => w.id))
            : Promise.resolve({ data: [] }),
          proyectos.length
            ? db.from("project_groups").select("id, name, project_id").in("project_id", proyectos.map((p) => p.id))
            : Promise.resolve({ data: [] }),
        ]);
        const porNombre = (a: { nombre: string }, b: { nombre: string }) =>
          a.nombre.localeCompare(b.nombre, "es", { numeric: true });
        const conGrupos: ActividadConGrupos[] = [
          ...talleres.map((w) => ({
            key: `workshop:${w.id}`,
            tipo: "workshop" as const,
            titulo: w.title,
            grupos: ((gw.data ?? []) as { id: string; name: string; workshop_id: string }[])
              .filter((g) => g.workshop_id === w.id)
              .map((g) => ({ id: g.id, nombre: g.name }))
              .sort(porNombre),
          })),
          ...proyectos.map((p) => ({
            key: `project:${p.id}`,
            tipo: "project" as const,
            titulo: p.title,
            grupos: ((gp.data ?? []) as { id: string; name: string; project_id: string }[])
              .filter((g) => g.project_id === p.id)
              .map((g) => ({ id: g.id, nombre: g.name }))
              .sort(porNombre),
          })),
        ].filter((a) => a.grupos.length > 0);

        const listaSesiones: Sesion[] = (
          (ses.data ?? []) as { id: string; session_date: string; title: string | null }[]
        ).map((s) => ({
          id: s.id,
          fecha: s.session_date,
          etiqueta: formatSessionLabel(s.session_date, s.title),
        }));

        if (cancelled) return;
        setEstudiantes(lista);
        setSesiones(listaSesiones);
        setActividades(conGrupos);

        // La ronda de esta pestaña, validada contra lo que se acaba de cargar.
        let guardada: RondaGuardada | null = null;
        try {
          guardada = leerRondaGuardada(sessionStorage.getItem(claveDeRonda(courseId)));
        } catch {
          guardada = null;
        }
        const hoy = todayLocalISO();
        const existeSesion = (id: string) => listaSesiones.some((s) => s.id === id);
        const existeActividad = (k: string) => conGrupos.some((a) => a.key === k);
        const sesionDefecto =
          listaSesiones.find((s) => s.fecha <= hoy)?.id ?? listaSesiones[0]?.id ?? "";

        let f: FuenteDeRuleta = guardada?.fuente ?? "curso";
        let sId = guardada?.sesionId && existeSesion(guardada.sesionId) ? guardada.sesionId : sesionDefecto;
        const aKey =
          guardada?.actividadKey && existeActividad(guardada.actividadKey)
            ? guardada.actividadKey
            : (conGrupos[0]?.key ?? "");
        if (f === "sesion" && listaSesiones.length === 0) f = "curso";
        if (f === "grupos" && conGrupos.length === 0) f = "curso";
        let conservarRonda = !!guardada && f === guardada.fuente;
        if (f === "sesion" && guardada?.sesionId !== sId) conservarRonda = false;
        if (f === "grupos" && guardada?.actividadKey !== aKey) conservarRonda = false;
        // Desde Asistencia se abre sobre ESA sesión.
        if (sesionInicial && existeSesion(sesionInicial)) {
          if (!(f === "sesion" && sId === sesionInicial)) conservarRonda = false;
          f = "sesion";
          sId = sesionInicial;
        }

        setFuente(f);
        setSesionId(sId);
        setActividadKey(aKey);
        setMostrandoA(null);
        if (conservarRonda && guardada) {
          setDesmarcados(new Set(guardada.desmarcados));
          setElegidos(guardada.elegidos);
          setGiros(guardada.giros);
          setNoRepetir(guardada.noRepetir);
        } else {
          setDesmarcados(new Set());
          setElegidos([]);
          setGiros(0);
        }
        restaurado.current = true;
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setCargando(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` y `sesionInicial` se leen al abrir; no deben recargar la ruleta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, courseId, reintento]);

  // Presentes de la sesión elegida («tarde» cuenta como que vino; una ausencia
  // justificada no está en el salón).
  useEffect(() => {
    setPresentes(null);
    if (!open || fuente !== "sesion" || !sesionId) return;
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: e } = await (supabase as any)
        .from("attendance_records")
        .select("user_id, status")
        .eq("session_id", sesionId);
      if (cancelled) return;
      if (e) {
        toast.error(friendlyError(e));
        setPresentes({ ids: new Set(), registros: 0 });
        return;
      }
      const filas = (data ?? []) as { user_id: string; status: string }[];
      setPresentes({
        ids: new Set(filas.filter((r) => countsAsPresent(r.status)).map((r) => r.user_id)),
        registros: filas.length,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, fuente, sesionId]);

  // Grupos (con sus integrantes) de la actividad elegida.
  useEffect(() => {
    setGrupos(null);
    const act = actividades.find((a) => a.key === actividadKey);
    if (!open || fuente !== "grupos" || !act) return;
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      const tabla = act.tipo === "workshop" ? "workshop_group_members" : "project_group_members";
      const { data, error: e } = await db
        .from(tabla)
        .select("group_id, user_id")
        .in("group_id", act.grupos.map((g) => g.id));
      if (cancelled) return;
      if (e) toast.error(friendlyError(e));
      const miembros = (data ?? []) as { group_id: string; user_id: string }[];
      const nombre = new Map(estudiantes.map((s) => [s.id, s.etiqueta]));
      // Solo para poner nombre: no filtra cuentas (eso es elegibilidad, y acá
      // el que se sortea es el GRUPO).
      const faltan = [...new Set(miembros.map((m) => m.user_id))].filter((id) => !nombre.has(id));
      if (faltan.length > 0) {
        const { data: profs } = await db
          .from("profiles")
          .select("id, full_name, institutional_email")
          .in("id", faltan);
        for (const p of (profs ?? []) as {
          id: string;
          full_name: string | null;
          institutional_email: string | null;
        }[]) {
          nombre.set(
            p.id,
            pareceIdentificador(p.full_name ?? "", p.institutional_email)
              ? t("ruleta.sinNombre")
              : (p.full_name ?? "").trim(),
          );
        }
      }
      if (cancelled) return;
      setGrupos(
        act.grupos.map((g) => {
          const nombres = miembros
            .filter((m) => m.group_id === g.id)
            .map((m) => nombre.get(m.user_id) ?? t("ruleta.sinNombre"))
            .sort((a, b) => a.localeCompare(b, "es"));
          return {
            id: g.id,
            etiqueta: g.nombre,
            detalle:
              nombres.length > 0
                ? t("gradingGroups.members", { count: nombres.length, names: nombres.join(", ") })
                : t("ruleta.sinIntegrantes"),
          };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, fuente, actividadKey, actividades, estudiantes, t]);

  // Guardar la ronda (solo después de restaurarla: si no, el primer render la pisaría).
  useEffect(() => {
    if (!restaurado.current) return;
    try {
      const g: RondaGuardada = {
        fuente,
        sesionId,
        actividadKey,
        desmarcados: [...desmarcados],
        elegidos,
        noRepetir,
        giros,
      };
      sessionStorage.setItem(clave, JSON.stringify(g));
    } catch {
      /* navegación privada o almacenamiento lleno: la ruleta funciona igual */
    }
  }, [clave, fuente, sesionId, actividadKey, desmarcados, elegidos, noRepetir, giros]);

  useEffect(
    () => () => {
      if (temporizador.current != null) window.clearTimeout(temporizador.current);
    },
    [],
  );

  // El foco arranca en «Girar»: si quedara en la X, la barra espaciadora cerraría la ruleta.
  useEffect(() => {
    if (open && !cargando && !error) {
      const id = window.setTimeout(() => girarRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open, cargando, error]);

  // ── Quiénes participan y quiénes están en la rueda ───────────────────
  const base: Participante[] = useMemo(() => {
    if (fuente === "curso") return estudiantes;
    if (fuente === "sesion") return presentes ? estudiantes.filter((s) => presentes.ids.has(s.id)) : [];
    return grupos ?? [];
  }, [fuente, estudiantes, presentes, grupos]);

  const idsElegidos = useMemo(() => elegidos.map((e) => e.id), [elegidos]);
  const rueda = useMemo(
    () => enLaRueda(base, desmarcados, idsElegidos, { noRepetir, mostrandoA }),
    [base, desmarcados, idsElegidos, noRepetir, mostrandoA],
  );
  /** Los que entran en el PRÓXIMO giro (sin el último, si no se repite). */
  const proximos = useMemo(
    () => enLaRueda(base, desmarcados, idsElegidos, { noRepetir, mostrandoA: null }),
    [base, desmarcados, idsElegidos, noRepetir],
  );
  const resultado = mostrandoA ? (elegidos[elegidos.length - 1] ?? null) : null;
  const visibles = useMemo(
    () => (busqueda.trim() ? base.filter((p) => matchesQuery(p.etiqueta, busqueda)) : base),
    [base, busqueda],
  );
  const yaSalio = useMemo(() => new Set(idsElegidos), [idsElegidos]);
  const cargandoFuente =
    (fuente === "sesion" && !!sesionId && presentes === null) ||
    (fuente === "grupos" && !!actividadKey && grupos === null);
  const todosSalieron = !girando && base.length > 0 && proximos.length === 0 && elegidos.length > 0;

  /** Otra fuente o selección: otra ronda (los ids de la anterior no aplican). */
  const nuevaRonda = () => {
    setDesmarcados(new Set());
    setElegidos([]);
    setGiros(0);
    setMostrandoA(null);
    setBusqueda("");
  };

  const girar = () => {
    if (girando || cargandoFuente) return;
    const lista = proximos;
    if (lista.length === 0) return;
    const i = elegirIndice(lista.length);
    ganadorRef.current = lista[i];
    // Con uno solo no hay azar que mostrar: girar teatralizaría señalarlo.
    const animar = !sinAnimacion && lista.length > 1;
    const duracion = animar ? 4800 : 0;
    setMostrandoA(null);
    setDuracionGiro(duracion);
    setGirando(true);
    setGiros((n) => n + 1);
    setRotacion((r) => rotacionParaCaerEn(r, i, lista.length, animar ? 7 : 0, azarCripto()));
    temporizador.current = window.setTimeout(
      () => {
        temporizador.current = null;
        const g = ganadorRef.current;
        setGirando(false);
        if (g) {
          setElegidos((prev) => [...prev, g]);
          setMostrandoA(g.id);
        }
      },
      animar ? duracion + 80 : 300,
    );
  };

  const reiniciar = () => {
    nuevaRonda();
    toast.success(t("ruleta.reiniciada"));
  };

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(textoDeElegidos(elegidos));
      toast.success(t("ruleta.copiada"));
    } catch {
      toast.error(t("ruleta.noSePudoCopiar"));
    }
  };

  const alternar = (id: string) =>
    setDesmarcados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Marcar o desmarcar a los que se VEN (con el buscador puesto, solo esos). */
  const marcarVisibles = (incluir: boolean) =>
    setDesmarcados((prev) => {
      const next = new Set(prev);
      for (const p of visibles) {
        if (incluir) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });

  const alternarPantalla = () => {
    toggle();
    // El botón de pantalla completa se queda con el foco y la barra espaciadora
    // lo volvería a accionar: se devuelve a «Girar».
    window.setTimeout(() => girarRef.current?.focus(), 50);
  };

  /** Barra espaciadora = girar, salvo que el foco esté en un control que la use. */
  const alTeclear = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== " " && e.code !== "Space") return;
    const enControl = (e.target as HTMLElement | null)?.closest?.(
      "input, textarea, select, button, [role=checkbox], [role=combobox], [role=option], [contenteditable=true]",
    );
    if (enControl) return;
    e.preventDefault();
    girar();
  };

  const salidos = elegidos.slice(-SALIDOS_A_LA_VISTA).map((e) => e.etiqueta);
  const salidosOcultos = Math.max(0, elegidos.length - SALIDOS_A_LA_VISTA);

  const contenido = () => {
    if (cargando) return <SectionLoader />;
    if (error)
      return (
        <ErrorState
          message={t("ruleta.errorCarga")}
          hint={error}
          onRetry={() => setReintento((n) => n + 1)}
        />
      );
    if (estudiantes.length === 0 && actividades.length === 0)
      return (
        <EmptyState
          icon={Users}
          title={t("ruleta.sinEstudiantes")}
          hint={t("ruleta.sinEstudiantesHint")}
        />
      );
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
        {/* Lo que se proyecta: la rueda, el resultado, el giro y quiénes salieron. */}
        <div
          ref={proyeccionRef}
          className={cn(
            "relative flex flex-col items-center gap-3 rounded-md pb-10",
            isFullscreen && "justify-center bg-background p-6",
          )}
        >
          {giros > 0 && (
            <Badge variant="outline" className="tabular-nums">
              {t("ruleta.giro", { n: giros })}
            </Badge>
          )}
          <RuedaSvg
            participantes={rueda}
            rotacion={rotacion}
            duracionMs={girando ? duracionGiro : 0}
            ariaLabel={t("ruleta.ruedaAria", { count: rueda.length })}
            onClick={girar}
            deshabilitada={rueda.length === 0}
            className={isFullscreen ? "max-w-[min(70dvh,90vw)]" : "max-w-[26rem]"}
          />
          {/* Los botones van ANTES del resultado: si fueran después, el texto que
              aparece los correría y un segundo clic caería en otro lado. */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              ref={girarRef}
              onClick={girar}
              aria-disabled={girando || cargandoFuente}
              aria-busy={girando}
              disabled={!girando && proximos.length === 0}
              className={cn(girando && "cursor-wait opacity-70")}
            >
              <LoaderPinwheel
                className={cn("h-4 w-4 mr-1.5", girando && "animate-spin motion-reduce:animate-none")}
              />
              {girando ? t("ruleta.girando") : t("ruleta.girar")}
            </Button>
            {todosSalieron && (
              <Button variant="outline" onClick={reiniciar}>
                <RotateCcw className="h-4 w-4 mr-1.5" />
                {t("ruleta.reiniciar")}
              </Button>
            )}
          </div>
          <div role="status" aria-live="polite" aria-atomic="true" className="min-h-16 w-full text-center">
            {girando ? (
              <p className="text-sm text-muted-foreground">{t("ruleta.girando")}</p>
            ) : resultado ? (
              <div className="space-y-1">
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("ruleta.salio")}
                </p>
                <p
                  className={cn(
                    "font-semibold break-words",
                    isFullscreen ? "text-2xl md:text-3xl" : "text-xl",
                  )}
                >
                  {resultado.etiqueta}
                </p>
                {resultado.detalle && (
                  <p className="text-xs text-muted-foreground break-words">{resultado.detalle}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {todosSalieron
                  ? t("ruleta.todosSalieron")
                  : proximos.length > 0
                    ? t("ruleta.quedan", { count: proximos.length })
                    : t("ruleta.ninguno")}
              </p>
            )}
          </div>
          {elegidos.length > 0 && (
            <p className="max-w-full text-center text-2xs text-muted-foreground break-words">
              {salidosOcultos > 0
                ? t("ruleta.yaSalieronYMas", { names: salidos.join(", "), count: salidosOcultos })
                : t("ruleta.yaSalieron", { names: salidos.join(", ") })}
            </p>
          )}
          {!isFullscreen && (
            <p className="text-center text-2xs text-muted-foreground">{t("ruleta.atajo")}</p>
          )}
          {supported && (
            <FullscreenButton floating isFullscreen={isFullscreen} onToggle={alternarPantalla} />
          )}
        </div>

        {/* El panel del docente: entre quiénes, a quién se saca, quiénes salieron. */}
        <div className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <Label>{t("ruleta.fuenteLabel")}</Label>
            <Select
              value={fuente}
              onValueChange={(v) => {
                setFuente(v as FuenteDeRuleta);
                nuevaRonda();
              }}
              disabled={girando}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="curso">{t("ruleta.fuenteCurso")}</SelectItem>
                <SelectItem value="sesion" disabled={sesiones.length === 0}>
                  {t("ruleta.fuenteSesion")}
                </SelectItem>
                <SelectItem value="grupos" disabled={actividades.length === 0}>
                  {t("ruleta.fuenteGrupos")}
                </SelectItem>
              </SelectContent>
            </Select>
            {sesiones.length === 0 && (
              <p className="text-2xs text-muted-foreground">{t("ruleta.sinSesiones")}</p>
            )}
            {actividades.length === 0 && (
              <p className="text-2xs text-muted-foreground">{t("ruleta.sinGrupos")}</p>
            )}
            {fuente === "sesion" && (
              <Select
                value={sesionId}
                onValueChange={(v) => {
                  setSesionId(v);
                  nuevaRonda();
                }}
                disabled={girando}
              >
                <SelectTrigger className="h-9" aria-label={t("ruleta.sesionPlaceholder")}>
                  <SelectValue placeholder={t("ruleta.sesionPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {sesiones.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.etiqueta}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {/* «Sin registro» no es «ausente»: si no se tomó asistencia, se dice eso. */}
            {fuente === "sesion" && presentes && presentes.registros === 0 && (
              <p className="text-2xs text-muted-foreground">{t("ruleta.sesionSinAsistencia")}</p>
            )}
            {fuente === "sesion" && presentes && presentes.registros > 0 && presentes.ids.size === 0 && (
              <p className="text-2xs text-muted-foreground">{t("ruleta.sesionSinPresentes")}</p>
            )}
            {fuente === "grupos" && (
              <Select
                value={actividadKey}
                onValueChange={(v) => {
                  setActividadKey(v);
                  nuevaRonda();
                }}
                disabled={girando}
              >
                <SelectTrigger className="h-9" aria-label={t("ruleta.actividadPlaceholder")}>
                  <SelectValue placeholder={t("ruleta.actividadPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {actividades.map((a) => (
                    <SelectItem key={a.key} value={a.key}>
                      {a.tipo === "workshop"
                        ? t("ruleta.actividadTaller", { title: a.titulo })
                        : t("ruleta.actividadProyecto", { title: a.titulo })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <label className="flex min-h-8 cursor-pointer items-start gap-2 text-xs">
              <Checkbox
                checked={noRepetir}
                onCheckedChange={(v) => setNoRepetir(v === true)}
                disabled={girando}
                className="mt-0.5"
              />
              <span>{t("ruleta.noRepetir")}</span>
            </label>
            <label className="flex min-h-8 cursor-pointer items-start gap-2 text-xs">
              <Checkbox
                checked={sinAnimacion}
                onCheckedChange={(v) => setSinAnimacion(v === true)}
                disabled={girando}
                className="mt-0.5"
              />
              <span>{t("ruleta.sinAnimacion")}</span>
            </label>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>{t("ruleta.participantes")}</Label>
              <span className="text-2xs text-muted-foreground tabular-nums">
                {t("ruleta.enRueda", { count: proximos.length, total: base.length })}
              </span>
            </div>
            <SearchInput
              value={busqueda}
              onChange={setBusqueda}
              placeholder={t("ruleta.buscar")}
              maxWidthClass="max-w-none"
            />
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-2xs"
                disabled={girando}
                onClick={() => marcarVisibles(true)}
              >
                {t("common.selectAll")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-2xs"
                disabled={girando}
                onClick={() => marcarVisibles(false)}
              >
                {t("common.deselectAll")}
              </Button>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border p-1">
              {cargandoFuente ? (
                <SectionLoader className="p-3" />
              ) : visibles.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground italic">{t("ruleta.nadieCoincide")}</p>
              ) : (
                visibles.map((p) => (
                  <label
                    key={p.id}
                    className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent"
                  >
                    <Checkbox
                      checked={!desmarcados.has(p.id)}
                      onCheckedChange={() => alternar(p.id)}
                      disabled={girando}
                    />
                    <span className="min-w-0 flex-1 truncate" title={p.etiqueta}>
                      {p.etiqueta}
                    </span>
                    {yaSalio.has(p.id) && (
                      <Badge variant="secondary" className="shrink-0 text-3xs">
                        {t("ruleta.yaSalio")}
                      </Badge>
                    )}
                  </label>
                ))
              )}
            </div>
            <p className="text-2xs text-muted-foreground">{t("ruleta.participantesHint")}</p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>{t("ruleta.elegidos", { count: elegidos.length })}</Label>
              <div className="flex items-center gap-1">
                <RowAction
                  label={t("ruleta.copiar")}
                  icon={Copy}
                  onClick={() => void copiar()}
                  disabled={elegidos.length === 0}
                />
                <RowAction
                  label={t("ruleta.reiniciarTitle")}
                  icon={RotateCcw}
                  onClick={reiniciar}
                  disabled={girando || (elegidos.length === 0 && desmarcados.size === 0 && giros === 0)}
                />
              </div>
            </div>
            {elegidos.length === 0 ? (
              <p className="text-2xs text-muted-foreground">{t("ruleta.sinElegidos")}</p>
            ) : (
              <ol className="max-h-40 list-inside list-decimal space-y-0.5 overflow-y-auto rounded-md border p-2 text-xs">
                {elegidos.map((e, i) => (
                  <li key={`${e.id}-${i}`} className="truncate" title={e.etiqueta}>
                    {e.etiqueta}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[92dvh] overflow-y-auto"
        onKeyDown={alTeclear}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LoaderPinwheel className="h-5 w-5 text-primary shrink-0" />
            <span className="truncate">{t("ruleta.titulo", { course: courseName })}</span>
          </DialogTitle>
          <DialogDescription>{t("ruleta.descripcion")}</DialogDescription>
        </DialogHeader>
        {contenido()}
      </DialogContent>
    </Dialog>
  );
}
