/**
 * Arma los grupos de un taller leyendo una CAPTURA de la videollamada.
 *
 * ── La revisión antes de escribir es obligatoria ──────────────────────────
 * El modelo propone y el docente confirma fila por fila. No es cautela genérica: la
 * nota de un taller en grupo la comparten todos sus integrantes, así que un nombre mal
 * emparejado —"Vela" que es Velandia o Velasco— afecta la nota de dos personas y no se
 * nota hasta que alguien reclama. Mismo modelo de borrador que
 * `IdentifyQuestionsDialog`, que es la única superficie del repo que ya lo tenía.
 *
 * Lo que decide qué se escribe vive en `plan-grupos-imagen.ts` (puro, con tests): acá
 * solo está el diálogo.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, ImageUp, Trash2, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/shared/lib/db-errors";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import { logEvent } from "@/shared/lib/audit";

import { archivoAImagenBase64 } from "./imagen-a-lectura";
import { tipoDeImagenAceptado } from "./imagen-limites";
import {
  emparejarLectura,
  type EstudianteMatriculado,
  type FilaLeida,
  type GrupoLeido,
} from "./emparejar-nombres";
import { construirPlan, type ContextoPlan, type MotivoBloqueo } from "./plan-grupos-imagen";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workshopId: string;
  courseId: string;
  /** Matriculados, tal como los tiene el editor: no se re-consultan. */
  students: { id: string; full_name: string; institutional_email: string }[];
  groups: { id: string; name: string }[];
  memberByUser: ReadonlyMap<string, string>;
  gruposConEntrega: ReadonlySet<string>;
  conEntregaIndividual: ReadonlySet<string>;
  groupSizeMin: number | null;
  groupSizeMax: number | null;
  /** Se llama tras aplicar, para que el editor recargue. */
  onAplicado: () => void;
}

type Fase = "elegir" | "leyendo" | "revisar";

const MOTIVO_CLAVE: Record<MotivoBloqueo, string> = {
  sin_estudiante: "groupsFromImage.blockedNoStudent",
  entrega_individual: "groupsFromImage.blockedIndividual",
  grupo_con_entrega: "groupsFromImage.blockedGroupSubmitted",
  repetido_en_el_plan: "groupsFromImage.blockedRepeated",
};

export function GruposDesdeImagenDialog({
  open,
  onOpenChange,
  workshopId,
  courseId,
  students,
  groups,
  memberByUser,
  gruposConEntrega,
  conEntregaIndividual,
  groupSizeMin,
  groupSizeMax,
  onAplicado,
}: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const aiGate = useAiAuthorizationGate();

  const [fase, setFase] = useState<Fase>("elegir");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [vistaPrevia, setVistaPrevia] = useState<string | null>(null);
  const [pista, setPista] = useState("");
  const [filas, setFilas] = useState<FilaLeida[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Reset al abrir. En la transición cerrado → abierto, no en cada render.
  const abiertoAntes = useRef(false);
  useEffect(() => {
    const recienAbierto = open && !abiertoAntes.current;
    abiertoAntes.current = open;
    if (!recienAbierto) return;
    setFase("elegir");
    setArchivo(null);
    setVistaPrevia(null);
    setPista("");
    setFilas([]);
    setAviso(null);
    setError(null);
  }, [open]);

  // El object URL de la vista previa se revoca al cambiarlo y al desmontar: sin esto
  // cada captura que el docente prueba deja un blob colgado.
  useEffect(() => {
    return () => {
      if (vistaPrevia) URL.revokeObjectURL(vistaPrevia);
    };
  }, [vistaPrevia]);

  const roster: EstudianteMatriculado[] = students.map((s) => ({
    user_id: s.id,
    full_name: s.full_name,
    institutional_email: s.institutional_email,
  }));

  const elegirArchivo = (f: File | null) => {
    if (!f) return;
    if (!tipoDeImagenAceptado(f.name)) {
      toast.error(t("groupsFromImage.badType"));
      return;
    }
    setError(null);
    setArchivo(f);
    if (vistaPrevia) URL.revokeObjectURL(vistaPrevia);
    setVistaPrevia(URL.createObjectURL(f));
  };

  const leer = async () => {
    if (!archivo) return;
    const decision = await aiGate.ensureAuthorized({ allowQueue: false });
    if (decision === "cancel") return;
    if (decision === "proceed-async") {
      // La cola devuelve «insertado», no un borrador: no hay dónde revisar.
      toast.info(t("groupsFromImage.queueNotSupported"));
      return;
    }

    setFase("leyendo");
    setError(null);
    setAviso(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const img = await archivoAImagenBase64(archivo);
      if (ctrl.signal.aborted) return;

      const { data, error: fnErr } = await db.functions.invoke("ai-read-groups-image", {
        body: { imagen: img.dataUrl, workshopId, courseId, pista: pista.trim() || null },
      });
      if (ctrl.signal.aborted) return;

      if (fnErr) {
        setError(friendlyError(fnErr, t("groupsFromImage.readFailed")));
        setFase("elegir");
        return;
      }
      const res = data as {
        ok?: boolean;
        error?: string;
        vision_unavailable?: boolean;
        grupos?: GrupoLeido[];
        sin_grupo?: { nombre: string; confianza?: "alta" | "media" | "baja" }[];
        ilegibles?: number;
        truncado?: boolean;
        modelo_usado?: string;
        sustituido?: boolean;
      } | null;

      if (!res?.ok) {
        // El mensaje del edge ya está redactado para una persona (incluido el caso del
        // modelo sin visión, que dice qué hay que cambiar y dónde).
        setError(res?.error ?? t("groupsFromImage.readFailed"));
        setFase("elegir");
        return;
      }

      const leidos = res.grupos ?? [];
      // Los que se vieron sin grupo entran igual, con etiqueta vacía: el docente les
      // pone el grupo a mano. Descartarlos escondería gente que SÍ estaba en la clase.
      const conSinGrupo: GrupoLeido[] = [
        ...leidos,
        ...(res.sin_grupo?.length
          ? [{ etiqueta: "", participantes: res.sin_grupo.map((p) => ({ ...p })) }]
          : []),
      ];
      const nuevas = emparejarLectura(conSinGrupo, roster);
      setFilas(nuevas);

      const partes: string[] = [];
      if (res.truncado) partes.push(t("groupsFromImage.warnTruncated"));
      if (res.ilegibles) partes.push(t("groupsFromImage.warnUnreadable", { n: res.ilegibles }));
      if (res.sustituido) {
        partes.push(t("groupsFromImage.warnSubstituted", { model: res.modelo_usado ?? "" }));
      }
      setAviso(partes.length ? partes.join(" ") : null);
      setFase(nuevas.length ? "revisar" : "elegir");
      if (!nuevas.length) setError(t("groupsFromImage.nothingRead"));
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(friendlyError(e, t("groupsFromImage.readFailed")));
      setFase("elegir");
    } finally {
      abortRef.current = null;
    }
  };

  const detener = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setFase("elegir");
  };

  const actualizar = (id: string, cambios: Partial<FilaLeida>) => {
    setFilas((prev) => prev.map((f) => (f.id === id ? { ...f, ...cambios } : f)));
  };

  const ctx: ContextoPlan = {
    grupos: groups,
    miembroPorUsuario: memberByUser,
    gruposConEntrega,
    conEntregaIndividual,
    nombrePorUsuario: new Map(students.map((s) => [s.id, s.full_name])),
    groupSizeMin,
    groupSizeMax,
  };
  const plan = construirPlan(
    filas.map((f) => ({
      id: f.id,
      leido: f.leido,
      etiqueta: f.etiqueta,
      user_id: f.user_id,
      descartada: f.descartada,
    })),
    ctx,
  );

  const aplicar = async () => {
    if (plan.resumen.personas === 0) return;
    setAplicando(true);
    try {
      // 1. Crear los grupos que faltan y quedarse con sus id.
      const idPorEtiqueta = new Map(
        plan.gruposAReusar.map((g) => [g.etiqueta.trim().toLowerCase(), g.groupId]),
      );
      if (plan.gruposACrear.length) {
        const { data: creados, error: cErr } = await db
          .from("workshop_groups")
          .insert(plan.gruposACrear.map((g) => ({ workshop_id: workshopId, name: g.nombre })))
          .select("id, name");
        if (cErr || !creados) {
          toast.error(friendlyError(cErr, t("groupsFromImage.applyFailed")));
          return;
        }
        for (const g of plan.gruposACrear) {
          const fila = (creados as { id: string; name: string }[]).find((c) => c.name === g.nombre);
          if (fila) idPorEtiqueta.set(g.etiqueta.trim().toLowerCase(), fila.id);
        }
      }

      // 2. Quitar la membresía previa ANTES de insertar: el trigger
      //    `trg_one_workshop_group_per_user` rechaza estar en dos grupos del mismo
      //    taller y haría fallar el INSERT del lote entero.
      for (const m of plan.membresiasABorrar) {
        const { error: dErr } = await db
          .from("workshop_group_members")
          .delete()
          .eq("group_id", m.groupId)
          .eq("user_id", m.userId);
        if (dErr) {
          toast.error(friendlyError(dErr, t("groupsFromImage.applyFailed")));
          return;
        }
      }

      // 3. Insertar.
      const aInsertar = plan.membresiasAInsertar
        .map((m) => ({
          group_id: idPorEtiqueta.get(m.etiqueta.trim().toLowerCase()),
          user_id: m.userId,
        }))
        .filter((r): r is { group_id: string; user_id: string } => !!r.group_id);
      if (aInsertar.length) {
        const { error: iErr } = await db.from("workshop_group_members").insert(aInsertar);
        if (iErr) {
          toast.error(friendlyError(iErr, t("groupsFromImage.applyFailed")), { duration: 12000 });
          return;
        }
      }

      // La métrica que dice si esto sirve es cuántas filas corrigió el docente: si
      // corrige la mitad, la lectura no está ayudando.
      const corregidas = filas.filter(
        (f) => f.estado === "unico" && f.user_id !== f.candidatos[0]?.user_id,
      ).length;
      void logEvent({
        action: "workshop_groups.from_image",
        category: "ai",
        entityType: "workshop",
        entityId: workshopId,
        courseId,
        metadata: {
          filas: filas.length,
          asignadas: aInsertar.length,
          bloqueadas: plan.bloqueadas.length,
          corregidas_por_el_docente: corregidas,
          descartadas: filas.filter((f) => f.descartada).length,
        },
      });

      toast.success(t("groupsFromImage.applied", { n: aInsertar.length }));
      onAplicado();
      onOpenChange(false);
    } finally {
      setAplicando(false);
    }
  };

  const cerrar = async (v: boolean) => {
    if (!v && fase === "revisar" && plan.resumen.personas > 0) {
      const ok = await confirm({
        title: t("groupsFromImage.discardTitle"),
        description: t("groupsFromImage.discardDesc"),
        confirmLabel: t("common.discard", { defaultValue: "Descartar" }),
        tone: "warning",
      });
      if (!ok) return;
    }
    if (!v) detener();
    onOpenChange(v);
  };

  const etiquetasConocidas = Array.from(
    new Set([...groups.map((g) => g.name), ...filas.map((f) => f.etiqueta).filter(Boolean)]),
  );

  return (
    <Dialog open={open} onOpenChange={(v) => void cerrar(v)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageUp className="h-5 w-5" />
            {t("groupsFromImage.title")}
          </DialogTitle>
          <DialogDescription>{t("groupsFromImage.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col gap-3">
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
              {error}
            </div>
          )}
          {aviso && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs flex gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{aviso}</span>
            </div>
          )}

          {fase !== "revisar" && (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setArrastrando(true);
                }}
                onDragLeave={() => setArrastrando(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setArrastrando(false);
                  elegirArchivo(e.dataTransfer.files?.[0] ?? null);
                }}
                className={`rounded-md border-2 border-dashed p-6 text-center space-y-2 ${
                  arrastrando ? "border-primary bg-primary/5" : "border-muted"
                }`}
              >
                {vistaPrevia ? (
                  <img
                    src={vistaPrevia}
                    alt=""
                    className="mx-auto max-h-48 rounded border object-contain"
                  />
                ) : (
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                )}
                <p className="text-xs text-muted-foreground">{t("groupsFromImage.dropHint")}</p>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => elegirArchivo(e.target.files?.[0] ?? null)}
                  className="mx-auto max-w-xs"
                  disabled={fase === "leyendo"}
                />
              </div>

              <div className="space-y-1">
                <Label className="text-2xs">{t("groupsFromImage.hintLabel")}</Label>
                <Input
                  value={pista}
                  onChange={(e) => setPista(e.target.value.slice(0, 300))}
                  placeholder={t("groupsFromImage.hintPlaceholder")}
                  disabled={fase === "leyendo"}
                />
              </div>
            </>
          )}

          {fase === "revisar" && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="secondary">
                  {t("groupsFromImage.countRows", { n: filas.length })}
                </Badge>
                <Badge variant="secondary">
                  {t("groupsFromImage.countGroups", { n: plan.resumen.grupos })}
                </Badge>
                {plan.bloqueadas.length > 0 && (
                  <Badge variant="destructive">
                    {t("groupsFromImage.countBlocked", { n: plan.bloqueadas.length })}
                  </Badge>
                )}
              </div>

              {plan.avisosDeTamano.length > 0 && (
                <p className="text-2xs text-muted-foreground">
                  {plan.avisosDeTamano
                    .map((a) =>
                      t(
                        a.motivo === "min"
                          ? "groupsFromImage.sizeMin"
                          : "groupsFromImage.sizeMax",
                        { name: a.nombre, n: a.integrantes },
                      ),
                    )
                    .join(" · ")}
                </p>
              )}

              <ScrollArea className="flex-1 min-h-0 pr-2">
                <div className="space-y-2">
                  {filas.map((f) => {
                    const bloqueada = plan.bloqueadas.find((b) => b.id === f.id);
                    return (
                      <div
                        key={f.id}
                        className={`rounded-md border p-2 space-y-2 ${
                          f.descartada ? "opacity-50" : ""
                        } ${bloqueada ? "border-destructive/40" : ""}`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              {/* Lo que decía el recuadro, tal cual: es la única forma
                                  de que el docente pueda contrastar con la captura. */}
                              <span className="text-xs font-medium truncate">{f.leido}</span>
                              {f.confianza !== "alta" && (
                                <Badge variant="outline" className="text-3xs">
                                  {t(`groupsFromImage.conf_${f.confianza}`)}
                                </Badge>
                              )}
                              {f.duplicado_en_imagen && (
                                <Badge variant="outline" className="text-3xs">
                                  {t("groupsFromImage.dupInImage")}
                                </Badge>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Select
                                value={f.user_id ?? ""}
                                onValueChange={(v) => actualizar(f.id, { user_id: v || null })}
                              >
                                <SelectTrigger className="h-8 text-xs flex-1 min-w-[160px] sm:min-w-48">
                                  <SelectValue placeholder={t("groupsFromImage.pickStudent")} />
                                </SelectTrigger>
                                <SelectContent>
                                  {/* Los candidatos primero: en un ambiguo son las dos
                                      o tres opciones entre las que hay que decidir. */}
                                  {f.candidatos.map((c) => (
                                    <SelectItem key={c.user_id} value={c.user_id}>
                                      {c.full_name}
                                    </SelectItem>
                                  ))}
                                  {students
                                    .filter((s) => !f.candidatos.some((c) => c.user_id === s.id))
                                    .map((s) => (
                                      <SelectItem key={s.id} value={s.id}>
                                        {s.full_name}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                              <Input
                                value={f.etiqueta}
                                onChange={(e) => actualizar(f.id, { etiqueta: e.target.value })}
                                placeholder={t("groupsFromImage.groupPlaceholder")}
                                list={`etiquetas-${f.id}`}
                                className="h-8 text-xs w-32"
                              />
                              <datalist id={`etiquetas-${f.id}`}>
                                {etiquetasConocidas.map((e) => (
                                  <option key={e} value={e} />
                                ))}
                              </datalist>
                            </div>
                            {bloqueada && (
                              <p className="text-2xs text-destructive">
                                {t(MOTIVO_CLAVE[bloqueada.motivo], {
                                  name: bloqueada.nombre ?? f.leido,
                                })}
                              </p>
                            )}
                          </div>
                          <RowAction
                            label={t(f.descartada ? "groupsFromImage.restore" : "common.discard")}
                            icon={f.descartada ? X : Trash2}
                            tone={f.descartada ? undefined : "destructive"}
                            onClick={() => actualizar(f.id, { descartada: !f.descartada })}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {filas.length === 0 && <EmptyState text={t("groupsFromImage.empty")} />}
                </div>
              </ScrollArea>
            </>
          )}
        </div>

        <DialogFooter className="gap-2">
          {fase === "leyendo" ? (
            <>
              <span className="text-xs text-muted-foreground flex items-center gap-2 mr-auto">
                <Spinner size="sm" />
                {t("groupsFromImage.reading")}
              </span>
              <Button variant="outline" onClick={detener}>
                {t("common.stop", { defaultValue: "Detener" })}
              </Button>
            </>
          ) : fase === "revisar" ? (
            <>
              <Button variant="ghost" onClick={() => setFase("elegir")}>
                {t("groupsFromImage.another")}
              </Button>
              <Button onClick={() => void aplicar()} disabled={aplicando || plan.resumen.personas === 0}>
                {aplicando && <Spinner size="sm" className="mr-1" />}
                {/* El rótulo dice cuántas de cuántas: si hay bloqueadas, aplicar no es
                    todo-o-nada por confusión, es explícito. */}
                {plan.bloqueadas.length > 0
                  ? t("groupsFromImage.applySome", {
                      n: plan.resumen.personas,
                      total: filas.filter((f) => !f.descartada).length,
                    })
                  : t("groupsFromImage.apply", { n: plan.resumen.personas })}
              </Button>
            </>
          ) : (
            <Button onClick={() => void leer()} disabled={!archivo}>
              <ImageUp className="h-4 w-4 mr-1" />
              {t("groupsFromImage.read")}
            </Button>
          )}
        </DialogFooter>

        {/* Sin este montaje, `ensureAuthorized()` queda colgada. */}
        <aiGate.GateDialog />
      </DialogContent>
    </Dialog>
  );
}
