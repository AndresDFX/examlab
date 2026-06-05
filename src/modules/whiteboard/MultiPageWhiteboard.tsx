/**
 * MultiPageWhiteboard — wrapper sobre `WhiteboardEditor` que añade
 * soporte de múltiples hojas (pages) por pizarra standalone.
 *
 * Modelo (mig 20260811000000):
 *   - Tabla `whiteboard_pages(id, whiteboard_id, position, name, scene_json)`
 *   - Cada pizarra = N hojas. Position 0-indexed, gaps tolerados.
 *   - SessionWhiteboardDialog (1:1 con sesión) NO usa este wrapper:
 *     sigue con `WhiteboardEditor` directo + `attendance_sessions.whiteboard_scene`.
 *
 * Responsabilidades:
 *   - Cargar la lista de hojas al montar.
 *   - Si la pizarra no tiene hojas (edge case post-creación), crea una.
 *   - Render: tab strip arriba (hoja 1, hoja 2, …, + Agregar) + editor
 *     debajo.
 *   - Al cambiar de tab, re-monta el `WhiteboardEditor` con un nuevo
 *     `key={pageId}` para que el dynamic import de Excalidraw refresque
 *     el initialData (Excalidraw NO re-procesa initialData en updates).
 *   - Add/remove/rename hojas inline.
 *   - Auto-save por hoja: el `onPersist` del editor mapea al UPDATE de
 *     la página activa (debounce 1.5s vive en `WhiteboardEditor`).
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { WhiteboardEditor, type WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface WhiteboardPage {
  id: string;
  whiteboard_id: string;
  position: number;
  name: string | null;
  scene_json: WhiteboardScene;
}

interface Props {
  whiteboardId: string;
  /** Si true, deshabilita edición — alumno viendo pizarra compartida.
   *  Los tabs siguen siendo navegables pero no se puede add/delete/rename. */
  readOnly?: boolean;
  /** Clase Tailwind del contenedor. Se pasa al div root del wrapper;
   *  el editor interno toma h-full del flex-1. */
  className?: string;
}

export function MultiPageWhiteboard({ whiteboardId, readOnly, className }: Props) {
  const confirm = useConfirm();
  const [pages, setPages] = useState<WhiteboardPage[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Modo "rename inline" — guarda el id de la página y el draft del nombre.
  // Cuando es null, no hay rename activo.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await db
        .from("whiteboard_pages")
        .select("id, whiteboard_id, position, name, scene_json")
        .eq("whiteboard_id", whiteboardId)
        .order("position", { ascending: true });
      if (error) {
        setLoadError(friendlyError(error, "No pudimos cargar las hojas de la pizarra."));
        return;
      }
      let rows = (data ?? []) as WhiteboardPage[];
      // Edge case: la pizarra existe pero no tiene hojas (la migración
      // backfill no corrió todavía en este entorno, o un admin las
      // borró). Creamos una hoja en blanco en position=0.
      if (rows.length === 0 && !readOnly) {
        const { data: created, error: insErr } = await db
          .from("whiteboard_pages")
          .insert({
            whiteboard_id: whiteboardId,
            position: 0,
            scene_json: { elements: [], appState: {} },
          })
          .select("id, whiteboard_id, position, name, scene_json")
          .single();
        if (insErr || !created) {
          setLoadError(friendlyError(insErr, "No pudimos inicializar la primera hoja."));
          return;
        }
        rows = [created as WhiteboardPage];
      }
      setPages(rows);
      setActivePageId((curr) => curr ?? rows[0]?.id ?? null);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar las hojas de la pizarra."));
    } finally {
      setLoading(false);
    }
  }, [whiteboardId, readOnly]);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  const activePage = pages.find((p) => p.id === activePageId) ?? null;

  /** Auto-save callback que recibe el WhiteboardEditor con la escena
   *  actualizada. Guarda en la fila de la página activa. NO mutamos
   *  el state local porque Excalidraw no re-lee initialData en updates;
   *  el cambio queda en el componente Excalidraw y persiste server-side. */
  const persistActivePage = useCallback(
    async (scene: WhiteboardScene) => {
      if (!activePageId) return;
      try {
        const { error } = await db
          .from("whiteboard_pages")
          .update({ scene_json: scene })
          .eq("id", activePageId);
        if (error) {
          toast.error(friendlyError(error, "No se pudo guardar la hoja"));
        }
      } catch (e) {
        toast.error(friendlyError(e, "No se pudo guardar la hoja"));
      }
    },
    [activePageId],
  );

  const addPage = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Nueva position = max actual + 1 (gaps tolerados).
      const nextPos = pages.length === 0 ? 0 : Math.max(...pages.map((p) => p.position)) + 1;
      const { data, error } = await db
        .from("whiteboard_pages")
        .insert({
          whiteboard_id: whiteboardId,
          position: nextPos,
          scene_json: { elements: [], appState: {} },
        })
        .select("id, whiteboard_id, position, name, scene_json")
        .single();
      if (error || !data) {
        toast.error(friendlyError(error, "No se pudo agregar la hoja"));
        return;
      }
      const newPage = data as WhiteboardPage;
      setPages((prev) => [...prev, newPage]);
      setActivePageId(newPage.id);
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo agregar la hoja"));
    } finally {
      setBusy(false);
    }
  };

  const deletePage = async (pageId: string) => {
    if (busy) return;
    // No permitir borrar la última hoja — al menos una debe quedar.
    if (pages.length <= 1) {
      toast.info("La pizarra debe tener al menos una hoja.");
      return;
    }
    const page = pages.find((p) => p.id === pageId);
    if (!page) return;
    const label = page.name ?? `Hoja ${page.position + 1}`;
    const ok = await confirm({
      title: `¿Eliminar "${label}"?`,
      description: "Se elimina toda la hoja y su contenido. Esta acción no se puede deshacer.",
      tone: "destructive",
      confirmLabel: "Eliminar",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { error } = await db.from("whiteboard_pages").delete().eq("id", pageId);
      if (error) {
        toast.error(friendlyError(error, "No se pudo eliminar la hoja"));
        return;
      }
      const remaining = pages.filter((p) => p.id !== pageId);
      setPages(remaining);
      // Si la activa fue borrada, switch a la primera restante.
      if (activePageId === pageId) {
        setActivePageId(remaining[0]?.id ?? null);
      }
      toast.success("Hoja eliminada");
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo eliminar la hoja"));
    } finally {
      setBusy(false);
    }
  };

  const startRename = (page: WhiteboardPage) => {
    setRenamingId(page.id);
    setRenameDraft(page.name ?? "");
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };
  const saveRename = async () => {
    if (!renamingId) return;
    const newName = renameDraft.trim();
    setBusy(true);
    try {
      const { error } = await db
        .from("whiteboard_pages")
        .update({ name: newName || null })
        .eq("id", renamingId);
      if (error) {
        toast.error(friendlyError(error, "No se pudo renombrar la hoja"));
        return;
      }
      setPages((prev) =>
        prev.map((p) => (p.id === renamingId ? { ...p, name: newName || null } : p)),
      );
      cancelRename();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo renombrar la hoja"));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center gap-2 text-sm text-muted-foreground",
          className,
        )}
      >
        <Spinner size="sm" /> Cargando hojas…
      </div>
    );
  }
  if (loadError) {
    return (
      <div className={cn("flex items-center justify-center p-4", className)}>
        <ErrorState
          message="No pudimos cargar las hojas"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }
  if (!activePage) {
    // No debería pasar (load garantiza al menos una hoja en !readOnly),
    // pero si el alumno entra a una pizarra sin hojas, mostramos vacío.
    return (
      <div
        className={cn(
          "flex items-center justify-center p-4 text-sm text-muted-foreground",
          className,
        )}
      >
        Esta pizarra no tiene hojas todavía.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      {/* Tab strip arriba. overflow-x-auto en mobile cuando hay muchas
          hojas — cada tab tiene whitespace-nowrap. */}
      <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1.5 overflow-x-auto shrink-0">
        {pages.map((page) => {
          const isActive = page.id === activePageId;
          const isRenaming = renamingId === page.id;
          const label = page.name ?? `Hoja ${page.position + 1}`;
          return (
            <div
              key={page.id}
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors",
                isActive
                  ? "bg-background border border-border shadow-sm"
                  : "hover:bg-background/60 border border-transparent",
              )}
            >
              {isRenaming ? (
                <>
                  <Input
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename();
                      if (e.key === "Escape") cancelRename();
                    }}
                    autoFocus
                    placeholder={`Hoja ${page.position + 1}`}
                    className="h-6 w-32 text-xs px-1.5"
                    disabled={busy}
                  />
                  <button
                    type="button"
                    onClick={() => void saveRename()}
                    disabled={busy}
                    className="text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
                    aria-label="Guardar nombre"
                    title="Guardar"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelRename}
                    disabled={busy}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Cancelar"
                    title="Cancelar"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setActivePageId(page.id)}
                    className={cn(
                      "font-medium",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </button>
                  {!readOnly && isActive && (
                    <>
                      <button
                        type="button"
                        onClick={() => startRename(page)}
                        className="text-muted-foreground hover:text-foreground opacity-70 hover:opacity-100"
                        aria-label="Renombrar hoja"
                        title="Renombrar"
                        disabled={busy}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deletePage(page.id)}
                        className="text-muted-foreground hover:text-destructive opacity-70 hover:opacity-100"
                        aria-label="Eliminar hoja"
                        title="Eliminar hoja"
                        disabled={busy || pages.length <= 1}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void addPage()}
            disabled={busy}
            className="h-7 text-xs shrink-0"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Agregar hoja
          </Button>
        )}
      </div>

      {/* Editor de la página activa. `key={activePageId}` fuerza re-mount
          al cambiar de hoja: Excalidraw NO re-procesa initialData en
          updates de prop, así que el key change es la forma estándar
          de re-inicializar el canvas con la escena de la nueva hoja. */}
      <div className="flex-1 min-h-0">
        <WhiteboardEditor
          key={activePage.id}
          scene={activePage.scene_json}
          onPersist={persistActivePage}
          readOnly={readOnly}
          className="w-full h-full"
        />
      </div>
    </div>
  );
}
