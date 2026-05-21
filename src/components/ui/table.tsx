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
// Convención del design system: para todos los grids "de listado"
// (cursos, exámenes, talleres, etc.) usar `<Table fixed>` + dar
// anchos a las columnas + envolver cells de texto largo con
// `<TruncatedCell>` o `<TableCell truncate>`. Así todos los grids se
// ven uniformes independiente del contenido.
interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** Aplica `table-layout: fixed`. Las columnas respetan el width que
   *  les des; los textos demasiado largos truncan en cada cell con
   *  ellipsis (siempre que la cell use `truncate`). */
  fixed?: boolean;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, fixed, ...props }, ref) => (
    <div
      className="relative w-full overflow-x-auto scroll-hint-x"
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      <table
        ref={ref}
        className={cn("w-full caption-bottom text-sm", fixed && "table-fixed", className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
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
  ({ className, truncate, children, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-11 md:h-10 px-3 md:px-2 text-left align-middle font-medium text-muted-foreground whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    >
      {truncate ? <div className="truncate">{children}</div> : children}
    </th>
  ),
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
