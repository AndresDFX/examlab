/**
 * «¿Quién arma los grupos?» en el formulario de un taller o proyecto grupal.
 * Es independiente del modo de trabajo: grupal estricto o mixto siguen
 * significando lo mismo; esto solo decide si los grupos los forma el docente
 * (desde «Grupos») o los estudiantes (eligiendo compañeros de su curso). Con
 * estudiantes, los topes de integrantes se hacen cumplir en la base.
 */
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { esModoGrupal, TOPE_INTEGRANTES, topesInvalidos } from "@/modules/grupos/grupos-estudiante";

export interface CamposDeGrupo {
  students_form_groups?: boolean | null;
  group_size_min?: number | null;
  group_size_max?: number | null;
}

interface QuienArmaLosGruposProps {
  modo: string | null | undefined;
  valor: CamposDeGrupo;
  onChange: (cambios: CamposDeGrupo) => void;
}

export function QuienArmaLosGrupos({ modo, valor, onChange }: Readonly<QuienArmaLosGruposProps>) {
  const { t } = useTranslation();
  if (!esModoGrupal(modo)) return null;
  const arman = !!valor.students_form_groups;
  // Vacío se muestra vacío (con el default de la base como ejemplo): si se
  // rellenara con 2 al borrar, no habría cómo escribir otro número.
  const minimo = valor.group_size_min ?? null;
  const maximo = valor.group_size_max ?? null;
  const aNumero = (v: string) => (v.trim() === "" ? null : Math.trunc(Number(v)));

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <Label>{t("gruposEstudiante.docente.quienArma")}</Label>
        <Select
          value={arman ? "estudiantes" : "docente"}
          onValueChange={(v) => onChange({ students_form_groups: v === "estudiantes" })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="docente">{t("gruposEstudiante.docente.armaElDocente")}</SelectItem>
            <SelectItem value="estudiantes">
              {t("gruposEstudiante.docente.armanLosEstudiantes")}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-2xs text-muted-foreground leading-tight">
          {arman
            ? t("gruposEstudiante.docente.hintEstudiantes")
            : t("gruposEstudiante.docente.hintDocente")}
        </p>
      </div>
      {arman && (
        <div className="space-y-1">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="grupo-minimo">{t("gruposEstudiante.docente.minimo")}</Label>
              <Input
                id="grupo-minimo"
                type="number"
                min={1}
                max={TOPE_INTEGRANTES}
                value={minimo ?? ""}
                placeholder="2"
                onChange={(e) => onChange({ group_size_min: aNumero(e.target.value) })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="grupo-maximo">{t("gruposEstudiante.docente.maximo")}</Label>
              <Input
                id="grupo-maximo"
                type="number"
                min={1}
                max={TOPE_INTEGRANTES}
                value={maximo ?? ""}
                placeholder="5"
                onChange={(e) => onChange({ group_size_max: aNumero(e.target.value) })}
              />
            </div>
          </div>
          {topesInvalidos(minimo, maximo) && (
            <p className="text-2xs text-destructive">
              {t("gruposEstudiante.docente.topesInvalidos")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
