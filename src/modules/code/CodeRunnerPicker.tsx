/**
 * CodeRunnerPicker — selector compacto del proveedor de ejecución para
 * UNA pregunta de código dentro de un examen.
 *
 * Por qué existe:
 *   El admin configura UN provider global (`code_execution_settings`).
 *   Pero durante un examen pueden pasar fallos transitorios:
 *     - AWS Lambda con cold start lento o timeout
 *     - OnlineCompiler.io con 5xx
 *     - CheerpJ que se cuelga descargando tools.jar
 *   Si el estudiante tiene UNA SOLA opción, pierde la pregunta. Con este
 *   picker puede alternar runners y seguir trabajando.
 *
 * UI:
 *   Un <Select> compacto encima del editor con:
 *     - "Por defecto" (la opción del admin, etiquetada como "(default)")
 *     - Cada proveedor compatible con el lenguaje de la pregunta
 *   Cuando el estudiante cambia, hace `onChange(provider | null)` —
 *   `null` = volver al default.
 *
 * Reglas de visibilidad por lenguaje:
 *   - Java: cheerp (browser), aws_lambda, onlinecompiler, jdoodle
 *   - Otros (python, cpp, etc.): aws_lambda, onlinecompiler, jdoodle
 *     (cheerp es Java-only)
 */
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Cpu } from "lucide-react";
import type { CodeLanguage } from "@/modules/code/CodeEditor";
import {
  providersForLanguage as providersForLanguageCanonical,
  type CodeProvider,
} from "@/modules/code/language-support";

// El tipo viene del MAPEO OFICIAL para que no existan dos nociones de
// "proveedor" que puedan divergir.
export type CodeRunnerProvider = CodeProvider;

const LABELS: Record<CodeRunnerProvider, string> = {
  aws_lambda: "AWS Lambda",
  onlinecompiler: "OnlineCompiler.io",
  cheerp: "CheerpJ (navegador)",
  jdoodle: "JDoodle",
};

/**
 * Providers válidos para un lenguaje. DELEGA al mapeo oficial
 * (`language-support.ts`), que es el mismo que usa el edge para rutear.
 *
 * WHY se reemplazó la lógica que vivía acá: era "todos menos cheerp si no es
 * java", lo que asumía que los tres proveedores server-side soportan cualquier
 * lenguaje. Es falso — OnlineCompiler.io NO ejecuta Kotlin. El selector lo
 * ofrecía igual, el alumno lo elegía y la corrida fallaba con un error de
 * proveedor que no explica nada. Ahora la lista sale de la misma tabla que
 * decide el ruteo real, así que lo que se ofrece es exactamente lo que puede
 * ejecutar.
 */
export function providersForLanguage(language: CodeLanguage): CodeRunnerProvider[] {
  return providersForLanguageCanonical(language);
}

interface Props {
  language: CodeLanguage;
  /** Provider activo del admin — etiquetado como "default" en la lista. */
  defaultProvider: string;
  /** Override actual del estudiante para esta pregunta. `undefined` = sin override. */
  value: CodeRunnerProvider | undefined;
  onChange: (next: CodeRunnerProvider | undefined) => void;
  /** Si la ejecución está en curso bloqueamos el cambio para evitar carreras. */
  disabled?: boolean;
}

const RESET_KEY = "__default__";

export function CodeRunnerPicker({
  language,
  defaultProvider,
  value,
  onChange,
  disabled,
}: Readonly<Props>) {
  const available = providersForLanguage(language);
  const isOverridden = value !== undefined && value !== defaultProvider;
  const selectValue = value ?? RESET_KEY;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground flex items-center gap-1">
        <Cpu className="h-3 w-3" />
        Compilador:
      </span>
      <Select
        value={selectValue}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === RESET_KEY) onChange(undefined);
          else onChange(v as CodeRunnerProvider);
        }}
      >
        <SelectTrigger className="h-8 w-40 sm:w-52 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={RESET_KEY}>
            Por defecto
            {LABELS[defaultProvider as CodeRunnerProvider] !== undefined && (
              <span className="text-muted-foreground ml-1">
                — {LABELS[defaultProvider as CodeRunnerProvider] ?? defaultProvider}
              </span>
            )}
          </SelectItem>
          {available.map((p) => (
            <SelectItem key={p} value={p}>
              {LABELS[p]}
              {p === defaultProvider && <span className="text-muted-foreground ml-1">(default)</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isOverridden && (
        <Badge variant="outline" className="text-3xs h-5">
          Override
        </Badge>
      )}
    </div>
  );
}
