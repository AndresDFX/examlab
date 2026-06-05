/**
 * Whiteboards (docente) — `/app/teacher/whiteboards`
 *
 * Lista de pizarras standalone del docente + creación + eliminación.
 * El editor vive en una ruta hija `/$id` para que cada pizarra tenga
 * URL propia (compartible, bookmarkable).
 *
 * Las pizarras de SESIÓN no aparecen acá — viven dentro de la sesión
 * presencial (attendance) y se acceden desde el botón "Pizarra" allí.
 *
 * RLS: el docente ve solo las suyas. Admin/SA ven todas en el tenant.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import { DateCell } from "@/components/ui/date-cell";
import { SearchInput } from "@/components/ui/search-input";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { Plus, Trash2, Palette } from "lucide-react";

export const Route = createFileRoute("/app/teacher/whiteboards")({
  component: TeacherWhiteboards,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Whiteboard {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  course_id: string | null;
  is_shared_with_course: boolean;
}

function TeacherWhiteboards() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [items, setItems] = useState<Whiteboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  // Create dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("whiteboards")
      .select(
        "id, owner_id, name, description, created_at, updated_at, course_id, is_shared_with_course",
      )
      .order("updated_at", { ascending: false });
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar tus pizarras."));
      setLoading(false);
      return;
    }
    setItems((data ?? []) as Whiteboard[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (w) => w.name.toLowerCase().includes(q) || (w.description ?? "").toLowerCase().includes(q),
    );
  }, [items, search]);

  // Grid de cards — defaults consistentes con otras vistas de cards del
  // estudiante (cursos, exámenes, talleres): 12 / 6-12-24-48. Las cards
  // son más altas que filas de tabla, por eso el page size baja desde
  // 25 (default de grids) a 12.
  const pagination = usePagination(filtered, {
    defaultPageSize: 12,
    pageSizes: [6, 12, 24, 48],
    storageKey: "examlab_pag:teacher_whiteboards",
    resetKey: search,
  });

  const createWhiteboard = async () => {
    if (!user) return;
    if (!draftName.trim()) {
      toast.error("Dale un nombre a la pizarra");
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await db
        .from("whiteboards")
        .insert({
          owner_id: user.id,
          name: draftName.trim(),
          description: draftDescription.trim() || null,
        })
        .select("id")
        .single();
      if (error || !data) {
        toast.error(friendlyError(error, "No se pudo crear la pizarra"));
        return;
      }
      toast.success("Pizarra creada");
      setCreateOpen(false);
      setDraftName("");
      setDraftDescription("");
      // Navegamos directo al editor — el flujo "click para abrir" es
      // implícito tras crear.
      navigate({ to: "/app/teacher/whiteboards/$id", params: { id: data.id } });
    } finally {
      setSaving(false);
    }
  };

  const deleteWhiteboard = async (w: Whiteboard) => {
    const ok = await confirm({
      title: "¿Eliminar pizarra?",
      description: `"${w.name}" se eliminará permanentemente, junto con todo su contenido. Esta acción no se puede deshacer.`,
      tone: "destructive",
      confirmLabel: "Eliminar",
    });
    if (!ok) return;
    const { error } = await db.from("whiteboards").delete().eq("id", w.id);
    if (error) {
      toast.error(friendlyError(error, "No se pudo eliminar la pizarra"));
      return;
    }
    toast.success("Pizarra eliminada");
    setItems((prev) => prev.filter((p) => p.id !== w.id));
  };

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<Palette className="h-6 w-6 text-primary" />}
          title="Pizarras"
          subtitle="Crea pizarras en blanco para explicar conceptos a tus alumnos o pensar en libertad."
        />
        <ErrorState
          message="No pudimos cargar tus pizarras"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Palette className="h-6 w-6 text-primary" />}
        title="Pizarras"
        subtitle={
          items.length > 0
            ? `${items.length} pizarra${items.length === 1 ? "" : "s"}`
            : "Crea pizarras en blanco para explicar conceptos a tus alumnos o pensar en libertad."
        }
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Nueva pizarra
          </Button>
        }
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar por nombre o descripción…"
          />
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
              <Spinner size="sm" /> Cargando…
            </div>
          ) : filtered.length === 0 ? (
            <TableEmpty
              icon={Palette}
              title="No tienes pizarras todavía"
              description={
                search.trim()
                  ? "Ningún resultado coincide con tu búsqueda."
                  : "Crea tu primera pizarra para escribir, dibujar y explicar conceptos a tu manera."
              }
              action={
                !search.trim() ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-4 w-4 mr-1" />
                    Crear pizarra
                  </Button>
                ) : undefined
              }
            />
          ) : (
            // Grid de cards (no Table) — consistente con los otros
            // listados visuales del producto (cursos, exámenes, talleres
            // del estudiante). 1 col mobile → 2 sm → 3 lg.
            //
            // Cada card es: link al editor (Link wrapper) + descripción +
            // metadata abajo + ícono delete arriba a la derecha. El
            // delete tiene `stopPropagation` para que clickearlo no
            // dispare la navegación del Link.
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {pagination.paginatedItems.map((w) => (
                <Link
                  key={w.id}
                  to="/app/teacher/whiteboards/$id"
                  params={{ id: w.id }}
                  className="group relative rounded-lg border bg-card hover:bg-muted/40 hover:border-primary/40 transition-colors p-4 flex flex-col gap-2 min-h-[8rem]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Palette className="h-4 w-4 text-violet-500 shrink-0" />
                      <h3 className="font-semibold text-base leading-tight truncate" title={w.name}>
                        {w.name}
                      </h3>
                    </div>
                    {/* Delete inline en la card. shrink-0 + tone
                        destructive. e.preventDefault evita que el click
                        navegue al editor. */}
                    <span className="shrink-0 -mt-1 -mr-1">
                      <RowAction
                        label="Eliminar"
                        icon={Trash2}
                        tone="destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void deleteWhiteboard(w);
                        }}
                      />
                    </span>
                  </div>
                  {w.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{w.description}</p>
                  )}
                  <div className="mt-auto pt-2 text-[11px] text-muted-foreground tabular-nums flex items-center gap-1">
                    <span>Última edición:</span>
                    <DateCell value={w.updated_at} variant="datetime" />
                  </div>
                </Link>
              ))}
            </div>
          )}
          <DataPagination state={pagination} entityNamePlural="pizarras" />
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nueva pizarra</DialogTitle>
            <DialogDescription>
              Una pizarra en blanco que solo tú ves. Podés compartirla con un curso después desde la
              pizarra misma.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required>Nombre</Label>
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Ej: Conceptos de POO, Clase 3"
                autoFocus
              />
            </div>
            <div>
              <Label>Descripción (opcional)</Label>
              <Textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={2}
                placeholder="Notas, contexto, recordatorios"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void createWhiteboard()} disabled={saving}>
              {saving && <Spinner size="sm" className="mr-1" />}
              Crear y abrir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
