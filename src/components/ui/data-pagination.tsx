/**
 * DataPagination — barra de paginación standard para grids.
 *
 * Combina:
 *  - Label "Mostrando X-Y de Z"
 *  - Selector "items por página"
 *  - Navegador prev/next + páginas (con ellipsis cuando hay muchas)
 *
 * Diseñada para acoplarse al hook `usePagination`:
 *
 *   const pag = usePagination(filteredItems, {
 *     storageKey: "examlab_pag:admin_users",
 *     resetKey: searchTerm + courseFilter,
 *   });
 *   ...
 *   {pag.paginatedItems.map(...)}
 *   <DataPagination state={pag} entityNamePlural="usuarios" />
 *
 * No es presentacional puro — sabe que está acoplada al hook. Razón:
 * cada grid repitiendo wiring de labels + selectores + ellipsis logic
 * sería ruido. Si un caso necesita custom (ej. añadir botones extra
 * adentro), copiar este archivo como base y usar `usePagination`
 * directo — todo lo presentacional (botones, ellipsis) vive acá.
 *
 * Visible cuando `totalItems > 0`. Si solo hay 1 página, todavía
 * mostramos el selector de items por página (útil para "1 página de
 * 47 items" → cambiar a 10/página para ver 5 páginas).
 */
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PaginationState } from "@/hooks/use-pagination";

interface DataPaginationProps<T> {
  state: PaginationState<T>;
  /** "usuarios" / "cursos" / etc. Plural. Usado en el label. */
  entityNamePlural?: string;
  /** Custom render del label de conteo (sobreescribe el default). */
  renderLabel?: (state: PaginationState<T>) => ReactNode;
  /** Si false, oculta el selector "items por página". Util cuando el
   *  page size lo controla otro UI (ej. tabs). */
  showPageSize?: boolean;
  /** Padding por defecto px-3 py-2. Pasar "" para layouts custom. */
  className?: string;
}

/** Genera la secuencia de páginas a mostrar con ellipsis. Para 10
 *  páginas con current=5 → [1, '…', 4, 5, 6, '…', 10]. Mantiene el
 *  context cercano sin saturar con 50 botones. */
function getPageSequence(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: Array<number | "ellipsis"> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push("ellipsis");
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 1) pages.push("ellipsis");
  pages.push(total);
  return pages;
}

export function DataPagination<T>({
  state,
  entityNamePlural = "items",
  renderLabel,
  showPageSize = true,
  className = "px-3 py-2",
}: DataPaginationProps<T>) {
  const { t } = useTranslation();
  const {
    currentPage,
    setCurrentPage,
    totalPages,
    pageSize,
    setPageSize,
    totalItems,
    pageSizes,
    startIndex,
    endIndex,
  } = state;

  // Si no hay items, no renderizamos nada — el grid muestra su empty
  // state y la pagination sería ruido.
  if (totalItems === 0) return null;

  const sequence = getPageSequence(currentPage, totalPages);

  const label = renderLabel ? (
    renderLabel(state)
  ) : (
    <span className="text-xs text-muted-foreground tabular-nums">
      {pageSize > 0 ? (
        <>
          {t("hc_componentsUiDataPagination.showing")}{" "}
          <strong className="text-foreground">{startIndex.toLocaleString("es-CO")}</strong>–
          <strong className="text-foreground">{endIndex.toLocaleString("es-CO")}</strong>{" "}
          {t("hc_componentsUiDataPagination.of")}{" "}
          <strong className="text-foreground">{totalItems.toLocaleString("es-CO")}</strong>{" "}
          {entityNamePlural}
        </>
      ) : (
        <>
          {t("hc_componentsUiDataPagination.showing")}{" "}
          <strong className="text-foreground">{totalItems.toLocaleString("es-CO")}</strong>{" "}
          {entityNamePlural}
        </>
      )}
    </span>
  );

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-t ${className}`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        {label}
        {showPageSize && pageSizes.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground hidden sm:inline">{t("hc_componentsUiDataPagination.perPage")}</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="h-7 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)} className="text-xs">
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <nav role="navigation" aria-label={t("hc_componentsUiDataPagination.navAriaLabel")} className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage(currentPage - 1)}
            aria-label={t("hc_componentsUiDataPagination.previousPage")}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          {sequence.map((entry, idx) =>
            entry === "ellipsis" ? (
              <span
                key={`ellipsis-${idx}`}
                className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground"
                aria-hidden="true"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </span>
            ) : (
              <Button
                key={entry}
                variant={entry === currentPage ? "outline" : "ghost"}
                size="icon"
                className="h-8 w-8 text-xs tabular-nums"
                onClick={() => setCurrentPage(entry)}
                aria-current={entry === currentPage ? "page" : undefined}
                aria-label={t("hc_componentsUiDataPagination.goToPage", { page: entry })}
              >
                {entry}
              </Button>
            ),
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={currentPage >= totalPages}
            onClick={() => setCurrentPage(currentPage + 1)}
            aria-label={t("hc_componentsUiDataPagination.nextPage")}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </nav>
      )}
    </div>
  );
}
