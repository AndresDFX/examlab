/**
 * MultiPageWhiteboard — wrapper que añade soporte multi-hoja a las
 * pizarras standalone.
 *
 * Cada hoja tiene un `page_type`:
 *   - 'drawing': escena Excalidraw → renderiza `<WhiteboardEditor>`.
 *   - 'text': markdown editor → renderiza `<TextPageEditor>`.
 *   - 'code': editor + compilador → renderiza `<CodePageEditor>` (mig 20261410000000).
 *   - 'console': consola Linux real (v86) → renderiza `<V86Console>` (mig 20261410000000).
 *
 * Schema (migs 20260811000000 + 20260812000000 + 20261410000000):
 *   - `whiteboard_pages(id, whiteboard_id, position, name, scene_json,
 *      page_type, text_content, code_language, code_source, last_stdout,
 *      last_stderr, last_exit_code, last_executed_at, console_transcript)`
 *   - Cada pizarra = N hojas. Position 0-indexed, gaps tolerados.
 *
 * UX cuando hay muchas hojas (rediseño V2):
 *   - Tab strip con scroll horizontal nativo + flechas ← → que
 *     scrollean ~200px por click.
 *   - Auto-scroll del active tab a la vista al cambiar de hoja.
 *   - Dropdown "Ver todas las hojas" con la lista vertical completa +
 *     búsqueda — para saltar directo a una hoja específica sin
 *     scrollear el strip.
 *   - Tab max-w para que nombres largos no consuman el strip.
 *   - "+ Agregar" se convirtió en DropdownMenu con dos opciones
 *     (Hoja de dibujo / Hoja de texto).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  List as ListIcon,
  Palette,
  FileText,
  Code2,
  Terminal,
  Search,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useTranslation } from "react-i18next";
import { WhiteboardEditor, type WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";
import { TextPageEditor } from "@/modules/whiteboard/TextPageEditor";
import { CodePageEditor } from "@/modules/whiteboard/CodePageEditor";
import { V86Console } from "@/modules/serverconsole/V86Console";
import { getStarterCode } from "@/modules/code/CodeEditor";
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

type PageType = "drawing" | "text" | "code" | "console";

interface WhiteboardPage {
  id: string;
  whiteboard_id: string;
  position: number;
  name: string | null;
  page_type: PageType;
  scene_json: WhiteboardScene;
  text_content: string | null;
  // Hojas 'code' (compilador) — mig 20261410000000.
  code_language: string | null;
  code_source: string | null;
  last_stdout: string | null;
  last_stderr: string | null;
  last_exit_code: number | null;
  last_executed_at: string | null;
  // Hojas 'console' (Linux real v86) — transcript de la sesión.
  console_transcript: string | null;
}

/** Icono lucide por tipo de hoja (sidebar tab + dropdown de lista). */
function pageIcon(pt: PageType) {
  return pt === "text" ? FileText : pt === "code" ? Code2 : pt === "console" ? Terminal : Palette;
}
/** Color del icono por tipo de hoja — ancla visual consistente. */
function pageIconColor(pt: PageType) {
  return pt === "text"
    ? "text-sky-500"
    : pt === "code"
      ? "text-indigo-500"
      : pt === "console"
        ? "text-emerald-500"
        : "text-violet-500";
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

const PAGE_SELECT_COLS =
  "id, whiteboard_id, position, name, page_type, scene_json, text_content, code_language, code_source, last_stdout, last_stderr, last_exit_code, last_executed_at, console_transcript";

const EMPTY_SCENE: WhiteboardScene = { elements: [], appState: {} };

// Persistencia de la hoja activa por pizarra. WHY: el componente se desmonta
// al salir de la pizarra; al volver, activePageId arranca en null y load()
// caía siempre a rows[0] ("hoja inicial"). Guardamos el id de la última hoja
// vista en localStorage (namespaceado por whiteboardId) para restaurarla.
const ACTIVE_PAGE_KEY = (whiteboardId: string) => `examlab_wb_active_page:${whiteboardId}`;

function readStoredActivePage(whiteboardId: string): string | null {
  try {
    return localStorage.getItem(ACTIVE_PAGE_KEY(whiteboardId));
  } catch {
    return null; // SSR / storage deshabilitado (incógnito/cuota)
  }
}

function writeStoredActivePage(whiteboardId: string, pageId: string | null) {
  try {
    if (pageId) localStorage.setItem(ACTIVE_PAGE_KEY(whiteboardId), pageId);
    else localStorage.removeItem(ACTIVE_PAGE_KEY(whiteboardId));
  } catch {
    /* no-op */
  }
}

export function MultiPageWhiteboard({ whiteboardId, readOnly, className }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [pages, setPages] = useState<WhiteboardPage[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Búsqueda dentro del dropdown "Ver todas las hojas".
  const [pageListSearch, setPageListSearch] = useState("");
  const [pageListOpen, setPageListOpen] = useState(false);
  // Dialog de creación de hoja: el nombre es OBLIGATORIO. `newPageKind`
  // guarda el tipo elegido (drawing/text) y abre el dialog; null = cerrado.
  const [newPageKind, setNewPageKind] = useState<PageType | null>(null);
  const [newPageName, setNewPageName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await db
        .from("whiteboard_pages")
        .select(PAGE_SELECT_COLS)
        .eq("whiteboard_id", whiteboardId)
        .order("position", { ascending: true });
      if (error) {
        setLoadError(friendlyError(error, t("hc_modulesWhiteboardMultiPageWhiteboard.loadPagesError")));
        return;
      }
      let rows = (data ?? []) as WhiteboardPage[];
      // Edge case: la pizarra existe pero no tiene hojas (la migración
      // backfill no corrió todavía en este entorno, o un admin las
      // borró). Creamos una hoja de dibujo en blanco en position=0.
      if (rows.length === 0 && !readOnly) {
        const { data: created, error: insErr } = await db
          .from("whiteboard_pages")
          .insert({
            whiteboard_id: whiteboardId,
            position: 0,
            page_type: "drawing",
            scene_json: EMPTY_SCENE,
          })
          .select(PAGE_SELECT_COLS)
          .single();
        if (insErr || !created) {
          setLoadError(friendlyError(insErr, t("hc_modulesWhiteboardMultiPageWhiteboard.initFirstPageError")));
          return;
        }
        rows = [created as WhiteboardPage];
      }
      setPages(rows);
      setActivePageId((curr) => {
        // 1) si ya hay una hoja activa válida en memoria (re-load por
        //    retryNonce o cambio de readOnly, sin desmontaje), respetarla.
        if (curr && rows.some((r) => r.id === curr)) return curr;
        // 2) restaurar la hoja persistida si todavía existe en las filas
        //    cargadas. Leer localStorage acá es seguro: load() corre dentro
        //    de un effect (post-mount), NO en render → no hay hydration mismatch.
        const stored = readStoredActivePage(whiteboardId);
        if (stored && rows.some((r) => r.id === stored)) return stored;
        // 3) fallback a la primera hoja (comportamiento previo).
        return rows[0]?.id ?? null;
      });
    } catch (e) {
      setLoadError(friendlyError(e, t("hc_modulesWhiteboardMultiPageWhiteboard.loadPagesError")));
    } finally {
      setLoading(false);
    }
  }, [whiteboardId, readOnly, t]);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  const activePage = pages.find((p) => p.id === activePageId) ?? null;

  /** Persist de hoja DRAWING — guarda en `scene_json`. */
  const persistDrawingPage = useCallback(
    async (scene: WhiteboardScene) => {
      if (!activePageId) return;
      try {
        const { error } = await db
          .from("whiteboard_pages")
          .update({ scene_json: scene })
          .eq("id", activePageId);
        if (error) toast.error(friendlyError(error, t("hc_modulesWhiteboardMultiPageWhiteboard.savePageError")));
      } catch (e) {
        toast.error(friendlyError(e, t("hc_modulesWhiteboardMultiPageWhiteboard.savePageError")));
      }
    },
    [activePageId, t],
  );

  /** Persist de hoja TEXT — guarda en `text_content`. */
  const persistTextPage = useCallback(
    async (text: string) => {
      if (!activePageId) return;
      try {
        const { error } = await db
          .from("whiteboard_pages")
          .update({ text_content: text })
          .eq("id", activePageId);
        if (error) toast.error(friendlyError(error, t("hc_modulesWhiteboardMultiPageWhiteboard.savePageError")));
      } catch (e) {
        toast.error(friendlyError(e, t("hc_modulesWhiteboardMultiPageWhiteboard.savePageError")));
      }
    },
    [activePageId, t],
  );

  /** Persist de hoja CODE/CONSOLE — patch multi-campo (source/lenguaje/cache de
   *  ejecución para code; transcript para console). Actualiza el state local
   *  además de la DB para que el cache sobreviva un cambio de hoja + vuelta
   *  (cada hoja re-monta por `key`, leyendo de `pages`). */
  const persistCodePage = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!activePageId) return;
      setPages((prev) =>
        prev.map((p) => (p.id === activePageId ? ({ ...p, ...patch } as WhiteboardPage) : p)),
      );
      try {
        const { error } = await db.from("whiteboard_pages").update(patch).eq("id", activePageId);
        if (error) toast.error(friendlyError(error, t("hc_modulesWhiteboardMultiPageWhiteboard.savePageError")));
      } catch (e) {
        toast.error(friendlyError(e, t("hc_modulesWhiteboardMultiPageWhiteboard.savePageError")));
      }
    },
    [activePageId, t],
  );

  const addPage = async (kind: PageType, name: string) => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t("hc_modulesWhiteboardMultiPageWhiteboard.nameRequired"));
      return;
    }
    setBusy(true);
    try {
      const nextPos = pages.length === 0 ? 0 : Math.max(...pages.map((p) => p.position)) + 1;
      const insertPayload: Record<string, unknown> = {
        whiteboard_id: whiteboardId,
        position: nextPos,
        page_type: kind,
        name: trimmed,
      };
      // Inicializamos el campo correspondiente al tipo de hoja para
      // que el editor arranque limpio. Los otros campos quedan NULL/default.
      if (kind === "drawing") insertPayload.scene_json = EMPTY_SCENE;
      else if (kind === "text") insertPayload.text_content = "";
      else if (kind === "code") {
        insertPayload.code_language = "java";
        insertPayload.code_source = getStarterCode("java");
      }
      // 'console' no requiere init: el VM arranca fresco y console_transcript queda NULL.
      const { data, error } = await db
        .from("whiteboard_pages")
        .insert(insertPayload)
        .select(PAGE_SELECT_COLS)
        .single();
      if (error || !data) {
        toast.error(friendlyError(error, t("hc_modulesWhiteboardMultiPageWhiteboard.addPageError")));
        return;
      }
      const newPage = data as WhiteboardPage;
      setPages((prev) => [...prev, newPage]);
      setActivePageId(newPage.id);
      setNewPageKind(null);
      setNewPageName("");
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesWhiteboardMultiPageWhiteboard.addPageError")));
    } finally {
      setBusy(false);
    }
  };

  const deletePage = async (pageId: string) => {
    if (busy) return;
    if (pages.length <= 1) {
      toast.info(t("hc_modulesWhiteboardMultiPageWhiteboard.atLeastOnePage"));
      return;
    }
    const page = pages.find((p) => p.id === pageId);
    if (!page) return;
    const label = page.name ?? t("hc_modulesWhiteboardMultiPageWhiteboard.pageLabel", { n: page.position + 1 });
    const ok = await confirm({
      title: t("hc_modulesWhiteboardMultiPageWhiteboard.deleteConfirmTitle", { label }),
      description: t("hc_modulesWhiteboardMultiPageWhiteboard.deleteConfirmDescription"),
      tone: "destructive",
      confirmLabel: t("hc_modulesWhiteboardMultiPageWhiteboard.deleteConfirmLabel"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { error } = await db.from("whiteboard_pages").delete().eq("id", pageId);
      if (error) {
        toast.error(friendlyError(error, t("hc_modulesWhiteboardMultiPageWhiteboard.deletePageError")));
        return;
      }
      const remaining = pages.filter((p) => p.id !== pageId);
      setPages(remaining);
      if (activePageId === pageId) {
        setActivePageId(remaining[0]?.id ?? null);
      }
      toast.success(t("hc_modulesWhiteboardMultiPageWhiteboard.pageDeleted"));
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesWhiteboardMultiPageWhiteboard.deletePageError")));
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
        toast.error(friendlyError(error, t("hc_modulesWhiteboardMultiPageWhiteboard.renamePageError")));
        return;
      }
      setPages((prev) =>
        prev.map((p) => (p.id === renamingId ? { ...p, name: newName || null } : p)),
      );
      cancelRename();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesWhiteboardMultiPageWhiteboard.renamePageError")));
    } finally {
      setBusy(false);
    }
  };

  // ─── Tab strip scroll behavior ─────────────────────────────────
  // Tres pedazos clave para que el strip se vea bien con muchas hojas:
  //  1. `scrollRef` apunta al contenedor scrollable.
  //  2. `activeTabRef` apunta al tab activo — scrollIntoView al cambiar
  //     de hoja para que SIEMPRE quede visible.
  //  3. Flechas ← → que scrollean 200px y se ocultan si no hay overflow.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateScrollState();
    el.addEventListener("scroll", onScroll, { passive: true });
    // Re-evaluar overflow cuando cambia el tamaño del contenedor
    // (resize del viewport, agregar/quitar hojas).
    const ro = new ResizeObserver(() => updateScrollState());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [updateScrollState, pages.length]);

  // Auto-scroll del active tab a la vista cuando cambia.
  useEffect(() => {
    if (!activeTabRef.current) return;
    activeTabRef.current.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activePageId]);

  // Persistir la hoja activa para restaurarla al reentrar a la pizarra.
  // WHY effect (no inline en cada setter): cubre TODOS los cambios de
  // activePageId (tab click, dropdown, addPage, deletePage) sin tocarlos uno
  // a uno.
  //
  // CRÍTICO: solo persistimos cuando activePageId es NO-null. En el mount
  // activePageId arranca null y este effect corría ANTES de que load()
  // resolviera su await, BORRANDO la clave guardada → load() leía null y
  // siempre caía a rows[0] (bug: "no me deja en la misma hoja al volver /
  // cambiar de pestaña"). Al no escribir el null transitorio, load() puede
  // leer la última hoja vista. Una hoja borrada/stale la maneja load() con
  // su check `rows.some(r => r.id === stored)` (cae a rows[0]).
  useEffect(() => {
    if (activePageId) writeStoredActivePage(whiteboardId, activePageId);
  }, [activePageId, whiteboardId]);

  const scrollBy = (delta: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: delta, behavior: "smooth" });
  };

  // Filtrado de la lista en el dropdown "Ver todas".
  const filteredPagesForList = useMemo(() => {
    const q = pageListSearch.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter((p) => {
      const label = (
        p.name ?? t("hc_modulesWhiteboardMultiPageWhiteboard.pageLabel", { n: p.position + 1 })
      ).toLowerCase();
      return label.includes(q);
    });
  }, [pages, pageListSearch, t]);

  // ─── Render ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center gap-2 text-sm text-muted-foreground",
          className,
        )}
      >
        <Spinner size="sm" /> {t("hc_modulesWhiteboardMultiPageWhiteboard.loadingPages")}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className={cn("flex items-center justify-center p-4", className)}>
        <ErrorState
          message={t("hc_modulesWhiteboardMultiPageWhiteboard.loadPagesErrorTitle")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }
  if (!activePage) {
    return (
      <div
        className={cn(
          "flex items-center justify-center p-4 text-sm text-muted-foreground",
          className,
        )}
      >
        {t("hc_modulesWhiteboardMultiPageWhiteboard.noPagesYet")}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      {/* ─── Tab strip (rediseñado para muchas hojas) ───
          Layout: [← flecha] [scroll: tabs] [→ flecha]  |  [Ver todas]  [+ Agregar]
          Las flechas se ocultan automáticamente cuando no hay overflow
          en su dirección, sin "saltar" el layout (usamos `invisible` en
          vez de unmount). */}
      <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-1 py-1.5 shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => scrollBy(-220)}
          disabled={!canScrollLeft}
          className={cn("h-8 w-8 p-0 shrink-0", !canScrollLeft && "invisible")}
          aria-label={t("hc_modulesWhiteboardMultiPageWhiteboard.scrollLeft")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div
          ref={scrollRef}
          className="flex-1 min-w-0 overflow-x-auto scrollbar-thin"
          style={{ scrollbarWidth: "none" }}
        >
          <div className="flex items-center gap-1 w-max">
            {pages.map((page) => {
              const isActive = page.id === activePageId;
              const isRenaming = renamingId === page.id;
              const label = page.name ?? t("hc_modulesWhiteboardMultiPageWhiteboard.pageLabel", { n: page.position + 1 });
              const Icon = pageIcon(page.page_type);
              return (
                <div
                  key={page.id}
                  ref={isActive ? activeTabRef : undefined}
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors shrink-0",
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
                        placeholder={t("hc_modulesWhiteboardMultiPageWhiteboard.pageLabel", { n: page.position + 1 })}
                        className="h-6 w-32 text-xs px-1.5"
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={() => void saveRename()}
                        disabled={busy}
                        className="text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
                        aria-label={t("hc_modulesWhiteboardMultiPageWhiteboard.saveNameAria")}
                        title={t("hc_modulesWhiteboardMultiPageWhiteboard.save")}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        disabled={busy}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={t("hc_modulesWhiteboardMultiPageWhiteboard.cancel")}
                        title={t("hc_modulesWhiteboardMultiPageWhiteboard.cancel")}
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
                          "flex items-center gap-1.5 font-medium max-w-[140px] truncate",
                          isActive ? "text-foreground" : "text-muted-foreground",
                        )}
                        title={label}
                      >
                        <Icon
                          className={cn(
                            "h-3 w-3 shrink-0",
                            pageIconColor(page.page_type),
                          )}
                        />
                        <span className="truncate">{label}</span>
                      </button>
                      {!readOnly && isActive && (
                        <>
                          <button
                            type="button"
                            onClick={() => startRename(page)}
                            className="text-muted-foreground hover:text-foreground opacity-70 hover:opacity-100"
                            aria-label={t("hc_modulesWhiteboardMultiPageWhiteboard.renamePageAria")}
                            title={t("hc_modulesWhiteboardMultiPageWhiteboard.rename")}
                            disabled={busy}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deletePage(page.id)}
                            className="text-muted-foreground hover:text-destructive opacity-70 hover:opacity-100"
                            aria-label={t("hc_modulesWhiteboardMultiPageWhiteboard.deletePageAria")}
                            title={t("hc_modulesWhiteboardMultiPageWhiteboard.deletePageAria")}
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
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => scrollBy(220)}
          disabled={!canScrollRight}
          className={cn("h-8 w-8 p-0 shrink-0", !canScrollRight && "invisible")}
          aria-label={t("hc_modulesWhiteboardMultiPageWhiteboard.scrollRight")}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        {/* Separador visual antes de los controles globales. */}
        <span aria-hidden className="h-5 w-px bg-border mx-1 shrink-0" />

        {/* Dropdown "Ver todas las hojas" — útil cuando hay 10+ hojas
            para saltar directo a una sin scrollear el strip. */}
        <DropdownMenu open={pageListOpen} onOpenChange={setPageListOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs shrink-0 px-2"
              title={t("hc_modulesWhiteboardMultiPageWhiteboard.viewAllPages")}
            >
              <ListIcon className="h-3.5 w-3.5 mr-1" />
              <span className="hidden sm:inline">{t("hc_modulesWhiteboardMultiPageWhiteboard.list")}</span>
              <span className="ml-1 text-muted-foreground tabular-nums">({pages.length})</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 max-h-[400px] overflow-y-auto">
            <DropdownMenuLabel className="flex items-center gap-2">
              <ListIcon className="h-3.5 w-3.5" />
              {t("hc_modulesWhiteboardMultiPageWhiteboard.allPages", { count: pages.length })}
            </DropdownMenuLabel>
            {/* Búsqueda interna — útil cuando hay decenas de hojas. */}
            {pages.length > 8 && (
              <div className="px-2 pb-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                  <Input
                    value={pageListSearch}
                    onChange={(e) => setPageListSearch(e.target.value)}
                    placeholder={t("hc_modulesWhiteboardMultiPageWhiteboard.searchPagePlaceholder")}
                    className="h-7 pl-7 text-xs"
                  />
                </div>
              </div>
            )}
            <DropdownMenuSeparator />
            {filteredPagesForList.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                {t("hc_modulesWhiteboardMultiPageWhiteboard.noMatches")}
              </div>
            ) : (
              filteredPagesForList.map((page) => {
                const isActive = page.id === activePageId;
                const label = page.name ?? t("hc_modulesWhiteboardMultiPageWhiteboard.pageLabel", { n: page.position + 1 });
                const Icon = pageIcon(page.page_type);
                return (
                  <DropdownMenuItem
                    key={page.id}
                    onSelect={() => {
                      setActivePageId(page.id);
                      setPageListSearch("");
                      setPageListOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 text-xs",
                      isActive && "bg-muted font-medium",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-3 w-3 shrink-0",
                        pageIconColor(page.page_type),
                      )}
                    />
                    <span className="truncate flex-1">{label}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      #{page.position + 1}
                    </span>
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                className="h-7 text-xs shrink-0 px-2"
                title={t("hc_modulesWhiteboardMultiPageWhiteboard.addPageTitle")}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                <span className="hidden sm:inline">{t("hc_modulesWhiteboardMultiPageWhiteboard.add")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t("hc_modulesWhiteboardMultiPageWhiteboard.newPageType")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setNewPageName("");
                  setNewPageKind("drawing");
                }}
              >
                <Palette className="h-4 w-4 mr-2 text-violet-500" />
                <div className="flex flex-col">
                  <span className="text-sm">{t("hc_modulesWhiteboardMultiPageWhiteboard.drawingPage")}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {t("hc_modulesWhiteboardMultiPageWhiteboard.drawingPageHint")}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setNewPageName("");
                  setNewPageKind("text");
                }}
              >
                <FileText className="h-4 w-4 mr-2 text-sky-500" />
                <div className="flex flex-col">
                  <span className="text-sm">{t("hc_modulesWhiteboardMultiPageWhiteboard.textPage")}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {t("hc_modulesWhiteboardMultiPageWhiteboard.textPageHint")}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setNewPageName("");
                  setNewPageKind("code");
                }}
              >
                <Code2 className="h-4 w-4 mr-2 text-indigo-500" />
                <div className="flex flex-col">
                  <span className="text-sm">
                    {t("hc_modulesWhiteboardMultiPageWhiteboard.codePage", { defaultValue: "Hoja de código" })}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {t("hc_modulesWhiteboardMultiPageWhiteboard.codePageHint", {
                      defaultValue: "Editor + compilador para mostrar código en vivo",
                    })}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setNewPageName("");
                  setNewPageKind("console");
                }}
              >
                <Terminal className="h-4 w-4 mr-2 text-emerald-500" />
                <div className="flex flex-col">
                  <span className="text-sm">
                    {t("hc_modulesWhiteboardMultiPageWhiteboard.consolePage", { defaultValue: "Hoja de consola (Linux)" })}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {t("hc_modulesWhiteboardMultiPageWhiteboard.consolePageHint", {
                      defaultValue: "Terminal Linux real para demostrar comandos",
                    })}
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Editor de la página activa. `key={activePageId}` fuerza re-mount
          al cambiar de hoja: tanto Excalidraw como TextPageEditor leen
          su contenido inicial via prop en mount, por eso el key change
          es la forma estándar de reset al cambiar de hoja. */}
      <div className="flex-1 min-h-0">
        {activePage.page_type === "text" ? (
          <TextPageEditor
            key={activePage.id}
            text={activePage.text_content ?? ""}
            onPersist={persistTextPage}
            readOnly={readOnly}
            className="w-full h-full"
          />
        ) : activePage.page_type === "code" ? (
          <CodePageEditor
            key={activePage.id}
            pageId={activePage.id}
            language={activePage.code_language}
            source={activePage.code_source}
            stdout={activePage.last_stdout}
            stderr={activePage.last_stderr}
            exitCode={activePage.last_exit_code}
            executedAt={activePage.last_executed_at}
            onPersist={persistCodePage}
            readOnly={readOnly}
            className="w-full h-full"
          />
        ) : activePage.page_type === "console" ? (
          <V86Console
            key={activePage.id}
            value={activePage.console_transcript}
            onChange={(v) => void persistCodePage({ console_transcript: v })}
            readOnly={readOnly}
            className="w-full h-full"
          />
        ) : (
          <WhiteboardEditor
            key={activePage.id}
            scene={activePage.scene_json}
            onPersist={persistDrawingPage}
            readOnly={readOnly}
            className="w-full h-full"
            // Persistencia del viewport por hoja: cada page tiene SU
            // propia clave de localStorage, así pan/zoom se respeta al
            // volver a la pizarra o cambiar de pestaña del navegador.
            // El whiteboardId queda implícito en el page_id (UUID único
            // global), no necesitamos prefijar.
            viewportStorageKey={`examlab_wb_view:page:${activePage.id}`}
          />
        )}
      </div>

      {/* Dialog de creación de hoja — el NOMBRE es obligatorio. */}
      <Dialog
        open={newPageKind !== null}
        onOpenChange={(o) => {
          if (!o) {
            setNewPageKind(null);
            setNewPageName("");
          }
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {(() => {
                const NewIcon = pageIcon(newPageKind ?? "drawing");
                return <NewIcon className={cn("h-5 w-5", pageIconColor(newPageKind ?? "drawing"))} />;
              })()}
              {newPageKind === "text"
                ? t("hc_modulesWhiteboardMultiPageWhiteboard.newTextPageTitle")
                : newPageKind === "code"
                  ? t("hc_modulesWhiteboardMultiPageWhiteboard.newCodePageTitle", {
                      defaultValue: "Nueva hoja de código",
                    })
                  : newPageKind === "console"
                    ? t("hc_modulesWhiteboardMultiPageWhiteboard.newConsolePageTitle", {
                        defaultValue: "Nueva hoja de consola",
                      })
                    : t("hc_modulesWhiteboardMultiPageWhiteboard.newDrawingPageTitle")}
            </DialogTitle>
            <DialogDescription>{t("hc_modulesWhiteboardMultiPageWhiteboard.namePageDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-page-name" required>
              {t("hc_modulesWhiteboardMultiPageWhiteboard.pageNameLabel")}
            </Label>
            <Input
              id="new-page-name"
              value={newPageName}
              onChange={(e) => setNewPageName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newPageName.trim() && !busy) {
                  void addPage(newPageKind!, newPageName);
                }
              }}
              autoFocus
              maxLength={120}
              placeholder={
                newPageKind === "text"
                  ? t("hc_modulesWhiteboardMultiPageWhiteboard.textPagePlaceholder")
                  : newPageKind === "code"
                    ? t("hc_modulesWhiteboardMultiPageWhiteboard.codePagePlaceholder", {
                        defaultValue: "Ej. Ejemplo de bucle for",
                      })
                    : newPageKind === "console"
                      ? t("hc_modulesWhiteboardMultiPageWhiteboard.consolePagePlaceholder", {
                          defaultValue: "Ej. Comandos de permisos",
                        })
                      : t("hc_modulesWhiteboardMultiPageWhiteboard.drawingPagePlaceholder")
              }
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setNewPageKind(null);
                setNewPageName("");
              }}
              disabled={busy}
            >
              {t("hc_modulesWhiteboardMultiPageWhiteboard.cancel")}
            </Button>
            <Button
              onClick={() => newPageKind && void addPage(newPageKind, newPageName)}
              disabled={busy || !newPageName.trim()}
            >
              {busy ? <Spinner size="sm" className="mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
              {t("hc_modulesWhiteboardMultiPageWhiteboard.createPage")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
