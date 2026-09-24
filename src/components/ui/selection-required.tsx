import { type ComponentType } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";

/**
 * `SelectionRequired` — la pantalla no muestra datos hasta que la persona
 * elige SOBRE QUÉ trabajar.
 *
 * ── El patrón, y por qué vale un componente ───────────────────────────
 * Varias pantallas del producto trabajan sobre UNA cosa a la vez (un curso,
 * un periodo, una asignatura) y resolvían el arranque igual de mal: eligiendo
 * solas la primera opción de la lista. Eso tiene tres problemas concretos:
 *
 *  · **Muestra datos de un curso arbitrario como si fueran «los datos».** El
 *    docente entra a Asistencia, ve una lista de estudiantes y un calendario,
 *    y no tiene por qué notar que son de un curso que él no eligió. El riesgo
 *    no es estético: pasar lista, marcar ausencias o abrir un check-in sobre
 *    el curso equivocado es un error que después hay que deshacer a mano.
 *  · **Carga datos que nadie pidió.** El primer curso puede tener 90
 *    estudiantes y 16 sesiones; se consultan, se pintan y se descartan en
 *    cuanto la persona elige el que de verdad venía a ver.
 *  · **Esconde el filtro.** Si la pantalla ya muestra algo, el selector de
 *    arriba parece decorativo. Con la pantalla en blanco, elegir es
 *    evidentemente el primer paso.
 *
 * ── La excepción que hace que no moleste ──────────────────────────────
 * Con UNA sola opción no se pregunta nada: elegirla es la única salida
 * posible, así que obligar al clic sería fricción pura. Eso lo decide
 * `resolverSeleccionInicial`, que es la parte con lógica y está testeada
 * aparte del componente.
 *
 * ── Cómo se usa ───────────────────────────────────────────────────────
 * ```tsx
 * // 1) al cargar las opciones, respetar la regla de la única opción
 * const inicial = resolverSeleccionInicial(cursos.map((c) => c.id));
 * if (inicial) setCourseId(inicial);
 *
 * // 2) cortar la carga de datos mientras no haya selección
 * useEffect(() => {
 *   if (!courseId) return;
 *   …
 * }, [courseId]);
 *
 * // 3) y en el render, antes del contenido
 * if (!courseId) {
 *   return (
 *     <SelectionRequired
 *       icon={CalendarCheck}
 *       title={t("…")}
 *       hint={t("…")}
 *       options={cursos.map((c) => ({ id: c.id, label: c.name, sub: c.period }))}
 *       onSelect={setCourseId}
 *     />
 *   );
 * }
 * ```
 *
 * Los atajos (`options`) son opcionales pero recomendados: un cartel que solo
 * dice «elige un curso» obliga a subir al selector, y cuando son tres o cuatro
 * es más rápido elegir ahí mismo. Se recortan a `maxOptions` para que la caja
 * no se convierta en una segunda lista — si son muchos, el selector de arriba
 * es el camino correcto y el texto lo dice.
 */

export interface SelectionOption {
  id: string;
  label: string;
  /** Línea secundaria: periodo, asignatura, grupo… */
  sub?: string | null;
}

interface SelectionRequiredProps {
  icon?: ComponentType<{ className?: string }>;
  /** Qué hay que elegir. Una frase. */
  title: string;
  /** Dónde elegirlo. Se muestra bajo el título. */
  hint?: string;
  /** Atajos para elegir sin subir al filtro. */
  options?: SelectionOption[];
  onSelect?: (id: string) => void;
  /** Tope de atajos visibles. Por encima, se remite al filtro de arriba. */
  maxOptions?: number;
  /** Qué decir cuando no hay NADA que elegir (distinto de «elige»). */
  emptyTitle?: string;
  emptyHint?: string;
  className?: string;
}

export const MAX_ATAJOS_POR_DEFECTO = 8;

export function SelectionRequired({
  icon,
  title,
  hint,
  options,
  onSelect,
  maxOptions = MAX_ATAJOS_POR_DEFECTO,
  emptyTitle,
  emptyHint,
  className,
}: SelectionRequiredProps) {
  const { t } = useTranslation();
  const todas = options ?? [];

  // Sin nada que elegir, el mensaje NO puede ser «elige una opción»: la
  // persona quedaría buscando un selector vacío sin entender que el problema
  // es otro (no tiene cursos asignados todavía).
  if (todas.length === 0 && (emptyTitle || emptyHint)) {
    return (
      <EmptyState
        icon={icon}
        title={emptyTitle ?? title}
        hint={emptyHint}
        className={className}
      />
    );
  }

  const visibles = todas.slice(0, maxOptions);
  const ocultas = todas.length - visibles.length;

  return (
    <EmptyState
      icon={icon}
      title={title}
      hint={hint}
      className={className}
      action={
        visibles.length > 0 && onSelect ? (
          <div className={cn("flex flex-col items-stretch gap-2 w-full max-w-sm")}>
            {visibles.map((o) => (
              <Button
                key={o.id}
                variant="outline"
                className="h-auto justify-start py-2 text-left"
                onClick={() => onSelect(o.id)}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{o.label}</span>
                  {o.sub ? (
                    <span className="truncate text-2xs font-normal text-muted-foreground">
                      {o.sub}
                    </span>
                  ) : null}
                </span>
              </Button>
            ))}
            {ocultas > 0 ? (
              <p className="text-2xs text-muted-foreground">
                {t("seleccion.masOpciones", { count: ocultas })}
              </p>
            ) : null}
          </div>
        ) : undefined
      }
    />
  );
}

/**
 * Qué seleccionar al cargar las opciones.
 *
 * Con UNA sola, se elige sola: obligar a un clic cuando no hay alternativa es
 * fricción pura. Con varias devuelve `null`, o sea «que elija la persona» —
 * que es el punto de todo esto: elegir la primera de la lista muestra datos
 * de algo que nadie pidió, y en una pantalla como Asistencia eso se traduce
 * en pasar lista sobre el curso equivocado.
 */
export function resolverSeleccionInicial(ids: readonly string[]): string | null {
  const limpios = ids.filter((id) => typeof id === "string" && id.trim() !== "");
  return limpios.length === 1 ? limpios[0] : null;
}
