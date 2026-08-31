/**
 * Ayuda VISIBLE de "¿qué tablas hay en la base?" para las superficies de SQL.
 *
 * ── Por qué es visible y no solo un `?` ───────────────────────────────
 * El caso que la originó: alguien escribió `SELECT * FROM v_agenda_recepcion;`
 * contra una base donde ese objeto no existía. Es un fallo de *no saber que
 * había que preguntar*, y quien no sabe qué contiene la base tampoco sabe que
 * un icono `?` guarda la respuesta. Por eso la consulta se muestra en pantalla
 * y el `HelpHint` queda para lo que sí es una aclaración: el `\dt` de psql.
 *
 * ── Por qué un componente y no el texto suelto en el runner ───────────
 * Hoy lo monta un solo lugar, y aun así vale: el runner ya es el archivo donde
 * vive toda la mecánica de ejecución, y esta caja es texto + una acción. Tenerla
 * aparte deja el gate (`!readOnly`) y el POR QUÉ de la ubicación en un archivo
 * que se lee en 30 segundos, y es lo que permitió mover la decisión "solo donde
 * se ejecuta" sin tocar `run`.
 *
 * ── Por qué solo va donde el SQL se EJECUTA ───────────────────────────
 * No se monta en los formularios donde el docente escribe el esquema de partida
 * (examen / taller / proyecto): ese SQL corre antes que el del alumno y sus
 * resultados no se muestran, así que insertar un `SELECT` ahí correría en
 * silencio sin mostrar nada, y la única acción que quedaba —copiar— no tenía
 * destino a la vista en esa pantalla. Además, quien acaba de escribir el DDL sabe
 * qué creó: la ayuda es para quien se encuentra una base que no armó.
 */
import { useTranslation } from "react-i18next";
import { CornerDownLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HelpHint } from "@/components/ui/help-hint";
import { LIST_TABLES_SQL } from "@/modules/database/sql-help";
import { cn } from "@/shared/lib/utils";

interface Props {
  /** Agrega la consulta AL FINAL del editor. El caller decide cómo (ver `appendSqlBlock`). */
  onInsert: () => void;
  className?: string;
}

export function SqlTablesHelp({ onInsert, className }: Props) {
  const { t } = useTranslation();

  return (
    <div className={cn("space-y-1.5 rounded-md border bg-muted/30 p-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        {/* Sin icono a propósito: en el runner ya hay dos `Database` a menos de
            60px (el rótulo "Consulta" y el renglón del motor), y un tercero deja
            de distinguir. La caja ya se delimita con su borde y su fondo. */}
        <span className="flex items-center gap-1.5 text-2xs font-medium">
          {t("bdSql.listTablesLabel")}
          <HelpHint>
            <div className="space-y-1.5">
              <p>{t("bdSql.listTablesHint")}</p>
              {/* El error más probable de todos: quien viene de psql escribe
                  `\dt` primero, y el mensaje que recibe no insinúa qué hacer.
                  El texto del error NO se traduce — lo emite Postgres. Y es el que
                  emite de verdad, medido contra PGlite: el parser falla en el
                  PRIMER token inesperado, que es la barra, y nunca llega a `dt`.
                  Citar el error sirve para que la persona RECONOZCA lo que le
                  pasó; una cadena parecida pero distinta logra lo contrario. */}
              <p>
                {t("bdSql.listTablesPsqlPart1")} <code>{"\\dt"}</code>{" "}
                {t("bdSql.listTablesPsqlPart2")}{" "}
                <code>{'syntax error at or near "\\"'}</code>.
              </p>
              <p>{t("bdSql.listTablesAppendNote")}</p>
            </div>
          </HelpHint>
        </span>
        {/* Una sola acción: la que sirve donde hay un editor. Un botón de COPIAR
            al lado sobraría, y la toma de examen es justo la pantalla donde el
            proctoring bloquea copiar — ofrecerlo ahí sería incoherente. */}
        <Button size="sm" variant="outline" onClick={onInsert}>
          <CornerDownLeft className="mr-1 h-4 w-4" />
          {t("bdSql.listTablesInsert")}
        </Button>
      </div>
      {/* La consulta a la vista, no detrás del `?`: es el dato que se vino a
          buscar. Scrollea DENTRO de su caja para no empujar la página a 375px. */}
      <div className="overflow-x-auto">
        <code className="block whitespace-pre font-mono text-2xs text-muted-foreground">
          {LIST_TABLES_SQL}
        </code>
      </div>
    </div>
  );
}
