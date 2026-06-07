/**
 * Panel CRUD de Asignaturas (Admin).
 *
 * La asignatura es la materia abstracta del plan ("Programación II").
 * Un curso es una INSTANCIA (grupo X, periodo Y). Asociar cursos a
 * asignaturas permite reportes consolidados — "todos los cursos de
 * Programación II históricamente" en N grupos / periodos.
 *
 * Filtro por programa habilita gestión rápida cuando hay muchas
 * asignaturas (típico: 30-60 por programa).
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ErrorState, TableEmpty } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { SearchInput } from "@/components/ui/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { BookOpen, Plus, Pencil, Trash2, BookOpenCheck, FilePlus2 } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";
import { useNavigate } from "@tanstack/react-router";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface EvalWeights {
  exam_weight?: number;
  workshop_weight?: number;
  project_weight?: number;
  attendance_weight?: number;
}

interface Subject {
  id: string;
  name: string;
  code: string | null;
  program_id: string | null;
  semestre: number | null;
  credits: number | null;
  description: string | null;
  active: boolean;
  // Campos de definición (lo que se dicta) — todos opcionales.
  objetivos: string | null;
  contenidos: string | null;
  sistema_evaluacion: EvalWeights | null;
  bibliografia: string | null;
  intensidad_horaria: number | null;
  course_count?: number;
}

interface Program {
  id: string;
  name: string;
}

interface Draft {
  id: string | null;
  name: string;
  code: string;
  program_id: string | null;
  semestre: number | null;
  credits: number | null;
  description: string;
  active: boolean;
  objetivos: string;
  contenidos: string;
  bibliografia: string;
  intensidad_horaria: number | null;
  // Pesos default de evaluación. Suma esperada = 100. Si suma 0 →
  // no se persiste (sistema_evaluacion queda NULL en DB y el curso
  // hereda los defaults del sistema).
  exam_weight: number;
  workshop_weight: number;
  project_weight: number;
  attendance_weight: number;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  code: "",
  program_id: null,
  semestre: null,
  credits: null,
  description: "",
  active: true,
  objetivos: "",
  contenidos: "",
  bibliografia: "",
  intensidad_horaria: null,
  exam_weight: 0,
  workshop_weight: 0,
  project_weight: 0,
  attendance_weight: 0,
};

export function AdminAcademicSubjectsPanel() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Subject[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [programFilter, setProgramFilter] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const [subRes, progRes, courseCountRes] = await Promise.all([
      db
        .from("academic_subjects")
        .select(
          "id, name, code, program_id, semestre, credits, description, active, objetivos, contenidos, sistema_evaluacion, bibliografia, intensidad_horaria",
        )
        .order("name"),
      db.from("academic_programs").select("id, name").order("name"),
      // Count de cursos por subject_id. Lo agregamos al lado para
      // mostrar 'Cursos: N' en la fila (tracking integral por
      // programa/asignatura que pidió el admin).
      db.from("courses").select("subject_id"),
    ]);
    if (subRes.error) {
      setLoadError(friendlyError(subRes.error, "No pudimos cargar las asignaturas."));
      setLoading(false);
      return;
    }
    const countBySubject = new Map<string, number>();
    for (const c of (courseCountRes.data ?? []) as Array<{ subject_id: string | null }>) {
      if (c.subject_id) {
        countBySubject.set(c.subject_id, (countBySubject.get(c.subject_id) ?? 0) + 1);
      }
    }
    const subjects: Subject[] = ((subRes.data ?? []) as Subject[]).map((s) => ({
      ...s,
      course_count: countBySubject.get(s.id) ?? 0,
    }));
    setRows(subjects);
    setPrograms((progRes.data ?? []) as Program[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const programNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of programs) m.set(p.id, p.name);
    return m;
  }, [programs]);

  const filtered = useMemo(() => {
    let result = rows;
    if (programFilter !== "all") {
      result = result.filter((r) => r.program_id === programFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.code?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [rows, search, programFilter]);

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const openEdit = (r: Subject) => {
    const ev = r.sistema_evaluacion ?? {};
    setDraft({
      id: r.id,
      name: r.name,
      code: r.code ?? "",
      program_id: r.program_id,
      semestre: r.semestre,
      credits: r.credits,
      description: r.description ?? "",
      active: r.active,
      objetivos: r.objetivos ?? "",
      contenidos: r.contenidos ?? "",
      bibliografia: r.bibliografia ?? "",
      intensidad_horaria: r.intensidad_horaria,
      exam_weight: Number(ev.exam_weight ?? 0),
      workshop_weight: Number(ev.workshop_weight ?? 0),
      project_weight: Number(ev.project_weight ?? 0),
      attendance_weight: Number(ev.attendance_weight ?? 0),
    });
    setOpen(true);
  };

  const save = async () => {
    if (!user) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error("El nombre es obligatorio");
      return;
    }
    // Pesos de evaluación: si el admin no completó ninguno (suma 0),
    // dejamos sistema_evaluacion en NULL — el curso instanciado usa
    // los defaults del sistema. Si completó algo, validamos la suma.
    const evalSum =
      draft.exam_weight + draft.workshop_weight + draft.project_weight + draft.attendance_weight;
    if (evalSum > 0 && Math.abs(evalSum - 100) > 0.01) {
      toast.error(`Los pesos del sistema de evaluación deben sumar 100 (actualmente ${evalSum})`);
      return;
    }
    setSaving(true);
    const payload = {
      name,
      code: draft.code.trim() || null,
      program_id: draft.program_id,
      semestre: draft.semestre,
      credits: draft.credits,
      description: draft.description.trim() || null,
      active: draft.active,
      objetivos: draft.objetivos.trim() || null,
      contenidos: draft.contenidos.trim() || null,
      bibliografia: draft.bibliografia.trim() || null,
      intensidad_horaria: draft.intensidad_horaria,
      sistema_evaluacion:
        evalSum > 0
          ? {
              exam_weight: draft.exam_weight,
              workshop_weight: draft.workshop_weight,
              project_weight: draft.project_weight,
              attendance_weight: draft.attendance_weight,
            }
          : null,
      updated_by: user.id,
    };
    const { error } = draft.id
      ? await db.from("academic_subjects").update(payload).eq("id", draft.id)
      : await db.from("academic_subjects").insert(payload);
    setSaving(false);
    if (error) {
      toast.error(friendlyError(error, "No se pudo guardar la asignatura"));
      return;
    }
    void logEvent({
      action: draft.id ? "subject.updated" : "subject.created",
      category: "academic",
      severity: "info",
      entityType: "academic_subject",
      entityId: draft.id ?? undefined,
      entityName: name,
      metadata: {
        code: payload.code,
        program_id: payload.program_id,
        semestre: payload.semestre,
        credits: payload.credits,
      },
    });
    toast.success(draft.id ? "Asignatura actualizada" : "Asignatura creada");
    setOpen(false);
    void load();
  };

  const remove = async (r: Subject) => {
    if ((r.course_count ?? 0) > 0) {
      const ok = await confirm({
        title: `¿Eliminar "${r.name}"?`,
        description: `Hay ${r.course_count} curso(s) asociados. Quedarán con subject_id NULL pero no se borran. Esta acción no se puede deshacer.`,
        confirmLabel: "Eliminar",
        tone: "destructive",
      });
      if (!ok) return;
    } else {
      const ok = await confirm({
        title: `¿Eliminar "${r.name}"?`,
        description: "Esta acción no se puede deshacer.",
        confirmLabel: "Eliminar",
        tone: "destructive",
      });
      if (!ok) return;
    }
    const { error } = await db.from("academic_subjects").delete().eq("id", r.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    void logEvent({
      action: "subject.deleted",
      category: "academic",
      severity: "warning",
      entityType: "academic_subject",
      entityId: r.id,
      entityName: r.name,
      metadata: { course_count: r.course_count ?? 0 },
    });
    toast.success("Asignatura eliminada");
    void load();
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-cyan-500" />
          Asignaturas / Materias
        </CardTitle>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Nueva asignatura
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          La materia abstracta del plan de estudios. Sirve para universidad (asignaturas
          por semestre), colegio (materias por grado) o instituto técnico (módulos por
          nivel). Los cursos se asocian a una asignatura desde su formulario — una misma
          &quot;Programación II&quot; / &quot;Matemáticas 5°&quot; puede tener N cursos
          (grupos/periodos distintos).
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Buscar por nombre o código…"
            />
          </div>
          <Select value={programFilter} onValueChange={setProgramFilter}>
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los programas</SelectItem>
              {programs.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando…
          </div>
        ) : loadError ? (
          <ErrorState
            message="No pudimos cargar"
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-[260px]">Nombre</TableHead>
                  <TableHead className="hidden sm:table-cell w-24">Código</TableHead>
                  <TableHead className="hidden md:table-cell">Programa / Nivel</TableHead>
                  <TableHead className="hidden sm:table-cell w-20 text-center">Grado</TableHead>
                  <TableHead className="hidden sm:table-cell w-20 text-center">Cr.</TableHead>
                  <TableHead className="w-20 text-center">Cursos</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableEmpty
                    colSpan={7}
                    text="Sin asignaturas"
                    hint="Crea la primera asignatura con el botón de arriba."
                  />
                ) : (
                  filtered.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        <div className="truncate" title={r.name}>
                          {r.name}
                          {!r.active && (
                            <Badge variant="outline" className="ml-2 text-[10px]">
                              inactiva
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                        {r.code ?? "—"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground truncate">
                        {r.program_id ? (programNameById.get(r.program_id) ?? "—") : "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center tabular-nums">
                        {r.semestre ?? "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center tabular-nums">
                        {r.credits ?? "—"}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {r.course_count ?? 0}
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            { label: "Editar", icon: Pencil, onClick: () => openEdit(r) },
                            {
                              // Instanciar un curso a partir de esta asignatura.
                              // Pasamos el subjectId vía search param para que
                              // la ruta de cursos abra el dialog pre-rellenado
                              // con name, program_id, semestre y pesos default.
                              label: "Crear curso desde esta asignatura",
                              icon: FilePlus2,
                              onClick: () =>
                                void navigate({
                                  to: "/app/admin/courses",
                                  search: { fromSubject: r.id } as never,
                                }),
                              separatorBefore: true,
                            },
                            (r.course_count ?? 0) > 0 && {
                              label: `Ver cursos asociados (${r.course_count})`,
                              icon: BookOpenCheck,
                              onClick: () =>
                                void navigate({
                                  to: "/app/admin/courses",
                                  search: { subjectFilter: r.id } as never,
                                }),
                            },
                            {
                              label: "Eliminar",
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
                              onClick: () => void remove(r),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft.id ? "Editar asignatura" : "Nueva asignatura"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-3">
              <div className="space-y-1">
                <Label required>Nombre</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Programación II"
                />
              </div>
              <div className="space-y-1">
                <Label>Código</Label>
                <Input
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder="PRGII"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Programa / Nivel</Label>
              <Select
                value={draft.program_id ?? "__none__"}
                onValueChange={(v) =>
                  setDraft({ ...draft, program_id: v === "__none__" ? null : v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Sin programa (transversal)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sin programa (transversal)</SelectItem>
                  {programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Grado / Semestre / Cuatrimestre</Label>
                <Input
                  type="number"
                  min={1}
                  max={12}
                  value={draft.semestre ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      semestre: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="1–12"
                />
              </div>
              <div className="space-y-1">
                <Label>Créditos</Label>
                <Input
                  type="number"
                  min={0}
                  max={20}
                  value={draft.credits ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      credits: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="0–20"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Descripción</Label>
              <Textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Resumen breve para mostrar en listados"
                rows={2}
              />
            </div>

            {/* ── Definición de qué se dicta (template del curso) ─────────────
                Estos campos no se autocompletan en el curso instanciado al pie
                de la letra; sirven como referencia institucional + para que
                los informes (acuerdo pedagógico, acta) puedan citarlos. */}
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <p className="text-sm font-medium">Definición del plan</p>
              <div className="space-y-1">
                <Label className="text-xs">Objetivos</Label>
                <Textarea
                  value={draft.objetivos}
                  onChange={(e) => setDraft({ ...draft, objetivos: e.target.value })}
                  placeholder="Propósito general de la asignatura"
                  rows={3}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Contenidos / temáticas</Label>
                <Textarea
                  value={draft.contenidos}
                  onChange={(e) => setDraft({ ...draft, contenidos: e.target.value })}
                  placeholder="Módulos o unidades temáticas (uno por línea)"
                  rows={4}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Bibliografía sugerida</Label>
                <Textarea
                  value={draft.bibliografia}
                  onChange={(e) => setDraft({ ...draft, bibliografia: e.target.value })}
                  placeholder="Referencias principales (una por línea)"
                  rows={2}
                />
              </div>
              <div>
                <Label className="text-xs">Intensidad horaria semanal</Label>
                <Input
                  type="number"
                  min={0}
                  max={60}
                  value={draft.intensidad_horaria ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      intensidad_horaria:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="Ej: 4"
                  className="w-32"
                />
              </div>
            </div>

            {/* ── Sistema de evaluación sugerido (% por tipo) ─────────────
                Pesos default que el curso instanciado puede heredar para
                ahorrar configuración. Si se dejan en 0 (default), el curso
                usa los defaults del sistema. */}
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <p className="text-sm font-medium">
                Sistema de evaluación sugerido{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (los pesos deben sumar 100; déjalo todo en 0 para usar defaults)
                </span>
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs">% Exámenes</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.exam_weight}
                    onChange={(e) =>
                      setDraft({ ...draft, exam_weight: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">% Talleres</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.workshop_weight}
                    onChange={(e) =>
                      setDraft({ ...draft, workshop_weight: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">% Proyectos</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.project_weight}
                    onChange={(e) =>
                      setDraft({ ...draft, project_weight: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">% Asistencia</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.attendance_weight}
                    onChange={(e) =>
                      setDraft({ ...draft, attendance_weight: Number(e.target.value) || 0 })
                    }
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                Suma actual:{" "}
                <strong>
                  {draft.exam_weight +
                    draft.workshop_weight +
                    draft.project_weight +
                    draft.attendance_weight}
                </strong>
                {" "}/ 100
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Switch
                checked={draft.active}
                onCheckedChange={(v) => setDraft({ ...draft, active: v })}
              />
              <Label className="text-sm">Activa (aparece en el selector de curso)</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Guardando…" : draft.id ? "Guardar cambios" : "Crear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
