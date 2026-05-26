/**
 * HexColorInput — input combinado para editar un color en hex.
 *
 * Combina tres affordances en un solo control:
 *   1. `<input type="color">` nativo — picker visual con rueda/paleta;
 *      el sistema operativo decide la UI. iOS/Android lo abren como
 *      sheet; desktop como popover. Devuelve siempre `#rrggbb`.
 *   2. `<Input>` de texto — para pegar/escribir hex manualmente, útil
 *      cuando el usuario tiene el color exacto de marca como string.
 *   3. Swatch grande — preview del color actual; sirve también para
 *      validar visualmente que el hex tipeado es razonable.
 *
 * Estado: el componente NO valida el hex, solo emite lo que el usuario
 * pone. El caller persiste cuando submitea (y ahí filtra por regex
 * `^#[0-9a-fA-F]{6}$`). Si el text input tiene un hex inválido, el
 * picker nativo se inicializa en `#000000` (default sano).
 *
 * Por qué un componente compartido: el patrón se usa al menos en
 * /app/admin/my-tenant y /app/superadmin/tenants. Cualquier ajuste
 * (ej. agregar suggested swatches) vive en un solo lugar.
 */
import { Input } from "@/components/ui/input";

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /** Para `aria-label` cuando no hay <Label htmlFor>. */
  ariaLabel?: string;
}

/** `#RRGGBB` válido para el `<input type="color">` (que requiere ese
 *  formato exacto, sin alpha). Si el value es inválido, devolvemos
 *  negro — el picker tiene que tener algún color de inicio. */
function normalizeForColorInput(v: string): string {
  const t = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t;
  return "#000000";
}

export function HexColorInput({
  value,
  onChange,
  placeholder = "#3B82F6",
  disabled,
  id,
  ariaLabel,
}: Props) {
  const isValid = /^#[0-9a-fA-F]{6}$/.test(value.trim());
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        className="flex-1 font-mono text-xs"
      />
      {/* Picker nativo. Lo envolvemos en un label para que clickear el
          swatch dispare el picker (más natural que un input cuadradito
          con cursor de texto). El input visible-but-styled funciona
          mejor que `display:none` en iOS, donde a veces no abre el
          sheet si está oculto. */}
      <label
        className="relative h-9 w-9 rounded border shrink-0 cursor-pointer overflow-hidden"
        style={{
          backgroundColor: isValid ? value.trim() : undefined,
          backgroundImage: isValid
            ? undefined
            : // Damero gris cuando no hay color válido — feedback de
              // "no hay color elegido aún".
              "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)",
          backgroundSize: isValid ? undefined : "8px 8px",
          backgroundPosition: isValid
            ? undefined
            : "0 0, 0 4px, 4px -4px, -4px 0",
        }}
        title={isValid ? value.trim() : "Sin color válido"}
      >
        <input
          type="color"
          value={normalizeForColorInput(value)}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          disabled={disabled}
          aria-label={ariaLabel ? `${ariaLabel} (selector visual)` : "Selector de color"}
          // Color input nativo: lo hacemos 100% del wrapper pero
          // invisible. El click pasa al input y abre el picker del SO.
          // No usamos `display:none` porque iOS Safari no abre el sheet
          // si el input está completamente oculto.
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
      </label>
    </div>
  );
}
