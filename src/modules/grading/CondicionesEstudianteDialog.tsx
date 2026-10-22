/**
 * Diálogo del docente para gestionar las CONDICIONES por estudiante de un taller
 * o proyecto: un tope de nota, un plazo propio y/o una entrega individual
 * autorizada, con un motivo visible para el estudiante.
 *
 * Se abre desde «Editar» → «Contenido y participantes» (`ConfigurarDesdeEditar`).
 * Lista a los estudiantes asignados, con filtros rápidos para los dos casos
 * típicos («entregaron después del plazo», «sin grupo»), aplica la condición a
 * los seleccionados y muestra las condiciones vigentes para editar o quitar.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPen, Trash2, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { DecimalInput } from "@/components/ui/decimal-input";
import { DateTimePicker } from "@/components/ui/date-picker";
import { RowAction } from "@/components/ui/row-action";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime, formatNumber } from "@/shared/lib/format";
import { normalizeForSearch } from "@/modules/search/search-text";
import { toast } from "sonner";
import {
  normalizarCondicion,
  tieneCondicion,
  type CondicionEstudiante,
  type FilaCondicion,
  type TipoCondicion,
} from "./condiciones-estudiante";

/** Índice por usuario: todas las filas son de la MISMA actividad. */
function indiceCondicionesPorEstudiante(
  filas: readonly FilaCondicion[],
): Map<string, CondicionEstudiante> {
  const m = new Map<string, CondicionEstudiante>();
  for (const f of filas) {
    const c = normalizarCondicion(f);
    if (c) m.set(c.userId, c);
  }
  return m;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface ActividadParaCondiciones {
  id: string;
  title: string;
  courseId: string;
  /** `group_required` = grupal estricto (donde «entrega individual» tiene sentido). */
  groupMode?: string | null;
  isExternal?: boolean | null;
  /** Para el tope: la escala del curso. */
  scaleMin: number;
  scaleMax: number;
  /** Plazo global, para el filtro «entregaron después del plazo». */
  dueDate?: string | null;
}

interface FilaEstudiante {
  id: string;
  nombre: string;
  email: string | null;
  tieneGrupo: boolean;
  entregoTarde: boolean;
}

export function CondicionesEstudianteDialog({
  tipo,
  actividad,
  open,
  onOpenChange,
  onCambio,
}: {
  tipo: TipoCondicion;
  actividad: ActividadParaCondiciones;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Se llama tras aplicar o quitar condiciones (para refrescar la grilla). */
  onCambio?: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [cargando, setCargando] = useState(false);
  const [estudiantes, setEstudiantes] = useState<FilaEstudiante[]>([]);
  const [condiciones, setCondiciones] = useState<Map<string, CondicionEstudiante>>(new Map());

  // Formulario de la condición a aplicar.
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [notaMaxima, setNotaMaxima] = useState<number | null>(null);
  const [plazoPropio, setPlazoPropio] = useState("");
  const [entregaIndividual, setEntregaIndividual] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);

  // Filtros.
  const [busqueda, setBusqueda] = useState("");
  const [soloTarde, setSoloTarde] = useState(false);
  const [soloSinGrupo, setSoloSinGrupo] = useState(false);

  const esGrupalEstricto = actividad.groupMode === "group_required";

  const cargar = async () => {
    setCargando(true);
    try {
      const idCol = tipo === "taller" ? "workshop_id" : "project_id";
      const asgTabla = tipo === "taller" ? "workshop_assignments" : "project_assignments";
      const subTabla = tipo === "taller" ? "workshop_submissions" : "project_submissions";
      const grpTabla = tipo === "taller" ? "workshop_groups" : "project_groups";
      const grpMemTabla = tipo === "taller" ? "workshop_group_members" : "project_group_members";

      const [asg, cond, subs, grupos] = await Promise.all([
        db.from(asgTabla).select("user_id").eq(idCol, actividad.id),
        db
          .from("condiciones_estudiante")
          .select("tipo, actividad_id, user_id, nota_maxima, plazo_propio, entrega_individual, motivo")
          .eq("tipo", tipo)
          .eq("actividad_id", actividad.id),
        db
          .from(subTabla)
          .select("user_id, group_id, status, submitted_at")
          .eq(idCol, actividad.id),
        db
          .from(grpMemTabla)
          .select(`user_id, group:${grpTabla}!inner(id, ${idCol})`),
      ]);

      const userIds: string[] = [
        ...new Set<string>((asg.data ?? []).map((a: { user_id: string }) => a.user_id)),
      ];
      const perfiles = userIds.length
        ? await db.from("profiles").select("id, full_name, institutional_email").in("id", userIds)
        : { data: [] };
      const nombrePorId = new Map<string, { nombre: string; email: string | null }>(
        (
          perfiles.data ?? []
        ).map((p: { id: string; full_name: string | null; institutional_email: string | null }) => [
          p.id,
          { nombre: p.full_name || p.institutional_email || p.id, email: p.institutional_email },
        ]),
      );

      // Grupo por usuario (los de ESTA actividad).
      const conGrupo = new Set<string>();
      for (const m of (grupos.data ?? []) as Array<{
        user_id: string;
        group: { id: string } | Record<string, unknown> | null;
      }>) {
        if (m.group) conGrupo.add(m.user_id);
      }

      // Entregó después del plazo: tiene entrega con `submitted_at` posterior al
      // plazo global. Las entregas de grupo cuentan para cada integrante.
      const grupoDeUsuario = new Map<string, string>();
      for (const m of (grupos.data ?? []) as Array<{ user_id: string; group: { id: string } | null }>) {
        if (m.group?.id) grupoDeUsuario.set(m.user_id, m.group.id);
      }
      const due = actividad.dueDate ? new Date(actividad.dueDate).getTime() : null;
      const tardePorUsuario = new Set<string>();
      if (due != null) {
        for (const s of (subs.data ?? []) as Array<{
          user_id: string;
          group_id: string | null;
          submitted_at: string | null;
        }>) {
          if (!s.submitted_at) continue;
          const cuando = new Date(s.submitted_at).getTime();
          if (!Number.isFinite(cuando) || cuando <= due) continue;
          if (s.group_id) {
            for (const [uid, gid] of grupoDeUsuario) if (gid === s.group_id) tardePorUsuario.add(uid);
          } else {
            tardePorUsuario.add(s.user_id);
          }
        }
      }

      const filas: FilaEstudiante[] = userIds
        .map((id) => {
          const p = nombrePorId.get(id);
          return {
            id,
            nombre: p?.nombre ?? id,
            email: p?.email ?? null,
            tieneGrupo: conGrupo.has(id),
            entregoTarde: tardePorUsuario.has(id),
          };
        })
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

      setEstudiantes(filas);
      setCondiciones(indiceCondicionesPorEstudiante((cond.data ?? []) as FilaCondicion[]));
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void cargar();
    // Reset del formulario al abrir.
    limpiarFormulario();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, actividad.id, tipo]);

  const limpiarFormulario = () => {
    setSeleccion(new Set());
    setNotaMaxima(null);
    setPlazoPropio("");
    setEntregaIndividual(false);
    setMotivo("");
  };

  const visibles = useMemo(() => {
    const q = normalizeForSearch(busqueda);
    return estudiantes.filter((e) => {
      if (soloTarde && !e.entregoTarde) return false;
      if (soloSinGrupo && e.tieneGrupo) return false;
      if (q && !normalizeForSearch(`${e.nombre} ${e.email ?? ""}`).includes(q)) return false;
      return true;
    });
  }, [estudiantes, busqueda, soloTarde, soloSinGrupo]);

  const alternar = (id: string) =>
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const todosVisiblesMarcados = visibles.length > 0 && visibles.every((e) => seleccion.has(e.id));
  const alternarTodos = () =>
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (todosVisiblesMarcados) for (const e of visibles) next.delete(e.id);
      else for (const e of visibles) next.add(e.id);
      return next;
    });

  const hayCondicion = notaMaxima != null || !!plazoPropio || entregaIndividual;
  const motivoOk = motivo.trim().length > 0;
  const puedeAplicar = seleccion.size > 0 && hayCondicion && motivoOk && !guardando;

  const aplicar = async () => {
    if (!puedeAplicar) return;
    setGuardando(true);
    try {
      const filas = [...seleccion].map((userId) => ({
        tipo,
        actividad_id: actividad.id,
        user_id: userId,
        nota_maxima: notaMaxima,
        plazo_propio: plazoPropio || null,
        entrega_individual: entregaIndividual,
        motivo: motivo.trim(),
      }));
      const { error } = await db
        .from("condiciones_estudiante")
        .upsert(filas, { onConflict: "tipo,actividad_id,user_id" });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(t("condicionEstudiante.aplicada", { count: filas.length }));
      limpiarFormulario();
      await cargar();
      onCambio?.();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setGuardando(false);
    }
  };

  const editar = (c: CondicionEstudiante) => {
    setSeleccion(new Set([c.userId]));
    setNotaMaxima(c.notaMaxima);
    setPlazoPropio(c.plazoPropio ?? "");
    setEntregaIndividual(c.entregaIndividual);
    setMotivo(c.motivo);
  };

  const quitar = async (c: CondicionEstudiante) => {
    const nombre = estudiantes.find((e) => e.id === c.userId)?.nombre ?? "";
    const ok = await confirm({
      title: t("condicionEstudiante.quitarTitulo"),
      description: t("condicionEstudiante.quitarCuerpo", { nombre }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db
      .from("condiciones_estudiante")
      .delete()
      .eq("tipo", tipo)
      .eq("actividad_id", actividad.id)
      .eq("user_id", c.userId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(t("condicionEstudiante.quitada"));
    await cargar();
    onCambio?.();
  };

  const condicionesVigentes = useMemo(
    () => [...condiciones.values()].filter(tieneCondicion),
    [condiciones],
  );

  const resumenCorto = (c: CondicionEstudiante): string => {
    const partes: string[] = [];
    if (c.plazoPropio) partes.push(t("condicionEstudiante.plazo", { fecha: formatDateTime(c.plazoPropio) }));
    if (c.notaMaxima != null)
      partes.push(t("condicionEstudiante.tope", { nota: formatNumber(c.notaMaxima, { maximumFractionDigits: 2 }) }));
    if (c.entregaIndividual) partes.push(t("condicionEstudiante.individual"));
    return partes.join(" · ");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPen className="h-5 w-5 text-primary" />
            {t("condicionEstudiante.dialogTitulo")}
          </DialogTitle>
          <DialogDescription>
            {t("condicionEstudiante.dialogSubtitulo", { actividad: actividad.title })}
          </DialogDescription>
        </DialogHeader>

        {cargando ? (
          <div className="flex justify-center py-10">
            <Spinner size="md" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* ── La condición ── */}
            <div className="rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">{t("condicionEstudiante.seccionCondicion")}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{t("condicionEstudiante.campoNotaMaxima")}</Label>
                  <DecimalInput
                    value={notaMaxima}
                    onChange={setNotaMaxima}
                    min={actividad.scaleMin}
                    max={actividad.scaleMax}
                    placeholder={`${actividad.scaleMin}–${actividad.scaleMax}`}
                    className="mt-1"
                  />
                  <p className="text-2xs text-muted-foreground mt-1">
                    {t("condicionEstudiante.campoNotaMaximaHint")}
                  </p>
                </div>
                <div>
                  <Label className="text-xs">{t("condicionEstudiante.campoPlazo")}</Label>
                  <DateTimePicker value={plazoPropio} onChange={setPlazoPropio} className="mt-1" />
                  <p className="text-2xs text-muted-foreground mt-1">
                    {t("condicionEstudiante.campoPlazoHint")}
                  </p>
                </div>
              </div>
              {/* La entrega individual solo tiene sentido en grupal estricto. */}
              {esGrupalEstricto && !actividad.isExternal && (
                <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5">
                  <div className="space-y-0.5">
                    <Label htmlFor="cond-individual" className="text-sm">
                      {t("condicionEstudiante.campoIndividual")}
                    </Label>
                    <p className="text-2xs text-muted-foreground leading-tight">
                      {t("condicionEstudiante.campoIndividualHint")}
                    </p>
                  </div>
                  <Switch
                    id="cond-individual"
                    checked={entregaIndividual}
                    onCheckedChange={setEntregaIndividual}
                  />
                </div>
              )}
              <div>
                <Label className="text-xs" required>
                  {t("condicionEstudiante.campoMotivo")}
                </Label>
                <Textarea
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value.slice(0, 500))}
                  placeholder={t("condicionEstudiante.campoMotivoPlaceholder")}
                  rows={2}
                  className="mt-1"
                />
                <p className="text-2xs text-muted-foreground mt-1">
                  {t("condicionEstudiante.campoMotivoHint")}
                </p>
              </div>
            </div>

            {/* ── A quién ── */}
            <div className="rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">{t("condicionEstudiante.seccionEstudiantes")}</p>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder={t("condicionEstudiante.buscarEstudiante")}
                  className="pl-8"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={soloTarde ? "default" : "outline"}
                  onClick={() => setSoloTarde((v) => !v)}
                  disabled={!actividad.dueDate}
                >
                  {t("condicionEstudiante.filtroTarde")}
                </Button>
                {esGrupalEstricto && (
                  <Button
                    type="button"
                    size="sm"
                    variant={soloSinGrupo ? "default" : "outline"}
                    onClick={() => setSoloSinGrupo((v) => !v)}
                  >
                    {t("condicionEstudiante.filtroSinGrupo")}
                  </Button>
                )}
              </div>

              {estudiantes.length === 0 ? (
                <EmptyState
                  icon={UserPen}
                  title={t("condicionEstudiante.sinAsignados")}
                  hint={t("condicionEstudiante.sinAsignadosHint")}
                />
              ) : (
                <>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={todosVisiblesMarcados}
                      onCheckedChange={alternarTodos}
                      aria-label={t("common.selectAll")}
                    />
                    {t("condicionEstudiante.seleccionados", { count: seleccion.size })}
                  </label>
                  <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
                    {visibles.map((e) => {
                      const c = condiciones.get(e.id);
                      return (
                        <label
                          key={e.id}
                          className="flex items-center gap-2 p-2 text-sm hover:bg-accent cursor-pointer"
                        >
                          <Checkbox
                            checked={seleccion.has(e.id)}
                            onCheckedChange={() => alternar(e.id)}
                          />
                          <span className="min-w-0 flex-1 truncate">{e.nombre}</span>
                          {e.entregoTarde && (
                            <Badge variant="outline" className="text-3xs shrink-0">
                              {t("condicionEstudiante.badgeTarde")}
                            </Badge>
                          )}
                          {esGrupalEstricto && !e.tieneGrupo && (
                            <Badge variant="outline" className="text-3xs shrink-0">
                              {t("condicionEstudiante.badgeSinGrupo")}
                            </Badge>
                          )}
                          {c && tieneCondicion(c) && (
                            <Badge
                              variant="outline"
                              className="text-3xs shrink-0 border-primary/40 text-primary"
                            >
                              <UserPen className="h-2.5 w-2.5 mr-0.5" />
                              {t("condicionEstudiante.badge")}
                            </Badge>
                          )}
                        </label>
                      );
                    })}
                    {visibles.length === 0 && (
                      <p className="p-3 text-center text-xs text-muted-foreground">
                        {t("condicionEstudiante.sinCoincidencias")}
                      </p>
                    )}
                  </div>
                </>
              )}

              <Button className="w-full" onClick={aplicar} disabled={!puedeAplicar}>
                {guardando && <Spinner size="sm" className="mr-1" />}
                {t("condicionEstudiante.aplicar", { count: seleccion.size })}
              </Button>
            </div>

            {/* ── Vigentes ── */}
            {condicionesVigentes.length > 0 && (
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">{t("condicionEstudiante.seccionVigentes")}</p>
                <div className="divide-y">
                  {condicionesVigentes.map((c) => {
                    const nombre = estudiantes.find((e) => e.id === c.userId)?.nombre ?? c.userId;
                    return (
                      <div key={c.userId} className="flex items-start gap-2 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{nombre}</p>
                          <p className="text-2xs text-muted-foreground">{resumenCorto(c)}</p>
                          {c.motivo && (
                            <p className="text-2xs text-muted-foreground italic truncate">
                              {t("condicionEstudiante.motivo", { motivo: c.motivo })}
                            </p>
                          )}
                        </div>
                        <RowAction
                          label={t("common.edit")}
                          icon={UserPen}
                          onClick={() => editar(c)}
                        />
                        <RowAction
                          label={t("common.delete")}
                          icon={Trash2}
                          tone="destructive"
                          onClick={() => void quitar(c)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
