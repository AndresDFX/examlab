/**
 * DatePicker / DateTimePicker — reemplaza <Input type="date"> y
 * <Input type="datetime-local"> nativos por un Popover con Calendar
 * (react-day-picker). Motivos:
 *  - El picker nativo no abre cuando el usuario hace click en el input
 *    completo (solo en la flechita pequeña en algunos browsers/SO).
 *  - El glifo nativo no respeta el modo oscuro: en dark se ve casi negro
 *    sobre fondo oscuro y queda invisible. Aquí usamos un ícono Lucide
 *    que ya hereda `text-foreground` del tema.
 *
 * Formato de string que aceptamos/devolvemos:
 *  - DatePicker:        "yyyy-MM-dd"
 *  - DateTimePicker:    "yyyy-MM-ddTHH:mm" (compatible con el formato
 *    que devolvía <input type="datetime-local">, así el resto del código
 *    no necesita cambiar parsers)
 */
import { format, parse, isValid } from "date-fns";
import { es, enUS, type Locale } from "date-fns/locale";
import { useTranslation } from "react-i18next";
import { Calendar as CalendarIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Localiza date-fns y react-day-picker al idioma activo de i18n. Sin
 * esto el botón mostraba "May 3rd, 2026" aunque la app estuviera en
 * español. Default español si i18n no responde.
 */
function useDateLocale(): Locale {
  const { i18n } = useTranslation();
  return i18n.language?.toLowerCase().startsWith("en") ? enUS : es;
}

function parseDateOnly(s?: string | null): Date | undefined {
  if (!s) return undefined;
  const d = parse(s, "yyyy-MM-dd", new Date());
  return isValid(d) ? d : undefined;
}

function formatDateOnly(d: Date | undefined): string {
  return d ? format(d, "yyyy-MM-dd") : "";
}

interface DatePickerProps {
  value?: string | null;
  onChange?: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Selecciona fecha",
  disabled,
  className,
  id,
}: DatePickerProps) {
  const date = parseDateOnly(value);
  const locale = useDateLocale();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          type="button"
          className={cn(
            "w-full justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="h-4 w-4 mr-2 opacity-70 shrink-0" />
          <span className="truncate">
            {date ? format(date, "PP", { locale }) : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => onChange?.(formatDateOnly(d))}
          autoFocus
          locale={locale}
        />
      </PopoverContent>
    </Popover>
  );
}

interface DateTimePickerProps extends DatePickerProps {
  /** Default si el usuario elige fecha sin haber tocado hora. "HH:mm". */
  defaultTime?: string;
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = "Selecciona fecha y hora",
  disabled,
  className,
  id,
  defaultTime = "09:00",
}: DateTimePickerProps) {
  const [datePart, timePart] = (value ?? "").split("T");
  const date = parseDateOnly(datePart);
  const time = (timePart ?? "").slice(0, 5) || defaultTime;
  const locale = useDateLocale();

  const emit = (newDate: Date | undefined, newTime: string) => {
    if (!newDate) {
      onChange?.("");
      return;
    }
    const t = newTime || defaultTime;
    onChange?.(`${formatDateOnly(newDate)}T${t}`);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          type="button"
          className={cn(
            "w-full justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="h-4 w-4 mr-2 opacity-70 shrink-0" />
          <span className="truncate">
            {date ? `${format(date, "PP", { locale })} · ${time}` : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => emit(d, time)}
          autoFocus
          locale={locale}
        />
        <div className="border-t p-3 space-y-1.5">
          <Label className="text-xs">Hora</Label>
          <Input
            type="time"
            value={time}
            onChange={(e) => emit(date, e.target.value)}
            className="dark:[color-scheme:dark]"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
