/**
 * DatePicker / DateTimePicker — reemplazos del `<input type="date">` y
 * `<input type="datetime-local">` nativos.
 *
 * Motivación: en Chrome, los inputs nativos a veces no abren el calendario
 * cuando el click cae fuera del icono pequeño del lado derecho (sobre todo
 * con `display: block`, `width: 100%` o estilos propios). Este componente
 * usa `Popover` + `Calendar` de shadcn, que abren confiablemente en cualquier
 * navegador y son consistentes con el resto de la UI.
 *
 * Convención de tipos:
 *   - `value` es una string en el mismo formato que el input nativo:
 *       - DatePicker:     "YYYY-MM-DD"
 *       - DateTimePicker: "YYYY-MM-DDTHH:mm"
 *   - `onChange(next)` recibe la string formateada (o "" cuando se limpia).
 *
 * Esto hace que el componente sea drop-in: sustituye el `<Input type="date">`
 * sin cambiar la lógica de los formularios que ya emiten/leen esa string.
 */
import { useMemo } from "react";
import { CalendarIcon } from "lucide-react";
import { format, parse, isValid } from "date-fns";
import { es } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function parseDateOnly(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const d = parse(value, "yyyy-MM-dd", new Date());
  return isValid(d) ? d : undefined;
}

function parseDateTime(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const d = parse(value, "yyyy-MM-dd'T'HH:mm", new Date());
  return isValid(d) ? d : undefined;
}

interface DatePickerProps {
  value?: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Selecciona una fecha",
  required,
  disabled,
  className,
  id,
}: DatePickerProps) {
  const date = useMemo(() => parseDateOnly(value), [value]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-required={required}
          className={cn(
            "w-full justify-start text-left font-normal",
            !date && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? format(date, "PPP", { locale: es }) : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => onChange(d ? format(d, "yyyy-MM-dd") : "")}
          locale={es}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

interface DateTimePickerProps extends Omit<DatePickerProps, "placeholder"> {
  placeholder?: string;
  /** Step in minutes for the time input (default 1). */
  timeStep?: number;
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = "Selecciona fecha y hora",
  required,
  disabled,
  className,
  id,
  timeStep = 1,
}: DateTimePickerProps) {
  const date = useMemo(() => parseDateTime(value), [value]);
  const timeStr = date ? format(date, "HH:mm") : "";

  const updateDate = (d: Date | undefined) => {
    if (!d) {
      onChange("");
      return;
    }
    // Preserve previous time if any, default to 00:00 when picking a fresh day.
    const prev = date;
    const hh = prev ? prev.getHours() : 0;
    const mm = prev ? prev.getMinutes() : 0;
    const next = new Date(d);
    next.setHours(hh, mm, 0, 0);
    onChange(format(next, "yyyy-MM-dd'T'HH:mm"));
  };

  const updateTime = (timeValue: string) => {
    if (!timeValue) {
      // Don't lose the date; just blank the time portion.
      if (date) onChange(format(date, "yyyy-MM-dd'T'00:00"));
      return;
    }
    const [hh, mm] = timeValue.split(":").map((n) => Number(n));
    if (Number.isNaN(hh) || Number.isNaN(mm)) return;
    const base = date ?? new Date();
    base.setHours(hh, mm, 0, 0);
    onChange(format(base, "yyyy-MM-dd'T'HH:mm"));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-required={required}
          className={cn(
            "w-full justify-start text-left font-normal",
            !date && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? format(date, "PPP HH:mm", { locale: es }) : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={updateDate}
          locale={es}
          initialFocus
        />
        <div className="border-t p-3 flex items-center gap-2">
          <CalendarIcon className="h-4 w-4 text-muted-foreground" />
          <Input
            type="time"
            step={timeStep * 60}
            value={timeStr}
            onChange={(e) => updateTime(e.target.value)}
            className="flex-1"
            aria-label="Hora"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
