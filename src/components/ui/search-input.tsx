/**
 * SearchInput — buscador estándar para grids/listas que NO usan
 * `ListFilters` (porque no tienen el concepto de "curso" como filtro
 * principal). Ej: usuarios, cursos del admin, contenidos, sesiones
 * de asistencia, grids del estudiante.
 *
 * Es presentacional — emite el cambio al padre y el padre filtra.
 * Diseño alineado con `ListFilters`: lupa a la izquierda, botón X
 * para limpiar visible solo cuando hay query.
 *
 * Uso:
 *   const [search, setSearch] = useState("");
 *   const filtered = useMemo(
 *     () => rows.filter((r) =>
 *       r.name.toLowerCase().includes(search.toLowerCase())
 *     ),
 *     [rows, search],
 *   );
 *
 *   <SearchInput value={search} onChange={setSearch} placeholder="Buscar…" />
 */
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "./input";
import { Button } from "./button";

interface SearchInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Ancho máximo del input. Default 'sm:max-w-xs'. */
  maxWidthClass?: string;
  /** className extra para el wrapper. */
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  maxWidthClass = "sm:max-w-xs",
  className,
}: SearchInputProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder =
    placeholder ?? t("common.searchPlaceholder", { defaultValue: "Buscar…" });
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      <div className={`relative flex-1 min-w-[180px] ${maxWidthClass}`}>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={resolvedPlaceholder}
          className="pl-8 pr-8"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange("")}
            className="absolute right-0.5 top-1/2 -translate-y-1/2 h-7 w-7"
            title={t("common.clear", { defaultValue: "Limpiar" })}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
