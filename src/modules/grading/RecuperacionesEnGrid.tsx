/**
 * Piezas visuales de las recuperaciones DENTRO de los grids del docente
 * (exámenes y talleres): la fila del original lleva un botón con cuántas tiene y
 * al desplegarlo aparecen como sub-filas, alineadas a las mismas columnas. El
 * árbol lo arma `arbolDeRecuperaciones`; esto solo pinta, para que los dos grids
 * se vean igual.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight, CornerDownRight, GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { tituloSinTipo } from "@/modules/grading/arbol-recuperaciones";
import { reglaDeRecuperatorio, tipoDeRecuperacion } from "@/modules/grading/nota-con-recuperacion";

/** Fondo de la sub-fila: la distingue de las filas del grid sin apagarla. */
export const CLASE_FILA_RECUPERACION = "bg-muted/30";

/**
 * Qué filas abrió o cerró el docente. Sin tocar, una fila está abierta si viene
 * en `abiertasPorDefecto` (la que está en la lista SOLO por una recuperación).
 *
 * Va en `sessionStorage` porque la pantalla se DESMONTA al ir al editor de una
 * recuperación —y crear una lleva directo al editor de la copia—: en memoria, al
 * volver la fila estaría cerrada otra vez y la recuperación recién creada,
 * escondida. Se lee después de montar (regla de hidratación #418) y se escribe
 * en el mismo cambio, no en un efecto, porque navegar desmonta antes de que el
 * efecto corra. Todo acceso va en try/catch: sin storage (navegación privada)
 * funciona igual, solo que no recuerda.
 */
export function useRecuperacionesDesplegadas(
  claveStorage: string,
  abiertasPorDefecto: ReadonlySet<string>,
) {
  const [desplegadas, setDesplegadas] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  useEffect(() => {
    try {
      const guardado = sessionStorage.getItem(claveStorage);
      if (!guardado) return;
      const valores = JSON.parse(guardado) as Record<string, unknown>;
      setDesplegadas(
        new Map(
          Object.entries(valores).filter(
            (par): par is [string, boolean] => typeof par[1] === "boolean",
          ),
        ),
      );
    } catch {
      /* storage bloqueado o JSON roto: arranca sin recordar nada */
    }
  }, [claveStorage]);

  const cambiar = useCallback(
    (id: string, abrir: (actual: boolean) => boolean) =>
      setDesplegadas((prev) => {
        const siguiente = new Map(prev).set(id, abrir(prev.get(id) ?? abiertasPorDefecto.has(id)));
        try {
          sessionStorage.setItem(claveStorage, JSON.stringify(Object.fromEntries(siguiente)));
        } catch {
          /* no crítico: la fila se abre igual, solo no se recuerda */
        }
        return siguiente;
      }),
    [claveStorage, abiertasPorDefecto],
  );

  return {
    estaDesplegada: (id: string) => desplegadas.get(id) ?? abiertasPorDefecto.has(id),
    alternar: (id: string) => cambiar(id, (actual) => !actual),
    abrir: (id: string) => cambiar(id, () => true),
  };
}

/**
 * Supletorio / Recuperatorio. El tooltip dice cómo cuenta la nota, que es lo
 * que los distingue: el supletorio solo llena una ausencia y el recuperatorio
 * combina según su regla.
 */
export function InsigniaDeRecuperacion({
  tipo,
  regla,
  conIcono = true,
}: {
  tipo: unknown;
  regla?: unknown;
  /** En la sub-fila sobra: el conector ya dice de quién cuelga, y el título
   *  necesita ese ancho en una columna angosta. */
  conIcono?: boolean;
}) {
  const { t } = useTranslation();
  const esRecuperatorio = tipoDeRecuperacion(tipo) === "recuperatorio";
  const ayuda = esRecuperatorio
    ? reglaDeRecuperatorio(regla) === "reemplaza"
      ? `${t("recuperaciones.ruleReemplaza")}. ${t("recuperaciones.ruleReemplazaHint")}`
      : `${t("recuperaciones.ruleMayor")}. ${t("recuperaciones.ruleMayorHint")}`
    : t("recuperaciones.kindSupletorioHint");
  return (
    <Badge variant="outline" className="text-3xs shrink-0" title={ayuda}>
      {conIcono && <GitBranch className="h-3 w-3 mr-1" />}
      {esRecuperatorio
        ? t("recuperaciones.badgeRecuperatorio")
        : t("recuperaciones.badgeSupletorio")}
    </Badge>
  );
}

/**
 * Botón de la fila del original: cuántas recuperaciones tiene, y las despliega.
 * El margen negativo deja el área táctil completa sin agrandar la línea del
 * título: sin él, las filas con recuperaciones quedarían más altas que las
 * demás. Son 32 px (`-my-1.5`) con mouse y 44 px con dedo, porque la regla
 * táctil de `styles.css` sube todo botón a 44 (`pointer-coarse:-my-3`). El
 * `relative` lo pinta encima de la línea de abajo, que en el teléfono queda a
 * menos de lo que sobresale: sin él, esa franja del botón no responde.
 */
export function BotonRecuperaciones({
  cantidad,
  abierto,
  onToggle,
  titulo,
}: {
  cantidad: number;
  abierto: boolean;
  onToggle: () => void;
  /** Título del original: el nombre accesible dice DE QUÉ son. */
  titulo: string;
}) {
  const { t } = useTranslation();
  const etiqueta = abierto
    ? t("recuperaciones.hideForRow", { count: cantidad, title: titulo })
    : t("recuperaciones.showForRow", { count: cantidad, title: titulo });
  const Chevron = abierto ? ChevronDown : ChevronRight;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="relative h-8 -my-1.5 pointer-coarse:-my-3 px-1.5 gap-1 shrink-0 text-xs font-normal tabular-nums text-muted-foreground hover:text-foreground"
      aria-expanded={abierto}
      aria-label={etiqueta}
      title={etiqueta}
      onClick={onToggle}
    >
      <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
      {cantidad}
      <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  );
}

/**
 * Primera línea de la celda de título en la sub-fila. La insignia va ANTES del
 * título: cuando la columna es angosta, lo que queda a la vista es qué clase de
 * recuperación es. Y el título se muestra sin el tipo, que la insignia ya dice.
 */
export function TituloDeRecuperacion({
  titulo,
  tipo,
  regla,
}: {
  titulo: string;
  tipo: unknown;
  regla?: unknown;
}) {
  const { t } = useTranslation();
  const etiquetaDelTipo =
    tipoDeRecuperacion(tipo) === "recuperatorio"
      ? t("recuperaciones.badgeRecuperatorio")
      : t("recuperaciones.badgeSupletorio");
  return (
    <div className="flex items-center gap-1.5 min-w-0 pl-1">
      <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <InsigniaDeRecuperacion tipo={tipo} regla={regla} conIcono={false} />
      <span className="truncate" title={titulo}>
        {tituloSinTipo(titulo, etiquetaDelTipo)}
      </span>
    </div>
  );
}

/**
 * El aviso del diálogo de borrado cuando lo que se borra tiene recuperaciones:
 * dice cuántas y de qué tipo, y que se van a la papelera con el original. ""
 * si no tiene ninguna (el caller lo concatena a su propio texto).
 */
export function avisoDeRecuperacionesAlBorrar(
  t: TFunction,
  recuperaciones: readonly { makeup_kind?: string | null }[],
): string {
  if (recuperaciones.length === 0) return "";
  const recuperatorios = recuperaciones.filter(
    (r) => tipoDeRecuperacion(r.makeup_kind) === "recuperatorio",
  ).length;
  const supletorios = recuperaciones.length - recuperatorios;
  const tipos = [
    supletorios > 0 && t("recuperaciones.countSupletorio", { count: supletorios }),
    recuperatorios > 0 && t("recuperaciones.countRecuperatorio", { count: recuperatorios }),
  ]
    .filter(Boolean)
    .join(t("recuperaciones.countJoin"));
  return t("recuperaciones.deleteAlsoMakeups", { count: recuperaciones.length, tipos });
}
