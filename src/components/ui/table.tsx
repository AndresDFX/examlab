import * as React from "react";

import { cn } from "@/shared/lib/utils";

// El wrapper se queda con el scroll horizontal para que las tablas
// anchas no rompan el layout en mobile. `-webkit-overflow-scrolling`
// mantiene el scroll inercial en iOS; `scroll-hint-x` desvanece los
// bordes para indicar que hay más contenido fuera de pantalla.
//
// Prop `fixed`: activa `table-fixed` (CSS table-layout: fixed). Por
// defecto la tabla es `auto`: las columnas se ajustan al contenido
// más largo y, si una celda tiene texto kilométrico, expande toda la
// tabla y desborda. Con `fixed`, las columnas respetan el ancho que
// el caller defina en `<TableHead style={{ width: 200 }}>` o en el
// className (`w-48`, etc.), y las celdas que tengan `truncate`
// realmente truncan con ellipsis.
//
// Prop `resizable`: agrega handles tipo Excel en el borde derecho de
// cada columna para que el usuario arrastre y redimensione. Implica
// `table-fixed` (el resize no tiene sentido en layout auto). Los
// anchos se persisten en localStorage por grid (ver useColumnResize).
//
// Convención del design system: para todos los grids "de listado"
// (cursos, exámenes, talleres, etc.) usar `<Table fixed resizable>` +
// dar anchos a las columnas + envolver cells de texto largo con
// `<TruncatedCell>` o `<TableCell truncate>`. Así todos los grids se
// ven uniformes independiente del contenido.

// ─────────────────────── Column resize (estilo Excel) ───────────────────────
//
// El usuario arrastra el borde derecho de cualquier encabezado para
// redimensionar la columna; doble clic restablece esa columna a su
// ancho natural. Los anchos persisten en localStorage por grid.
//
// Diseño:
//  - `table-layout: fixed` es obligatorio: con `auto` los anchos los
//    decide el contenido y el arrastre no se respeta. `resizable`
//    fuerza `table-fixed`.
//  - El ancho de la <table> se fija a la SUMA de las columnas visibles
//    (`syncTableWidth`). Así, al ensanchar una columna la tabla crece
//    y aparece scroll horizontal — al angostarla, encoge. Si quedara
//    en `width:100%`, `table-fixed` re-escalaría las columnas y el
//    arrastre "no se sentiría".
//  - La clave de persistencia se deriva de la ruta + un fingerprint de
//    los textos de encabezado. Cero configuración por grid, y si las
//    columnas cambian el fingerprint cambia → se descartan los anchos
//    viejos en vez de aplicarlos a columnas que ya no existen.
//  - Solo desktop (`min-width: 640px`): el arrastre fino no aplica a
//    touch. En mobile se limpian los anchos pinneados y la tabla
//    vuelve a su layout responsive normal.

/** Ancho mínimo al que se puede arrastrar una columna (px). */
const MIN_COL_WIDTH = 48;

/** Context: indica a `TableHead` que debe renderizar el handle de resize. */
const TableResizeContext = React.createContext(false);

/** Hash corto y estable (djb2) para derivar storage keys de un string. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Celdas (<th>) de la primera fila del thead. */
function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
  const row = table.tHead?.rows[0];
  return row ? Array.from(row.cells) : [];
}

/** Una columna cuenta si NO está oculta (`hidden md:table-cell`, etc.). */
function isVisibleCol(th: HTMLElement): boolean {
  return th.offsetParent !== null && th.getBoundingClientRect().width > 0;
}

/** Clave de localStorage: ruta + fingerprint de los encabezados. */
function storageKeyFor(table: HTMLTableElement): string {
  const fingerprint = headerCells(table)
    .map((c) => c.textContent?.trim() ?? "")
    .join("|");
  return `examlab_colw:${window.location.pathname}:${djb2(fingerprint)}`;
}

/** Fija el ancho de la <table> a la suma de columnas visibles para que
 *  `table-fixed` respete los anchos sin re-escalar. */
function syncTableWidth(table: HTMLTableElement): void {
  let total = 0;
  for (const th of headerCells(table)) {
    if (isVisibleCol(th)) total += th.getBoundingClientRect().width;
  }
  if (total > 0) table.style.width = `${Math.round(total)}px`;
}

/** Persiste los anchos actuales (índice de columna → px) en localStorage. */
function persistWidths(table: HTMLTableElement): void {
  try {
    const map: Record<number, number> = {};
    headerCells(table).forEach((th, i) => {
      if (isVisibleCol(th)) map[i] = Math.round(th.getBoundingClientRect().width);
    });
    localStorage.setItem(storageKeyFor(table), JSON.stringify(map));
  } catch {
    /* localStorage lleno/bloqueado — no es crítico, se pierde la persistencia */
  }
}

/**
 * Hook (lo llama `Table`): al montar, en desktop, pinea los anchos
 * actuales de cada columna y aplica los overrides guardados. En mobile
 * limpia los anchos para volver al layout responsive. Reacciona al
 * cambio de breakpoint.
 */
function useColumnResize(
  tableRef: React.RefObject<HTMLTableElement | null>,
  enabled: boolean,
): void {
  React.useLayoutEffect(() => {
    if (!enabled) return;
    const table = tableRef.current;
    if (!table) return;
    const desktop = window.matchMedia("(min-width: 640px)");

    const apply = () => {
      const cells = headerCells(table);
      if (!desktop.matches) {
        // Mobile: sin resize. Limpiamos anchos pinneados → layout normal.
        for (const th of cells) th.style.width = "";
        table.style.width = "";
        return;
      }
      if (cells.length < 2) return;
      // 1. Pin del ancho actual de cada columna visible (el que dé el
      //    layout `table-fixed`). Sin esto, ensanchar una columna haría
      //    que `table-fixed` robe espacio a las demás.
      for (const th of cells) {
        if (isVisibleCol(th)) {
          th.style.width = `${Math.round(th.getBoundingClientRect().width)}px`;
        }
      }
      // 2. Overrides guardados (anchos que el usuario arrastró antes).
      try {
        const raw = localStorage.getItem(storageKeyFor(table));
        if (raw) {
          const saved = JSON.parse(raw) as Record<string, number>;
          cells.forEach((th, i) => {
            const w = saved[i];
            if (typeof w === "number" && w > 0 && isVisibleCol(th)) {
              th.style.width = `${w}px`;
            }
          });
        }
      } catch {
        /* JSON corrupto — ignorar y usar los anchos pinneados */
      }
      syncTableWidth(table);
    };

    apply();
    desktop.addEventListener("change", apply);
    return () => desktop.removeEventListener("change", apply);
  }, [enabled, tableRef]);
}

/** Handle de arrastre en el borde derecho de un `<th>`. Lo renderiza
 *  `TableHead` cuando la tabla es `resizable`. */
function ColumnResizeHandle() {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const th = handle.parentElement as HTMLTableCellElement | null;
    const table = th?.closest("table") as HTMLTableElement | null;
    if (!th || !table) return;
    // Solo columnas de la primera fila del encabezado (evita headers
    // multi-fila si los hubiera).
    if (th.parentElement !== table.tHead?.rows[0]) return;

    const startX = e.clientX;
    const startWidth = th.getBoundingClientRect().width;
    handle.classList.add("is-dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const next = Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX));
      th.style.width = `${Math.round(next)}px`;
      syncTableWidth(table);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      handle.classList.remove("is-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistWidths(table);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // preventDefault evita selección de texto; stopPropagation evita
    // disparar handlers de click del propio <th> (orden, etc.).
    e.preventDefault();
    e.stopPropagation();
  };

  // Doble clic: restablece esta columna a su ancho natural.
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const th = e.currentTarget.parentElement as HTMLTableCellElement | null;
    const table = th?.closest("table") as HTMLTableElement | null;
    if (!th || !table) return;
    th.style.width = "";
    // Re-pin al nuevo ancho natural para que `table-fixed` no re-escale.
    requestAnimationFrame(() => {
      if (isVisibleCol(th)) {
        th.style.width = `${Math.round(th.getBoundingClientRect().width)}px`;
      }
      syncTableWidth(table);
      persistWidths(table);
    });
    e.stopPropagation();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionar columna"
      title="Arrastra para redimensionar · doble clic para restablecer"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        // Zona de agarre ancha centrada sobre el borde de la columna;
        // solo desktop (touch usa el layout responsive normal).
        "absolute right-0 top-0 z-20 hidden h-full w-2 translate-x-1/2",
        "cursor-col-resize touch-none select-none sm:block",
        // Línea visual vía pseudo-elemento: transparente en reposo,
        // se tiñe al hover y mientras se arrastra.
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2",
        "after:bg-transparent after:transition-colors",
        "hover:after:bg-primary/60",
        "[&.is-dragging]:after:w-0.5 [&.is-dragging]:after:bg-primary",
      )}
    />
  );
}

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** Aplica `table-layout: fixed`. Las columnas respetan el width que
   *  les des; los textos demasiado largos truncan en cada cell con
   *  ellipsis (siempre que la cell use `truncate`). */
  fixed?: boolean;
  /** Habilita el redimensionado de columnas por arrastre (estilo Excel).
   *  Implica `fixed`. Los anchos se persisten por grid en localStorage. */
  resizable?: boolean;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, fixed, resizable, ...props }, ref) => {
    const innerRef = React.useRef<HTMLTableElement>(null);
    useColumnResize(innerRef, !!resizable);

    const setRefs = React.useCallback(
      (node: HTMLTableElement | null) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLTableElement | null>).current = node;
      },
      [ref],
    );

    return (
      <div
        className="relative w-full overflow-x-auto scroll-hint-x"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <TableResizeContext.Provider value={!!resizable}>
          <table
            ref={setRefs}
            className={cn(
              "w-full caption-bottom text-sm",
              (fixed || resizable) && "table-fixed",
              className,
            )}
            {...props}
          />
        </TableResizeContext.Provider>
      </div>
    );
  },
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  // `bg-background` + `relative z-[1]` tapa el gradient `scroll-hint-x`
  // que el wrapper pinta para insinuar overflow horizontal. Sin este
  // background, el gradient (var(--color-background) → transparente en
  // 2rem) se traslucía sobre el primer `<th>` y daba la impresión de
  // texto "borroso/doble" — visible especialmente al achicar el
  // viewport con devtools abierto.
  <thead
    ref={ref}
    className={cn("[&_tr]:border-b bg-background relative z-[1]", className)}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

// Mobile cells gain a little more horizontal padding (14px) and larger
// min-heights so row actions are easier to tap; desktop keeps tight layout.
//
// Prop `truncate`: envuelve children en un `<div className="truncate">`
// con title (tooltip nativo) en el texto. Útil cuando el cell renderiza
// directamente un texto que puede desbordar. Solo funciona en tablas
// con `<Table fixed>` + anchos definidos en las columnas.
interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /** Envuelve el contenido en un div con `truncate` automáticamente. */
  truncate?: boolean;
}

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, truncate, children, ...props }, ref) => {
    const resizable = React.useContext(TableResizeContext);
    return (
      <th
        ref={ref}
        className={cn(
          "h-11 md:h-10 px-3 md:px-2 text-left align-middle font-medium text-muted-foreground whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
          // `relative` necesario para posicionar el handle de resize.
          resizable && "relative",
          className,
        )}
        {...props}
      >
        {/* En tablas resizable (table-fixed), el texto del header se trunca
            automáticamente: sin esto, un <th> más estrecho que su texto
            desborda visualmente sobre la columna vecina (los headers se
            ven superpuestos como "Tí­tu­lo" + "Curso"). El handle de
            resize queda como sibling fuera del wrapper para no clipearse. */}
        {truncate || resizable ? <div className="truncate">{children}</div> : children}
        {resizable ? <ColumnResizeHandle /> : null}
      </th>
    );
  },
);
TableHead.displayName = "TableHead";

interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** Envuelve el contenido en un div con `truncate` automáticamente.
   *  El tooltip nativo (atributo `title`) se hereda del cell si lo das
   *  via prop. Solo trunca de verdad en tablas con `<Table fixed>` y
   *  anchos definidos en cada columna. */
  truncate?: boolean;
}

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, truncate, children, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        "p-3 md:p-2 align-middle",
        // Cells que contienen un checkbox necesitan ajustes especiales:
        //   1. pr-0: el checkbox usa todo el ancho de la columna sin
        //      padding derecho que separa del título.
        //   2. align-top en mobile: cuando la fila tiene contenido
        //      multi-línea (típico: título + curso + fecha apilados),
        //      align-middle deja el checkbox flotando en el centro
        //      vertical de un cell muy alto, lo que se percibe como
        //      un "cuadro gigante". Top-alineado lo deja al lado del
        //      título — coherente visualmente. En md+ vuelve a middle.
        //   3. py-2 en mobile: menos padding vertical en la columna
        //      del checkbox específicamente para no estirarla por debajo.
        "[&:has([role=checkbox])]:pr-0",
        "[&:has([role=checkbox])]:align-top md:[&:has([role=checkbox])]:align-middle",
        "[&:has([role=checkbox])]:py-3 md:[&:has([role=checkbox])]:py-2",
        "[&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    >
      {truncate ? <div className="truncate">{children}</div> : children}
    </td>
  ),
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

/**
 * Helper para el caso común: un cell con texto que puede desbordar y
 * quieres limitarlo a un ancho máximo + truncate + tooltip con el
 * texto completo.
 *
 * Uso:
 *   <TruncatedCell maxWidth="max-w-[200px]" title={course.name}>
 *     {course.name}
 *   </TruncatedCell>
 *
 * Si `title` no se pasa, se intenta inferir del children string. Para
 * children complejos (JSX), pasar `title` explícitamente.
 *
 * Internamente es un `<TableCell truncate>` con maxWidth aplicado al
 * div interno (no al `<td>` directamente, porque table-fixed respeta
 * el width de la primera fila — si lo aplicas al td puede pelearse con
 * el ancho del column header).
 */
interface TruncatedCellProps extends Omit<TableCellProps, "truncate"> {
  /** Tailwind class para max-width del contenido: `max-w-[200px]`,
   *  `max-w-xs`, etc. Si no se especifica, NO limita — solo trunca al
   *  ancho de la columna. */
  maxWidth?: string;
}

const TruncatedCell = React.forwardRef<HTMLTableCellElement, TruncatedCellProps>(
  ({ className, maxWidth, children, title, ...props }, ref) => {
    const inferredTitle =
      title ?? (typeof children === "string" ? children : undefined);
    return (
      <td
        ref={ref}
        className={cn(
          "p-3 md:p-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
          className,
        )}
        title={inferredTitle}
        {...props}
      >
        <div className={cn("truncate", maxWidth)}>{children}</div>
      </td>
    );
  },
);
TruncatedCell.displayName = "TruncatedCell";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TruncatedCell,
};
