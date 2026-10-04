/**
 * Editor de grupos para un taller (modo teacher_assigned).
 *
 * Soporta drag & drop nativo (HTML5) para mover estudiantes:
 *   - desde "sin grupo" hacia un grupo
 *   - entre grupos
 *   - desde un grupo de vuelta a "sin grupo"
 *
 * Modo mixto: en el mismo taller pueden coexistir estudiantes con
 * grupo (entregan en grupo) y sin grupo (entregan individual). El
 * trigger de DB sigue garantizando que cada user esté en MÁXIMO un
 * grupo del taller.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Trash2,
  GripVertical,
  Users,
  ArrowRightLeft,
  Check,
  Shuffle,
  ImageUp,
} from "lucide-react";
import { GruposDesdeImagenDialog } from "./GruposDesdeImagenDialog";
import { filtrarTablero } from "./buscar-en-grupos";
import { SearchInput } from "@/components/ui/search-input";
import {
  GuardarNotasDeGrupos,
  NotaDeGrupoInline,
  useNotasDeGrupos,
  type GrupoACalificar,
} from "@/modules/grading/NotaDeGrupoInline";
import {
  useCalificarGrupo,
  type IntegranteACalificar,
  type NotaGuardada,
} from "@/modules/grading/use-calificar-grupo";
import { formatNumber } from "@/shared/lib/format";
import { Spinner } from "@/components/ui/spinner";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  fueraDeRango,
  nombreDeGrupo,
  repartirAlAzar,
  tamanosEquilibrados,
} from "@/modules/workshops/reparto-grupos";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Student = { id: string; full_name: string; institutional_email: string };
type Group = { id: string; name: string; signup_code: string };
type Member = { group_id: string; user_id: string };
/** Nota externa ya guardada de un estudiante (su fila individual). */
type NotaExterna = { submissionId: string | null; grade: number | null; feedback: string };

interface Props {
  workshopId: string;
  courseId: string;
}

const UNASSIGNED = "__unassigned__";

/** «Grupo 2» antes que «Grupo 10»: el orden de la base es alfabético puro. */
const ordenarGrupos = (gs: Group[]) =>
  [...gs].sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }));

export function WorkshopGroupsEditor({ workshopId, courseId }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [students, setStudents] = useState<Student[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [newGroupName, setNewGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [draggingUserId, setDraggingUserId] = useState<string | null>(null);
  // ── Panel de reparto al azar ──
  const [azarAbierto, setAzarAbierto] = useState(false);
  /** Quiénes ENTRAN al reparto. Se destilda a quien no vino a la sesión. */
  const [incluidos, setIncluidos] = useState<Set<string>>(new Set());
  const [modo, setModo] = useState<"tamano" | "cantidad">("tamano");
  const [valor, setValor] = useState<number>(4);
  const [reemplazar, setReemplazar] = useState(true);
  const [repartiendo, setRepartiendo] = useState(false);
  /** Grupos del taller con entrega ya asociada: no se pueden borrar sin perderla. */
  const [gruposConEntrega, setGruposConEntrega] = useState<Set<string>>(new Set());
  /** Quién ya entregó individual: la base no lo deja pasar a un grupo. */
  const [conEntregaIndividual, setConEntregaIndividual] = useState<Set<string>>(new Set());
  const [imagenAbierta, setImagenAbierta] = useState(false);
  /**
   * Tamaños que declaró el taller (`group_size_min` / `group_size_max`).
   *
   * Los lee el editor y no los recibe por prop: existían en la base con valores
   * puestos —los talleres reales dicen 2 y 5— y NADA en la interfaz los leía, así
   * que se podía armar un grupo de una persona o de doce sin ningún aviso.
   * Leerlos acá deja una sola fuente y no obliga a que cada pantalla que abra
   * este editor los sume a su propia query.
   */
  const [groupSizeMin, setGroupSizeMin] = useState<number | null>(null);
  const [groupSizeMax, setGroupSizeMax] = useState<number | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  /** Solo decide qué tarjetas se ven: no mueve a nadie (ver buscar-en-grupos.ts). */
  const [busqueda, setBusqueda] = useState("");
  /**
   * Taller EXTERNO (la exposición): cada grupo se puede calificar desde su
   * tarjeta, opcionalmente, mientras se arma. En uno en línea no: la nota del
   * grupo es la de su entrega y se pone en «Calificar».
   */
  const [esExterno, setEsExterno] = useState(false);
  /** Las notas externas van en la escala del curso. */
  const [escala, setEscala] = useState(5);
  const [notas, setNotas] = useState<Map<string, NotaExterna>>(new Map());
  const { calificar, guardando: guardandoNota } = useCalificarGrupo("workshop", workshopId);
  const notasGrupos = useNotasDeGrupos(calificar, escala);

  /**
   * Cambiar un grupo NO recarga la pantalla. Antes cada movimiento hacía
   * `await load()`, y `load` ponía el spinner en lugar de las columnas: la
   * pantalla parpadeaba, el scroll saltaba al principio y, además, «Repartir al
   * azar» volvía a incluir a los que el docente había destildado. Ahora los
   * cambios se aplican en el estado en el acto (optimista) y la base se escribe
   * detrás; solo se relee —sin spinner— después de operaciones en lote.
   */
  const primeraCarga = useRef(true);
  const idsCargados = useRef<Set<string>>(new Set());
  /** Serializa las escrituras: dos movimientos rápidos no se pisan en la base. */
  const cola = useRef<Promise<void>>(Promise.resolve());
  const encolar = (tarea: () => Promise<void>) => {
    cola.current = cola.current.then(tarea, tarea);
    return cola.current;
  };

  const load = useCallback(async (opts?: { silencioso?: boolean }) => {
    const silencioso = opts?.silencioso === true && !primeraCarga.current;
    if (!silencioso) setLoading(true);
    try {
      // Matrícula de TODOS los cursos del taller (workshop_courses M:N), no solo
      // el curso ancla: un taller compartido a un curso secundario debe permitir
      // agrupar también a los alumnos de ese curso (si no, quedaban forzados a
      // entrega individual). Fallback a [courseId] si no hay filas M:N.
      const { data: wcRows } = await db
        .from("workshop_courses")
        .select("course_id")
        .eq("workshop_id", workshopId);
      // Un curso de la unión que está en la papelera no aporta estudiantes.
      const otros = Array.from(
        new Set(((wcRows ?? []) as { course_id: string }[]).map((r) => r.course_id)),
      ).filter((id) => id !== courseId);
      let vigentes: string[] = [];
      if (otros.length > 0) {
        const { data: cs } = await supabase
          .from("courses")
          .select("id")
          .in("id", otros)
          .is("deleted_at", null);
        vigentes = ((cs ?? []) as { id: string }[]).map((c) => c.id);
      }
      const courseIds = [courseId, ...vigentes];
      const { data: enr } = await supabase
        .from("course_enrollments")
        .select("user_id")
        .in("course_id", courseIds);
      const userIds = Array.from(
        new Set((enr ?? []).map((e: { user_id: string }) => e.user_id)),
      );
      let profs: Student[] = [];
      if (userIds.length > 0) {
        const { data } = await supabase
          .from("profiles")
          .select("id, full_name, institutional_email")
          // Este array tambien alimenta «Repartir al azar» y la lectura de grupos
          // desde una imagen: una cuenta eliminada aca se volveria candidata de
          // emparejamiento sin que nadie lo note.
          .is("deleted_at", null)
          .not("is_active", "is", false)
          .in("id", userIds);
        profs = ((data ?? []) as Student[]).sort((a, b) =>
          a.full_name.localeCompare(b.full_name),
        );
      }
      const { data: wsRow } = await db
        .from("workshops")
        .select("group_size_min, group_size_max, is_external")
        .eq("id", workshopId)
        .maybeSingle();
      setGroupSizeMin((wsRow as { group_size_min?: number | null } | null)?.group_size_min ?? null);
      setGroupSizeMax((wsRow as { group_size_max?: number | null } | null)?.group_size_max ?? null);
      const externo = (wsRow as { is_external?: boolean | null } | null)?.is_external === true;
      setEsExterno(externo);
      if (externo) {
        const { data: curso } = await supabase
          .from("courses")
          .select("grade_scale_max")
          .eq("id", courseId)
          .maybeSingle();
        const max = Number((curso as { grade_scale_max?: number } | null)?.grade_scale_max);
        setEscala(Number.isFinite(max) && max > 0 ? max : 5);
      }

      setStudents(profs);
      // Todos incluidos por defecto: el caso normal es "vino el curso". Destildar
      // es la excepción (quien faltó a la sesión donde se reparte el taller). Al
      // releer se CONSERVA lo destildado y solo entra quien aparece por primera vez.
      const actuales = new Set(profs.map((x) => x.id));
      if (!silencioso) {
        setIncluidos(new Set(actuales));
      } else {
        const antes = idsCargados.current;
        setIncluidos((prev) => {
          const next = new Set([...prev].filter((id) => actuales.has(id)));
          for (const id of actuales) if (!antes.has(id)) next.add(id);
          return next;
        });
      }
      idsCargados.current = actuales;

      const { data: gs } = await db
        .from("workshop_groups")
        .select("id, name, signup_code")
        .eq("workshop_id", workshopId)
        .order("name");
      setGroups(ordenarGrupos((gs ?? []) as Group[]));

      const groupIds = ((gs ?? []) as Group[]).map((g) => g.id);
      if (groupIds.length > 0) {
        const { data: ms } = await db
          .from("workshop_group_members")
          .select("group_id, user_id")
          .in("group_id", groupIds);
        setMembers((ms ?? []) as Member[]);

        // Qué grupos ya tienen una entrega colgada. Importa porque el FK de
        // `workshop_submissions.group_id` es ON DELETE SET NULL: borrar ese grupo
        // NO borra la entrega, la deja sin grupo — y una entrega sin grupo el
        // sistema la lee como INDIVIDUAL, del último que la editó. O sea que
        // "rehacer los grupos" podría convertir el trabajo de cuatro personas en
        // el de una sola, en silencio. Por eso se detecta y se bloquea.
        const { data: subs } = await db
          .from("workshop_submissions")
          .select("group_id")
          .in("group_id", groupIds)
          .not("group_id", "is", null);
        setGruposConEntrega(
          new Set(((subs ?? []) as { group_id: string }[]).map((x) => x.group_id)),
        );
      } else {
        setMembers([]);
        setGruposConEntrega(new Set());
      }

      // Quién ya entregó POR SU CUENTA (sin grupo). Es imprescindible para armar
      // grupos en lote: `tg_block_ws_group_member_with_individual` (mig 20261068000000)
      // rechaza con P0001 meter a esa persona en un grupo, y ese rechazo hace fallar el
      // INSERT del LOTE ENTERO — el docente vería "no se pudo" sin poder deducir a
      // quién tiene que sacar de la lista.
      const { data: indiv } = await db
        .from("workshop_submissions")
        .select("id, user_id, final_grade, teacher_feedback")
        .eq("workshop_id", workshopId)
        .is("group_id", null);
      const filasIndiv = (indiv ?? []) as {
        id: string;
        user_id: string;
        final_grade: number | null;
        teacher_feedback: string | null;
      }[];
      // En un taller EXTERNO esas filas son la NOTA que escribió el docente, no
      // una entrega: no le impiden a nadie entrar a un grupo (mig
      // 20262700000000), así que no se bloquean acá.
      setConEntregaIndividual(externo ? new Set() : new Set(filasIndiv.map((x) => x.user_id)));
      setNotas(
        externo
          ? new Map(
              filasIndiv.map((x) => [
                x.user_id,
                {
                  submissionId: x.id,
                  grade: x.final_grade != null ? Number(x.final_grade) : null,
                  feedback: x.teacher_feedback ?? "",
                },
              ]),
            )
          : new Map(),
      );
    } finally {
      primeraCarga.current = false;
      setLoading(false);
    }
  }, [workshopId, courseId]);

  useEffect(() => {
    // Otro taller = carga completa, con spinner y con todos incluidos.
    primeraCarga.current = true;
    void load();
  }, [load]);

  // La búsqueda es de ESTE taller: abrir el de otro curso con un nombre ya
  // escrito mostraría un tablero filtrado sin que el docente sepa por qué.
  useEffect(() => {
    setBusqueda("");
  }, [workshopId]);

  const memberByUser = useMemo(() => {
    const m = new Map<string, string>(); // user_id -> group_id
    for (const x of members) m.set(x.user_id, x.group_id);
    return m;
  }, [members]);

  const studentsByGroup = useMemo(() => {
    const m = new Map<string, Student[]>();
    for (const g of groups) m.set(g.id, []);
    for (const s of students) {
      const gid = memberByUser.get(s.id);
      if (gid) m.get(gid)?.push(s);
    }
    return m;
  }, [students, groups, memberByUser]);

  const unassigned = useMemo(
    () => students.filter((s) => !memberByUser.has(s.id)),
    [students, memberByUser],
  );

  const tablero = useMemo(
    () => filtrarTablero(unassigned, studentsByGroup, groups, busqueda),
    [unassigned, studentsByGroup, groups, busqueda],
  );

  /** Los integrantes de un grupo con su nota externa, para calificarlo entero. */
  const integrantesConNota = (g: Group, ms: Student[]): IntegranteACalificar[] =>
    ms.map((st) => {
      const n = notas.get(st.id);
      return {
        userId: st.id,
        fullName: st.full_name,
        grupoId: g.id,
        grupoNombre: g.name,
        grade: n?.grade ?? null,
        feedback: n?.feedback ?? "",
        originalGrade: n?.grade ?? null,
        originalFeedback: n?.feedback ?? "",
        submissionId: n?.submissionId ?? null,
      };
    });

  const notaGuardada = (userId: string, n: NotaGuardada) =>
    setNotas((prev) =>
      new Map(prev).set(userId, {
        submissionId: n.submissionId ?? prev.get(userId)?.submissionId ?? null,
        grade: n.grade,
        feedback: n.feedback,
      }),
    );

  /** Los grupos con integrantes, para «Guardar todas las notas». */
  const gruposACalificar: GrupoACalificar[] = groups
    .map((g) => ({
      grupoId: g.id,
      nombre: g.name,
      integrantes: integrantesConNota(g, studentsByGroup.get(g.id) ?? []),
    }))
    .filter((g) => g.integrantes.length > 0);
  const notasSinGuardar = esExterno ? notasGrupos.pendientes(gruposACalificar).length : 0;

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) {
      toast.error(
        i18n.t("toast.modules_workshops_WorkshopGroupsEditor.groupNameRequired", {
          defaultValue: "Ponle un nombre al grupo",
        }),
      );
      return;
    }
    setCreating(true);
    try {
      const { data: creado, error } = await db
        .from("workshop_groups")
        .insert({ workshop_id: workshopId, name })
        .select("id, name, signup_code")
        .single();
      if (error || !creado) {
        toast.error(friendlyError(error));
        return;
      }
      setNewGroupName("");
      setGroups((prev) => ordenarGrupos([...prev, creado as Group]));
    } finally {
      setCreating(false);
    }
  };

  // ── Reparto al azar ───────────────────────────────────────────────────
  /**
   * Cuántos grupos van a salir. Derivado y DETERMINISTA: la previsualización no
   * puede re-sortear en cada render, porque el docente vería los tamaños
   * cambiando solos mientras decide. El azar entra recién al aplicar.
   */
  const cuantosGrupos =
    modo === "cantidad"
      ? Math.max(1, Math.floor(valor) || 1)
      : Math.ceil(incluidos.size / Math.max(1, Math.floor(valor) || 1));

  const tamanosPrevios = tamanosEquilibrados(incluidos.size, cuantosGrupos);

  /** Los que se saldrían del rango declarado por el taller, para avisar ANTES. */
  const avisosDeRango = fueraDeRango(
    tamanosPrevios.map((n, i) => ({
      nombre: nombreDeGrupo(i + 1),
      integrantes: Array.from({ length: n }, (_, k) => `x${k}`),
    })),
    groupSizeMin,
    groupSizeMax,
  );

  const puedeReemplazar = groups.length > 0 && gruposConEntrega.size === 0;

  const alternarIncluido = (userId: string) => {
    setIncluidos((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  /**
   * Arma los grupos y los escribe. El orden importa:
   *   1. Si se reemplaza, se borran los grupos viejos (el cascade se lleva sus
   *      miembros). Solo se ofrece cuando ninguno tiene entrega.
   *   2. Si NO se reemplaza, se libera a los incluidos de su grupo actual: un
   *      trigger impide estar en dos grupos del mismo taller, así que el INSERT
   *      solo no alcanza.
   *   3. Se crean los grupos y se insertan los miembros en lote.
   *
   * Si algo falla a mitad NO se deshace lo anterior: no hay transacción desde el
   * cliente. Se recarga igual, así el docente ve el estado REAL y puede repetir —
   * el reparto es idempotente en el sentido que importa (volver a repartir vuelve
   * a armar todo), y mentirle sobre el estado sería peor.
   */
  const repartir = async () => {
    const ids = [...incluidos];
    if (ids.length === 0) {
      toast.error(t("hc_modulesWorkshopsWorkshopGroupsEditor.randomNobody"));
      return;
    }
    // Cuando se reemplaza, los grupos viejos se borran primero, así que ningún
    // nombre está tomado. Cuando NO, hay que saltarlos: `workshop_groups` tiene
    // `UNIQUE (workshop_id, name)` y un choque hace fallar el INSERT ENTERO —
    // no se crearía ni un grupo.
    const vaAReemplazar = reemplazar && puedeReemplazar;
    const propuesta = repartirAlAzar(ids, {
      ...(modo === "cantidad" ? { cantidad: cuantosGrupos } : { tamano: Math.floor(valor) || 1 }),
      nombresTomados: vaAReemplazar ? [] : groups.map((g) => g.name),
    });
    if (propuesta.length === 0) return;

    const excluidos = students.length - ids.length;
    const ok = await confirm({
      title: t("hc_modulesWorkshopsWorkshopGroupsEditor.randomConfirmTitle", {
        count: propuesta.length,
      }),
      description: [
        t("hc_modulesWorkshopsWorkshopGroupsEditor.randomConfirmBody", { count: ids.length }),
        excluidos > 0
          ? t("hc_modulesWorkshopsWorkshopGroupsEditor.randomConfirmExcluded", { count: excluidos })
          : "",
        vaAReemplazar
          ? t("hc_modulesWorkshopsWorkshopGroupsEditor.randomConfirmReplace", {
              count: groups.length,
            })
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      confirmLabel: t("hc_modulesWorkshopsWorkshopGroupsEditor.randomConfirmLabel"),
      tone: "warning",
    });
    if (!ok) return;

    setRepartiendo(true);
    try {
      if (vaAReemplazar) {
        const { error } = await db
          .from("workshop_groups")
          .delete()
          .eq("workshop_id", workshopId);
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
      } else {
        const conGrupo = ids.filter((id) => memberByUser.has(id));
        // La guarda de `groups.length` NO es redundante: en PostgREST un
        // `.in(col, [])` devuelve TODAS las filas, así que con la lista vacía este
        // DELETE borraría las membresías de esas personas en CUALQUIER taller.
        // Hoy no puede pasar —si hay membresías hay grupos— pero eso es una
        // implicación, no una garantía, y esto es un DELETE.
        if (conGrupo.length > 0 && groups.length > 0) {
          const { error } = await db
            .from("workshop_group_members")
            .delete()
            .in("group_id", groups.map((g) => g.id))
            .in("user_id", conGrupo);
          if (error) {
            toast.error(friendlyError(error));
            return;
          }
        }
      }

      const { data: creados, error: cErr } = await db
        .from("workshop_groups")
        .insert(propuesta.map((g) => ({ workshop_id: workshopId, name: g.nombre })))
        .select("id, name");
      if (cErr || !creados) {
        toast.error(friendlyError(cErr));
        return;
      }

      const porNombre = new Map(
        ((creados ?? []) as { id: string; name: string }[]).map((g) => [g.name, g.id]),
      );
      const filas = propuesta.flatMap((g) => {
        const gid = porNombre.get(g.nombre);
        return gid ? g.integrantes.map((user_id) => ({ group_id: gid, user_id })) : [];
      });
      if (filas.length > 0) {
        const { error: mErr } = await db.from("workshop_group_members").insert(filas);
        if (mErr) {
          toast.error(friendlyError(mErr));
          return;
        }
      }
      toast.success(
        t("hc_modulesWorkshopsWorkshopGroupsEditor.randomDone", { count: propuesta.length }),
      );
      setAzarAbierto(false);
    } finally {
      setRepartiendo(false);
      await load({ silencioso: true });
    }
  };

  const deleteGroup = async (g: Group) => {
    const memberCount = (studentsByGroup.get(g.id) ?? []).length;
    const ok = await confirm({
      title: t("hc_modulesWorkshopsWorkshopGroupsEditor.deleteGroupTitle", { name: g.name }),
      description:
        memberCount > 0
          ? t("hc_modulesWorkshopsWorkshopGroupsEditor.deleteGroupDescWithMembers", {
              count: memberCount,
            })
          : t("hc_modulesWorkshopsWorkshopGroupsEditor.deleteGroupDescEmpty"),
      confirmLabel: t("hc_modulesWorkshopsWorkshopGroupsEditor.deleteConfirmLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    setGroups((prev) => prev.filter((x) => x.id !== g.id));
    setMembers((prev) => prev.filter((m) => m.group_id !== g.id));
    const { error } = await db.from("workshop_groups").delete().eq("id", g.id);
    if (error) {
      toast.error(friendlyError(error));
      await load({ silencioso: true });
    }
  };

  /**
   * Mueve a un usuario desde su grupo actual (o desde "sin asignar") al
   * destino (otro grupo o UNASSIGNED). Aplica la operación más mínima
   * posible: si el user ya está en el destino, no hace nada.
   */
  const moveUser = async (userId: string, target: string) => {
    const currentGroupId = memberByUser.get(userId);
    if (currentGroupId === target) return;
    if (target === UNASSIGNED && !currentGroupId) return;

    // En el acto: sin spinner, sin perder el scroll.
    setMembers((prev) => {
      const sin = prev.filter((m) => m.user_id !== userId);
      return target === UNASSIGNED ? sin : [...sin, { group_id: target, user_id: userId }];
    });
    // Si la base lo rechaza (p. ej. ya entregó individual), se deshace SOLO este
    // movimiento: revertir a una foto vieja pisaría otros que sí se guardaron.
    const deshacer = (e: unknown) => {
      setMembers((prev) => {
        const sin = prev.filter((m) => m.user_id !== userId);
        return currentGroupId ? [...sin, { group_id: currentGroupId, user_id: userId }] : sin;
      });
      toast.error(friendlyError(e));
    };

    await encolar(async () => {
      // Borrar la membresía previa primero: el trigger no permite estar en dos
      // grupos del mismo taller, así que el INSERT solo no es seguro.
      if (currentGroupId) {
        const { error } = await db
          .from("workshop_group_members")
          .delete()
          .eq("group_id", currentGroupId)
          .eq("user_id", userId);
        if (error) return deshacer(error);
      }
      if (target !== UNASSIGNED) {
        const { error } = await db
          .from("workshop_group_members")
          .insert({ group_id: target, user_id: userId });
        if (error) {
          // La membresía vieja ya se borró: se relee lo real en vez de adivinar.
          toast.error(friendlyError(error));
          await load({ silencioso: true });
        }
      }
    });
  };

  // ── Drag & drop handlers ──
  const onDragStart = (userId: string) => (e: React.DragEvent) => {
    setDraggingUserId(userId);
    e.dataTransfer.setData("text/user-id", userId);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = () => {
    setDraggingUserId(null);
    setDragOverTarget(null);
  };
  const onDragOver = (target: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget(target);
  };
  const onDragLeave = () => setDragOverTarget(null);
  const onDrop = (target: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverTarget(null);
    const userId = e.dataTransfer.getData("text/user-id") || draggingUserId;
    setDraggingUserId(null);
    if (!userId) return;
    await moveUser(userId, target);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            {t("hc_modulesWorkshopsWorkshopGroupsEditor.workshopGroupsTitle")}
            <Badge variant="secondary" className="text-3xs">
              {groups.length}
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {/* En un taller externo nadie «entrega»: el grupo se califica junto. */}
            {esExterno
              ? t("gruposNota.tableroHint")
              : t("hc_modulesWorkshopsWorkshopGroupsEditor.workshopGroupsHint")}
          </p>
          {esExterno && (
            <p className="text-xs text-muted-foreground">{t("gruposNota.hint")}</p>
          )}
          {esExterno && (
            <div>
              <GuardarNotasDeGrupos
                cantidad={notasGrupos.guardandoTodas ? notasGrupos.enCurso : notasSinGuardar}
                guardando={notasGrupos.guardandoTodas}
                onGuardar={() => void notasGrupos.guardarTodas(gruposACalificar, notaGuardada)}
              />
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder={t("hc_modulesWorkshopsWorkshopGroupsEditor.groupNamePlaceholder")}
              onKeyDown={(e) => e.key === "Enter" && void createGroup()}
              className="flex-1 min-w-[160px] sm:min-w-48"
            />
            <Button onClick={createGroup} disabled={creating || !newGroupName.trim()}>
              {creating ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Plus className="h-4 w-4 mr-1" />
              )}
              {t("hc_modulesWorkshopsWorkshopGroupsEditor.createGroup")}
            </Button>
            {/* Repartir al azar. Va JUNTO a "crear grupo" porque es la
                alternativa a hacerlo a mano, no una función escondida: armar 8
                grupos de 4 con 31 estudiantes a mano son 8 nombres y 31
                arrastres, en clase y con la gente esperando. */}
            <Button
              variant="outline"
              onClick={() => setAzarAbierto((v) => !v)}
              disabled={students.length === 0}
            >
              <Shuffle className="h-4 w-4 mr-1" />
              {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomAction")}
            </Button>
            {/* Va acá por el mismo motivo que "repartir al azar": es la alternativa a
                hacerlo a mano cuando los grupos YA existen —los armaron en las salas de
                la videollamada— y transcribir 30 nombres en clase no es viable. */}
            <Button
              variant="outline"
              onClick={() => setImagenAbierta(true)}
              disabled={students.length === 0}
              title={t("hc_modulesWorkshopsWorkshopGroupsEditor.fromImageHint")}
            >
              <ImageUp className="h-4 w-4 mr-1" />
              {t("hc_modulesWorkshopsWorkshopGroupsEditor.fromImageAction")}
            </Button>
          </div>

          {azarAbierto && (
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label className="text-2xs">
                    {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomModeLabel")}
                  </Label>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={modo === "tamano" ? "default" : "outline"}
                      onClick={() => setModo("tamano")}
                    >
                      {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomBySize")}
                    </Button>
                    <Button
                      size="sm"
                      variant={modo === "cantidad" ? "default" : "outline"}
                      onClick={() => setModo("cantidad")}
                    >
                      {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomByCount")}
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reparto-valor" className="text-2xs">
                    {modo === "tamano"
                      ? t("hc_modulesWorkshopsWorkshopGroupsEditor.randomSizeLabel")
                      : t("hc_modulesWorkshopsWorkshopGroupsEditor.randomCountLabel")}
                  </Label>
                  <Input
                    id="reparto-valor"
                    type="number"
                    min={1}
                    max={99}
                    className="h-8 w-24"
                    value={valor}
                    onChange={(e) => setValor(Number(e.target.value))}
                  />
                </div>
                <Button onClick={() => void repartir()} disabled={repartiendo || incluidos.size === 0}>
                  {repartiendo ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Shuffle className="h-4 w-4 mr-1" />
                  )}
                  {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomApply")}
                </Button>
              </div>

              {/* La previsualización es DETERMINISTA: dice cuántos grupos y de
                  qué tamaño, sin sortear. Sortear en cada render haría que los
                  tamaños cambiaran solos mientras el docente decide. */}
              <p className="text-2xs text-muted-foreground">
                {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomPreview", {
                  groups: tamanosPrevios.length,
                  people: incluidos.size,
                })}
              </p>

              {avisosDeRango.length > 0 && (
                <p className="text-2xs text-warning-on-subtle">
                  {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomOutOfRange", {
                    min: groupSizeMin ?? 1,
                    max: groupSizeMax ?? 99,
                    count: avisosDeRango.length,
                  })}
                </p>
              )}

              {groups.length > 0 && (
                <label className="flex items-start gap-2 text-2xs">
                  <Checkbox
                    checked={reemplazar && puedeReemplazar}
                    disabled={!puedeReemplazar}
                    onCheckedChange={() => setReemplazar((v) => !v)}
                  />
                  <span>
                    {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomReplace", {
                      count: groups.length,
                    })}
                    {!puedeReemplazar && (
                      <span className="block text-muted-foreground">
                        {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomReplaceBlocked")}
                      </span>
                    )}
                  </span>
                </label>
              )}

              {/* La lista para destildar a quien no vino a la sesión donde se
                  reparte el taller. Es la razón de ser del panel: repartir "el
                  curso" incluiría a los ausentes. */}
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-2xs">
                    {t("hc_modulesWorkshopsWorkshopGroupsEditor.randomWhoLabel", {
                      count: incluidos.size,
                      total: students.length,
                    })}
                  </Label>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-2xs"
                      onClick={() => setIncluidos(new Set(students.map((x) => x.id)))}
                    >
                      {t("common.selectAll")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-2xs"
                      onClick={() => setIncluidos(new Set())}
                    >
                      {t("common.deselectAll")}
                    </Button>
                  </div>
                </div>
                <div className="max-h-40 overflow-y-auto rounded border p-1">
                  {students.map((st) => (
                    <label
                      key={st.id}
                      className="flex items-center gap-2 rounded p-1 text-xs hover:bg-accent cursor-pointer"
                    >
                      <Checkbox
                        checked={incluidos.has(st.id)}
                        onCheckedChange={() => alternarIncluido(st.id)}
                      />
                      <span className="truncate">{st.full_name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {!loading && students.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={busqueda}
            onChange={setBusqueda}
            placeholder={t("buscarEnGrupos.placeholder")}
            maxWidthClass="sm:max-w-sm"
            className="flex-1"
          />
          {tablero.activa && (
            <span className="text-2xs text-muted-foreground tabular-nums" aria-live="polite">
              {t("buscarEnGrupos.coincidencias", { count: tablero.visibles })}
            </span>
          )}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="md" /> {t("hc_modulesWorkshopsWorkshopGroupsEditor.loading")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Sin asignar — drop target para "quitar de grupo" */}
          <Card
            className={
              dragOverTarget === UNASSIGNED
                ? "ring-2 ring-primary/60 transition-all"
                : "transition-all"
            }
            onDragOver={onDragOver(UNASSIGNED)}
            onDragLeave={onDragLeave}
            onDrop={onDrop(UNASSIGNED)}
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                {esExterno
                  ? t("gruposNota.sinGrupoTitulo")
                  : t("hc_modulesWorkshopsWorkshopGroupsEditor.unassignedTitle")}
                <Badge variant="outline" className="text-3xs">
                  {unassigned.length}
                </Badge>
              </CardTitle>
              <p className="text-3xs text-muted-foreground">
                {esExterno
                  ? t("gruposNota.sinGrupoHint")
                  : t("hc_modulesWorkshopsWorkshopGroupsEditor.unassignedHint")}
              </p>
            </CardHeader>
            <CardContent className="space-y-1.5 min-h-[80px]">
              {unassigned.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("hc_modulesWorkshopsWorkshopGroupsEditor.allStudentsAssigned")}
                </p>
              ) : tablero.sinGrupo.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("buscarEnGrupos.nadieSinGrupo")}
                </p>
              ) : (
                tablero.sinGrupo.map((s) => (
                  <DraggableStudent
                    key={s.id}
                    student={s}
                    isDragging={draggingUserId === s.id}
                    onDragStart={onDragStart(s.id)}
                    onDragEnd={onDragEnd}
                    groups={groups}
                    currentGroupId={null}
                    onMoveTo={(target) => void moveUser(s.id, target)}
                    nota={esExterno ? (notas.get(s.id)?.grade ?? null) : undefined}
                  />
                ))
              )}
            </CardContent>
          </Card>

          {/* Grupos */}
          <div className="space-y-3">
            {groups.length === 0 && (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground text-center">
                  {t("hc_modulesWorkshopsWorkshopGroupsEditor.noGroupsCreated")}
                </CardContent>
              </Card>
            )}
            {groups.map((g) => {
              const ms = studentsByGroup.get(g.id) ?? [];
              const visibles = tablero.porGrupo.get(g.id) ?? ms;
              const isOver = dragOverTarget === g.id;
              return (
                <Card
                  key={g.id}
                  className={
                    isOver ? "ring-2 ring-primary/60 transition-all" : "transition-all"
                  }
                  onDragOver={onDragOver(g.id)}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop(g.id)}
                >
                  <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-sm flex items-center gap-2">
                      {g.name}
                      <Badge variant="outline" className="text-3xs">
                        {t("hc_modulesWorkshopsWorkshopGroupsEditor.memberCount", {
                          count: ms.length,
                        })}
                      </Badge>
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => deleteGroup(g)}
                      title={t("hc_modulesWorkshopsWorkshopGroupsEditor.deleteGroupTooltip")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-1.5 min-h-[60px]">
                    {esExterno && ms.length > 0 && (
                      <NotaDeGrupoInline
                        key={g.id}
                        grupoId={g.id}
                        nombre={g.name}
                        integrantes={integrantesConNota(g, ms)}
                        escala={escala}
                        calificar={calificar}
                        guardando={guardandoNota}
                        onGuardada={notaGuardada}
                        borrador={notasGrupos.borradores[g.id]}
                        onBorrador={(v) => notasGrupos.setBorrador(g.id, v)}
                        bloqueado={notasGrupos.guardandoTodas}
                      />
                    )}
                    {ms.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">
                        {t("hc_modulesWorkshopsWorkshopGroupsEditor.dragStudentsHere")}
                      </p>
                    ) : visibles.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">
                        {t("buscarEnGrupos.nadieEnElGrupo")}
                      </p>
                    ) : (
                      visibles.map((s) => (
                        <DraggableStudent
                          key={s.id}
                          student={s}
                          isDragging={draggingUserId === s.id}
                          onDragStart={onDragStart(s.id)}
                          onDragEnd={onDragEnd}
                          groups={groups}
                          currentGroupId={g.id}
                          onMoveTo={(target) => void moveUser(s.id, target)}
                          nota={esExterno ? (notas.get(s.id)?.grade ?? null) : undefined}
                        />
                      ))
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Recibe el estado que el editor YA tiene en memoria: no re-consulta nada. */}
      <GruposDesdeImagenDialog
        open={imagenAbierta}
        onOpenChange={setImagenAbierta}
        workshopId={workshopId}
        courseId={courseId}
        students={students}
        groups={groups}
        memberByUser={memberByUser}
        gruposConEntrega={gruposConEntrega}
        conEntregaIndividual={conEntregaIndividual}
        groupSizeMin={groupSizeMin}
        groupSizeMax={groupSizeMax}
        onAplicado={() => void load({ silencioso: true })}
      />
    </div>
  );
}

/**
 * Tarjeta de estudiante. Modos de movimiento:
 *  1. Drag & drop nativo HTML5 — desktop (mouse).
 *  2. Botón "Mover" → DropdownMenu — fallback táctil (mobile/tablet)
 *     porque el drag&drop nativo no dispara en touch sin polyfill.
 */
function DraggableStudent({
  student,
  isDragging,
  onDragStart,
  onDragEnd,
  groups,
  currentGroupId,
  onMoveTo,
  nota,
}: {
  student: Student;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  groups: Group[];
  currentGroupId: string | null;
  onMoveTo: (target: string) => void;
  /** Taller externo: la nota ya guardada (`null` = sin nota). `undefined` = no aplica. */
  nota?: number | null;
}) {
  const { t } = useTranslation();
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`flex items-center gap-2 rounded border bg-background p-2 cursor-grab active:cursor-grabbing select-none ${
        isDragging ? "opacity-40" : "hover:bg-muted/40"
      }`}
    >
      <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">{student.full_name}</div>
        <div className="text-3xs text-muted-foreground truncate">
          {student.institutional_email}
        </div>
      </div>
      {nota != null && (
        <Badge
          variant="outline"
          className="text-3xs tabular-nums shrink-0"
          title={t("gruposNota.notaDe", { name: student.full_name })}
        >
          {formatNumber(nota, { maximumFractionDigits: 2 })}
        </Badge>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t("hc_modulesWorkshopsWorkshopGroupsEditor.moveToOtherGroup")}
            title={t("hc_modulesWorkshopsWorkshopGroupsEditor.moveToOtherGroup")}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <ArrowRightLeft className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{t("hc_modulesWorkshopsWorkshopGroupsEditor.moveToLabel")}</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => onMoveTo(UNASSIGNED)}
            disabled={currentGroupId === null}
          >
            {currentGroupId === null ? (
              <Check className="h-3.5 w-3.5 mr-2" />
            ) : (
              <span className="w-3.5 mr-2" />
            )}
            {t("hc_modulesWorkshopsWorkshopGroupsEditor.noGroup")}
          </DropdownMenuItem>
          {groups.length > 0 && <DropdownMenuSeparator />}
          {groups.map((g) => (
            <DropdownMenuItem
              key={g.id}
              onClick={() => onMoveTo(g.id)}
              disabled={currentGroupId === g.id}
            >
              {currentGroupId === g.id ? (
                <Check className="h-3.5 w-3.5 mr-2" />
              ) : (
                <span className="w-3.5 mr-2" />
              )}
              <span className="truncate">{g.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
