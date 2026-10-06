/**
 * Runner de preguntas `bd_sql`: editor de SQL + PostgreSQL REAL en el navegador.
 *
 * Mismo contrato de props que `V86Console` (`value` / `onChange` / `readOnly` /
 * `className`) para que integrarlo en cada flujo sea idéntico a lo que ya se hizo
 * con la consola Linux: la respuesta viaja serializada como string en la columna
 * de respuesta existente.
 *
 * ── Decisiones que no son obvias ──────────────────────────────────────
 *
 * **La base se crea al pulsar Ejecutar, no al montar.** Son ~16 MB de WASM: si se
 * cargaran al abrir la pregunta, un examen con 5 preguntas SQL bajaría 16 MB
 * antes de que el alumno escriba una letra, y las preguntas que no piensa
 * ejecutar pagarían el costo igual.
 *
 * **Cada ejecución arranca una base LIMPIA** (se cierra la anterior). Es
 * deliberado y es lo contrario de una consola: en SQL, dejar estado entre corridas
 * hace que un `INSERT` ejecutado dos veces duplique filas y el alumno vea
 * resultados que su script no explica. Con base limpia + `setupSql` del docente,
 * ejecutar dos veces da el MISMO resultado — que es lo que hace calificable el
 * ejercicio.
 *
 * **El `setupSql` del docente se ejecuta aparte y sus errores se muestran como
 * error del ENUNCIADO, no del alumno.** Si el docente se equivoca en el esquema,
 * el estudiante tiene que poder distinguirlo de su propio error; si no, se lleva
 * la culpa de algo que no hizo.
 *
 * **Si hay texto seleccionado, se ejecuta SOLO eso.** Es el gesto que espera
 * cualquiera que venga de un cliente SQL (DBeaver, pgAdmin, DataGrip): en una
 * hoja con el esquema, los INSERT y varias consultas, correr el archivo entero
 * para ver UNA consulta significa recrear la base cada vez y leer la respuesta
 * al final de una lista de resultados. El docente que explica en vivo necesita
 * justo lo contrario: parar en una línea, correrla y hablar sobre ella. Antes de
 * la selección corren SIEMPRE el `setupSql` **y las sentencias de la hoja que
 * están más ARRIBA**, sin mostrar sus resultados: la base es limpia por corrida,
 * así que sin eso una consulta suelta no tendría contra qué correr — ni contra el
 * esquema del docente ni contra un `CREATE TABLE` escrito en el propio editor.
 *
 * **El guion se ejecuta SENTENCIA POR SENTENCIA y sigue después de un error.**
 * Mandar la hoja completa en un solo `exec` la corre en una TRANSACCIÓN
 * IMPLÍCITA de Postgres: cualquier error revierte lo que venía antes. Medido con
 * PGlite 0.5.4, un `SELECT` a una vista inexistente en la línea 1 deshacía el
 * `CREATE TABLE` de la línea 3 y la tabla NO quedaba creada — lo que se leía
 * como "no puedo crear tablas desde el editor", porque el error visible era el de
 * la primera línea y la creación desaparecía sin rastro. Partir el guion exige
 * respetar literales, comentarios y bloques `$`: eso vive en
 * `sql-split.ts`, con tests.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Database, AlertTriangle } from "lucide-react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { HelpHint } from "@/components/ui/help-hint";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/shared/lib/utils";
import { useEditorZoom } from "@/hooks/use-editor-zoom";
import { useVentana } from "@/hooks/use-ventana";
import {
  esPantallaAngosta,
  OPCIONES_EN_PANTALLA_ANGOSTA,
} from "@/modules/code/editor-opciones";
import { EditorCargando } from "@/modules/code/EditorCargando";
import { EditorZoomControls } from "@/modules/code/EditorZoomControls";
import {
  decidirModoTexto,
  useMonacoListo,
  type MotivoTextoPlano,
} from "@/modules/code/use-monaco-listo";
import {
  createEphemeralDb,
  type PgliteDb,
  type PgliteResult,
} from "@/modules/database/pglite-loader";
import { splitSqlStatements } from "@/modules/database/sql-split";
import { appendSqlBlock, LIST_TABLES_SQL } from "@/modules/database/sql-help";
import { SqlTablesHelp } from "@/modules/database/SqlTablesHelp";
import {
  formatCell,
  formatNotice,
  MAX_NOTICES,
  MAX_PERSISTED_ROWS,
  parseSqlAnswer,
  renderTable,
  serializeSqlAnswer,
  type SqlStatementResult,
} from "@/modules/database/sql-answer";

interface Props {
  /** Respuesta serializada (o null). */
  value: string | null;
  onChange: (v: string) => void;
  readOnly?: boolean;
  className?: string;
  /** Esquema + datos de partida que preparó el docente (`options.db.setupSql`). */
  setupSql?: string | null;
  /** SQL inicial sugerido (`starter_code`). */
  starterSql?: string | null;
  /**
   * Con `readOnly`, deja el botón Ejecutar visible y funcional (el alumno
   * puede correr la consulta fija del docente para ver el resultado) pero
   * SIN persistir — la corrida queda solo en memoria local. Mismo contrato
   * que `CodePageEditor`/`V86Console` en la pizarra: "puede ejecutar para
   * probar, pero su salida no se persiste". Sin esto, `readOnly` esconde el
   * botón entero (comportamiento de revisión post-hoc, que es lo único que
   * usan hoy los flujos de examen/taller).
   */
  readOnlyAllowRun?: boolean;
  /**
   * Rótulo del editor. Default: "Consulta". La hoja de la pizarra pasa
   * "2 · Consulta" porque ahí ARRIBA hay otro editor (el del esquema, "1 ·
   * Esquema") y los números son lo que comunica que uno corre antes del otro.
   * En examen/taller el runner es el único editor, así que no lleva número.
   */
  queryLabel?: string;
  /** Identidad estable de la pregunta/hoja, para que el zoom quede guardado
   *  solo acá — ver `useEditorZoom`. */
  zoomScopeKey?: string | null;
  /**
   * Layout de HERRAMIENTA: el runner llena el alto que le dan, el encabezado
   * (con Ejecutar) queda siempre a la vista, y el editor y los resultados se
   * reparten el resto con un divisor que el usuario arrastra.
   *
   * Es **opt-in** y no el comportamiento por defecto por una razón concreta:
   * de los tres puntos de montaje, examen y taller NO pasan `className`, así
   * que su alto lo da el contenido dentro de la tarjeta de la pregunta, que
   * scrollea. Volver esto el default los colapsaría a cero — es decir,
   * rompería la pantalla de tomar un examen. Lo usa solo la hoja de la
   * pizarra, que sí tiene un alto propio que llenar.
   *
   * Sin esto, el encabezado se iba con el scroll: para ejecutar había que
   * subir, que es exactamente lo que se reportó.
   */
  fillHeight?: boolean;
  /**
   * ¿Lo que se escribe acá es una ENTREGA que alguien va a calificar?
   *
   * **Default `false`, o sea que falla cerrado.** El respaldo de texto plano
   * tranquiliza diciendo «se guarda igual y se califica leyendo la consulta», y
   * eso es cierto en un examen y en un taller pero **falso en la hoja SQL de la
   * pizarra**, donde el runner es una demostración en vivo y no hay entrega ni
   * nota. Prometer una calificación que no existe es peor que omitir la
   * tranquilidad, así que hay que pedirla explícitamente: una superficie nueva
   * que se olvide de pasarla dice de menos, nunca de más.
   */
  graded?: boolean;
}

/** Reparto editor/resultados del divisor. UNA clave para todas las hojas: la
 *  proporción preferida es de la persona, y por hoja obligaría a re-arrastrar
 *  cada vez que se crea una nueva (mismo criterio que el zoom compartido). */
const SPLIT_KEY = "examlab_sql_split";
const PANEL_EDITOR = "sql-editor";
const PANEL_RESULTS = "sql-results";

/** Convierte el resultado crudo de PGlite a nuestra forma serializable. */
function toStatementResult(sql: string, r: PgliteResult): SqlStatementResult {
  const columns = (r.fields ?? []).map((f) => f.name);
  const rows = (r.rows ?? [])
    .slice(0, MAX_PERSISTED_ROWS)
    .map((row) => columns.map((c) => formatCell((row as Record<string, unknown>)[c])));
  return {
    sql,
    columns,
    rows,
    ...(r.affectedRows !== undefined ? { affectedRows: r.affectedRows } : {}),
  };
}

export function SqlRunner({
  value,
  onChange,
  readOnly,
  className,
  setupSql,
  starterSql,
  readOnlyAllowRun,
  queryLabel,
  zoomScopeKey = null,
  fillHeight,
  graded,
}: Props) {
  const { t } = useTranslation();
  const parsed = parseSqlAnswer(value);
  const [sql, setSql] = useState<string>(parsed?.sql ?? starterSql ?? "");
  const [results, setResults] = useState<SqlStatementResult[]>(parsed?.results ?? []);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  /** Cuántas sentencias de ARRIBA fallaron al correr una selección (ver `run`). */
  const [contextoFallido, setContextoFallido] = useState(0);
  const dbRef = useRef<PgliteDb | null>(null);
  const cancelledRef = useRef(false);
  /** Instancia de Monaco: es la única fuente de la selección del usuario. */
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  /** Solo para la etiqueta del botón; el texto real se relee al ejecutar. */
  const [hasSelection, setHasSelection] = useState(false);
  /**
   * El atajo Ctrl/Cmd+Enter se registra en Monaco UNA sola vez al montar, así
   * que capturaría el `run` de ese primer render (con el `sql` vacío y el
   * `setupSql` viejo). La ref lo mantiene apuntando a la versión actual.
   */
  const runRef = useRef<() => void>(() => {});
  const {
    zoom,
    zoomIn,
    zoomOut,
    reset: resetZoom,
    atMin,
    atMax,
    pct,
  } = useEditorZoom(zoomScopeKey);

  const ventana = useVentana();
  const angosta = esPantallaAngosta(ventana);

  /**
   * Respaldo cuando el editor no está: una caja de texto plano.
   *
   * Monaco no viaja en el bundle — son 1,05 MB comprimidos que se bajan de
   * jsDelivr al montar el editor (ver `use-monaco-listo.ts`). Mientras tanto,
   * una pregunta `bd_sql` NO tiene ningún otro lugar donde responder: sin esto,
   * una red lenta o un CDN bloqueado dejan al alumno mirando un recuadro con
   * «Loading...» hasta que se acaba el examen, sin error y sin salida.
   *
   * La caja de texto no descarga nada y escribe en el MISMO estado (`sql`), así
   * que la respuesta se guarda y se califica exactamente igual — la propia
   * directiva de la IA dice que un SQL sin ejecutar se califica leyéndolo.
   */
  const { estado: estadoEditor, lento: editorLento } = useMonacoListo();
  const [modoTexto, setModoTexto] = useState<MotivoTextoPlano | null>(null);

  // El cambio automático es lo que destraba al alumno: el loader NO rechaza
  // cuando la red está lenta, solo se queda cargando, así que esperar un error
  // sería esperar para siempre. La regla vive en `decidirModoTexto` —con sus
  // tests— porque sus dos condiciones se ven triviales y no lo son.
  useEffect(() => {
    const siguiente = decidirModoTexto(modoTexto, estadoEditor, editorLento);
    if (siguiente !== modoTexto) setModoTexto(siguiente);
  }, [estadoEditor, editorLento, modoTexto]);

  // Al pasar a texto plano, la instancia de Monaco deja de existir para este
  // runner: sin esto `selectedSql()` seguiría leyendo un editor desmontado y el
  // botón diría «Ejecutar selección» sobre una selección que ya no existe.
  useEffect(() => {
    if (!modoTexto) return;
    editorRef.current = null;
    setHasSelection(false);
  }, [modoTexto]);

  /* Inline style porque es una DIMENSIÓN de runtime — excepción (b) de la regla
     de inline styles. El valor sale del TOKEN de P2 (`--text-2xs`/`--text-3xs`),
     no de un px inventado: `text-[Npx]` sigue prohibido y el grep del principio
     sigue dando 0. A zoom === 1 no se emite estilo: la vista por defecto queda
     byte-idéntica a la de antes de este cambio. */
  const zoomStyle = (token: "--text-2xs" | "--text-3xs") =>
    zoom === 1 ? undefined : { fontSize: `calc(var(${token}) * ${zoom})` };

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      // Liberar el WASM al desmontar: sin esto, navegar entre preguntas SQL
      // deja una instancia de Postgres viva por pregunta visitada.
      void dbRef.current?.close().catch(() => {});
      dbRef.current = null;
    };
  }, []);

  /** Persiste SQL + resultados juntos: la base es efímera, la evidencia no. */
  const persist = useCallback(
    (nextSql: string, nextResults: SqlStatementResult[], executed: boolean) => {
      onChange(
        serializeSqlAnswer({
          sql: nextSql,
          results: nextResults,
          ...(executed ? { executedAt: new Date().toISOString() } : {}),
        }),
      );
    },
    [onChange],
  );

  const onSqlChange = (next: string) => {
    // Defensivo: con Monaco en readOnly el usuario no puede tipear, así que
    // esto no debería dispararse — pero si algún caller cambia `readOnly` en
    // caliente, no queremos persistir un cambio que no debió pasar.
    if (readOnly) return;
    setSql(next);
    // Se guarda el SQL aunque no se haya ejecutado: escribir y no probar ES una
    // respuesta (ver `isSqlAnswerBlank`). Los resultados viejos se conservan.
    persist(next, results, false);
  };

  /**
   * Texto seleccionado en el editor, o `""` si no hay selección real.
   *
   * Se leen TODAS las selecciones (Monaco permite multi-cursor con Alt+clic) y
   * se unen en el orden en que están en el documento, no en el orden en que se
   * hicieron los clics: si no, dos líneas elegidas de abajo hacia arriba se
   * ejecutarían al revés y un INSERT correría antes que su CREATE TABLE.
   */
  const selectedSql = useCallback((): { sql: string; inicio: number } => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return { sql: "", inicio: 0 };
    const ranges = (editor.getSelections() ?? [])
      .filter((r) => !r.isEmpty())
      .sort((a, b) =>
        a.startLineNumber !== b.startLineNumber
          ? a.startLineNumber - b.startLineNumber
          : a.startColumn - b.startColumn,
      );
    if (ranges.length === 0) return { sql: "", inicio: 0 };
    return {
      sql: ranges
        .map((r) => model.getValueInRange(r))
        .join("\n")
        .trim(),
      // Dónde EMPIEZA la selección dentro de la hoja: es lo que permite correr
      // antes lo que está arriba (ver `run`).
      inicio: model.getOffsetAt({
        lineNumber: ranges[0].startLineNumber,
        column: ranges[0].startColumn,
      }),
    };
  }, []);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      // La etiqueta del botón tiene que decir la verdad sobre lo que va a
      // correr, así que el estado se sincroniza con cada cambio de selección.
      editor.onDidChangeCursorSelection(() => {
        setHasSelection(!!selectedSql().sql);
      });
      // Ctrl/Cmd+Enter: el atajo que ya trae aprendido quien usa un cliente SQL.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        void runRef.current();
      });
    },
    [selectedSql],
  );

  /**
   * Agrega la consulta que lista las tablas AL FINAL de la hoja.
   *
   * Se edita por Monaco (`executeEdits`) y no por estado por dos motivos: el
   * cambio entra en su pila de deshacer, así que Ctrl+Z lo revierte como
   * cualquier otra escritura; y el modelo queda actualizado en el acto, que es
   * lo que permite dejar el cursor al final. Eso último no es cosmético: con
   * una selección viva el botón Ejecutar corre SOLO la selección (ver `run`),
   * así que sin colapsarla se agregaría la consulta y al ejecutar no correría.
   */
  const insertListTables = () => {
    if (readOnly) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    const next = appendSqlBlock(model?.getValue() ?? sql, LIST_TABLES_SQL);
    if (!editor || !model) {
      setSql(next);
      persist(next, results, false);
      return;
    }
    editor.executeEdits("examlab-list-tables", [{ range: model.getFullModelRange(), text: next }]);
    // `onChange` de Monaco ya disparó `onSqlChange` (estado + persistencia).
    const fin = model.getFullModelRange().getEndPosition();
    editor.setPosition(fin);
    editor.revealPositionInCenter(fin);
    editor.focus();
  };

  const run = async () => {
    // Con selección se corre SOLO eso; sin selección, la hoja entera.
    const { sql: selected, inicio: inicioSeleccion } = selectedSql();
    const sqlToRun = selected || sql;
    if (running || !sqlToRun.trim()) return;
    setRunning(true);
    setLoadError(null);
    setSetupError(null);
    setContextoFallido(0);
    try {
      // Base LIMPIA por corrida — ver el encabezado del archivo.
      if (dbRef.current) {
        await dbRef.current.close().catch(() => {});
        dbRef.current = null;
      }
      const db = await createEphemeralDb();
      if (cancelledRef.current) {
        await db.close().catch(() => {});
        return;
      }
      dbRef.current = db;

      // 1) Esquema del docente. Su error NO es culpa del alumno.
      if (setupSql && setupSql.trim()) {
        try {
          await db.exec(setupSql);
        } catch (e) {
          if (cancelledRef.current) return;
          setSetupError(e instanceof Error ? e.message : String(e));
          setResults([]);
          return;
        }
      }

      // 1b) Si se corre una SELECCIÓN, lo que está ARRIBA corre antes como
      //     contexto. Es la misma razón por la que el `setupSql` siempre corre:
      //     la base es NUEVA en cada corrida, así que una consulta suelta no
      //     tiene contra qué correr si su tabla se crea más arriba EN LA HOJA.
      //     Sin esto, un `CREATE TABLE` escrito en el editor solo servía
      //     corriendo la hoja completa. Los errores del contexto no se detallan
      //     —no es lo que se pidió ejecutar— pero se CUENTAN: si la selección
      //     falla por algo de arriba, hay que poder verlo.
      if (selected) {
        let fallos = 0;
        for (const previa of splitSqlStatements(sql).filter((x) => x.end <= inicioSeleccion)) {
          try {
            await db.exec(previa.sql);
          } catch {
            fallos++;
          }
          if (cancelledRef.current) return;
        }
        setContextoFallido(fallos);
      }

      // 2) SQL del alumno. Un error de Postgres NO es una excepción de la app:
      //    es el resultado del ejercicio y hay que mostrarlo tal cual, porque
      //    leer el mensaje de error es parte de aprender SQL.
      //
      //    Se corre SENTENCIA POR SENTENCIA y se sigue después de un error. Un
      //    solo `exec` con la hoja entera la ejecuta en una TRANSACCIÓN
      //    IMPLÍCITA: medido con PGlite 0.5.4, un `SELECT` a una vista
      //    inexistente en la línea 1 REVERTÍA el `CREATE TABLE` de la línea 3 y
      //    la tabla no quedaba creada — que es exactamente lo que se leía como
      //    "no puedo crear tablas desde el editor". Así cada error queda junto a
      //    SU sentencia y lo que era correcto surte efecto.
      const next: SqlStatementResult[] = [];
      for (const sentencia of splitSqlStatements(sqlToRun)) {
        // `RAISE NOTICE` / `INFO` / `WARNING`: PGlite los entrega SOLO por este
        // callback y sin él se pierden en silencio — un procedimiento que avisa
        // «Insumo 3 dado de baja» no mostraba nada y parecía no haber corrido.
        // Van con SU sentencia, incluso si después falla: un NOTICE seguido de
        // un RAISE EXCEPTION es justo lo que se depura.
        const avisos: string[] = [];
        let totalDeAvisos = 0;
        const onNotice = (n: Parameters<typeof formatNotice>[0]) => {
          totalDeAvisos++;
          if (avisos.length < MAX_NOTICES) avisos.push(formatNotice(n));
        };
        const marcasDeAvisos = () =>
          avisos.length > 0
            ? { notices: avisos, ...(totalDeAvisos > MAX_NOTICES ? { noticesTruncated: true } : {}) }
            : {};
        try {
          const out = await db.exec(sentencia.sql, { onNotice });
          const conAvisos = marcasDeAvisos();
          if (!out || out.length === 0) {
            next.push({ sql: sentencia.sql, columns: [], rows: [], affectedRows: 0, ...conAvisos });
          } else {
            out.forEach((r, i) =>
              next.push({ ...toStatementResult(sentencia.sql, r), ...(i === 0 ? conAvisos : {}) }),
            );
          }
        } catch (e) {
          next.push({
            sql: sentencia.sql,
            columns: [],
            rows: [],
            error: e instanceof Error ? e.message : String(e),
            ...marcasDeAvisos(),
          });
        }
        if (cancelledRef.current) return;
      }
      // Una hoja que son puros comentarios no produce sentencias: se muestra
      // una fila igual para que el botón no parezca no haber hecho nada.
      if (next.length === 0) {
        next.push({ sql: sqlToRun.trim(), columns: [], rows: [], affectedRows: 0 });
      }
      if (cancelledRef.current) return;
      setResults(next);
      // En modo readOnly (alumno probando la consulta fija del docente en la
      // pizarra) la corrida NO se persiste — mismo trade-off que el output
      // local de CodePageEditor.
      // Se persiste la hoja COMPLETA como respuesta (es lo que el alumno
      // escribió) junto con los resultados de lo que realmente corrió; cada
      // resultado ya lleva su propia sentencia, así que la evidencia sigue
      // diciendo qué produjo cada tabla aunque se haya corrido una selección.
      if (!readOnly) persist(sql, next, true);
    } catch (e) {
      if (cancelledRef.current) return;
      // Acá solo caen fallos de CARGA del motor (red/CDN), no errores de SQL.
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!cancelledRef.current) setRunning(false);
    }
  };

  useEffect(() => {
    runRef.current = run;
  });

  // Reparto guardado del divisor. NO se lee en el initializer de `useState`
  // (regla de hidratación #418 del proyecto): arranca en null y se lee
  // post-montaje. El grupo no se renderiza hasta esa lectura porque la librería
  // consulta `defaultLayout` UNA sola vez, al montar — renderizarlo antes
  // dejaría el reparto por defecto y la preferencia guardada no se aplicaría
  // nunca. Todo en try/catch: `localStorage` LANZA en navegación privada.
  const [reparto, setReparto] = useState<Record<string, number> | null>(null);
  const [repartoListo, setRepartoListo] = useState(false);
  useEffect(() => {
    if (!fillHeight) return;
    try {
      const raw = window.localStorage.getItem(SPLIT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setReparto(parsed as Record<string, number>);
      }
    } catch {
      /* storage bloqueado: se usa el reparto por defecto */
    }
    setRepartoListo(true);
  }, [fillHeight]);

  const guardarReparto = (layout: Record<string, number>) => {
    try {
      window.localStorage.setItem(SPLIT_KEY, JSON.stringify(layout));
    } catch {
      /* no se puede guardar: el arrastre igual funciona en esta sesión */
    }
  };

  // Editor y resultados salen a variables para poder COMPONERLOS de dos formas
  // sin duplicar el JSX: apilados (examen/taller, alto por contenido) o
  // repartidos por un divisor arrastrable (la hoja de la pizarra).
  // El editor: en modo herramienta llena su panel y el alto lo decide el
  // divisor que arrastra el usuario; si no, conserva el alto fijo que escala
  // con la fuente.
  const bloqueMonaco = (
    <div className={cn("overflow-hidden rounded-md border", fillHeight && "h-full min-h-0")}>
      <Editor
        // Sin `fillHeight` el alto escala con la fuente: si no, subir el
        // zoom no agranda, RECORTA (de ~11 líneas visibles a ~4).
        height={fillHeight ? "100%" : `${14 * zoom}rem`}
        language="sql"
        value={sql}
        onChange={(v) => onSqlChange(v ?? "")}
        onMount={handleMount}
        options={{
          readOnly: !!readOnly,
          minimap: { enabled: false },
          fontSize: Math.round(13 * zoom),
          scrollBeyondLastLine: false,
          wordWrap: "on",
          automaticLayout: true,
          // En un teléfono la canaleta de Monaco se comía 76 px de ancho — ver
          // `editor-opciones.ts`. El ALTO de la hoja de SQL no se toca acá: lo
          // reparte el divisor de la pizarra o la tabla de resultados de abajo.
          ...(angosta ? OPCIONES_EN_PANTALLA_ANGOSTA : {}),
        }}
      />
    </div>
  );

  /* Mientras el editor baja. Reemplaza al literal «Loading...» que trae
     `@monaco-editor/react`: sin traducir, sin spinner y —lo importante— sin
     final, porque si la carga falla la librería solo escribe en la consola y
     deja ese nodo puesto para siempre (ver `use-monaco-listo.ts`).

     El botón de escribir sin el editor está desde el primer segundo y no
     después del plazo: quien ya sabe que su conexión es mala no tiene por qué
     esperar 8 s para descubrir que había una salida. En solo lectura no va —
     ahí no hay nada que escribir y el cambio automático ya evita la espera
     infinita.

     `minHeight` es una DIMENSIÓN de runtime (excepción (b) de la regla de
     estilos en línea): el mismo alto que tendría Monaco, para que la caja no
     salte de tamaño al llegar el editor. */
  const bloqueCargandoEditor = (
    <EditorCargando
      texto={t("bdSql.editorLoading")}
      className={cn("rounded-md border", fillHeight && "h-full min-h-0")}
      style={fillHeight ? undefined : { minHeight: `${14 * zoom}rem` }}
    >
      {!readOnly && (
        <Button variant="outline" size="sm" onClick={() => setModoTexto("manual")}>
          {t("bdSql.writeWithoutEditor")}
        </Button>
      )}
    </EditorCargando>
  );

  /* El aviso de la caja se arma en dos partes: POR QUÉ se está viendo y QUÉ pasa
     con lo que se escriba. La segunda depende del contexto y por eso no puede ser
     una sola cadena: en solo lectura no hay nada que guardar (`onSqlChange` ni
     siquiera corre), y fuera de una entrega no hay nada que calificar. */
  const motivoDelTextoPlano =
    modoTexto === "error"
      ? t("bdSql.plainBecauseError")
      : modoTexto === "lento"
        ? t("bdSql.plainBecauseSlow")
        : t("bdSql.plainManual");
  const consecuenciaDelTextoPlano = readOnly
    ? null
    : graded
      ? t("bdSql.plainSavedGraded")
      : t("bdSql.plainSaved");

  /* La caja de texto plano: el piso que SIEMPRE funciona, sin descargar nada.
     Escribe en el mismo `sql` que Monaco, así que cambiar de una a otra no
     pierde una letra y lo persistido es idéntico.

     El corrector y la mayúscula automática van APAGADOS: en un teléfono
     convierten `select` en `Select` y subrayan cada identificador, que es
     justo lo que hace impracticable escribir SQL ahí. */
  const bloqueTextoPlano = (
    <div className={cn("space-y-1.5", fillHeight && "flex h-full min-h-0 flex-col")}>
      <Textarea
        value={sql}
        onChange={(e) => onSqlChange(e.target.value)}
        readOnly={!!readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        placeholder={readOnly ? undefined : t("bdSql.plainPlaceholder")}
        className={cn("font-mono", fillHeight && "min-h-0 flex-1 resize-none")}
        style={{
          // Dimensiones de runtime: el alto iguala al de Monaco y el tamaño de
          // letra sigue al zoom. Solo se emite por encima de 1 (el mínimo del
          // control), así que en la vista por defecto la caja conserva los
          // 16 px de `text-base` en móvil — bajarlos hace que iOS agrande la
          // página al enfocar el campo.
          ...(zoom === 1 ? {} : { fontSize: `calc(1rem * ${zoom})` }),
          ...(fillHeight ? {} : { minHeight: `${14 * zoom}rem` }),
        }}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="flex min-w-0 flex-1 items-start gap-1.5 text-2xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {[motivoDelTextoPlano, consecuenciaDelTextoPlano].filter(Boolean).join(" ")}
        </p>
        {/* Volver solo se ofrece cuando el editor DE VERDAD está disponible:
            un botón que reintenta no serviría, porque `loader.init()` devuelve
            siempre la misma promesa ya rechazada. */}
        {estadoEditor === "listo" && !readOnly && (
          <Button variant="outline" size="sm" onClick={() => setModoTexto(null)}>
            {t("bdSql.useEditor")}
          </Button>
        )}
      </div>
    </div>
  );

  const bloqueEditor = modoTexto
    ? bloqueTextoPlano
    : estadoEditor === "listo"
      ? bloqueMonaco
      : bloqueCargandoEditor;

  /* Avisos que dependen de la SELECCIÓN o de la corrida. Van con los
     resultados, DEBAJO del editor, y no en el bloque de arriba: ahí, el aviso
     de la selección aparecía en cuanto se marcaba texto, empujaba el editor
     ~25 px hacia abajo y lo achicaba, así que el arrastre del mouse terminaba en
     otra línea —una selección de punta a punta quedaba en «CR»— y al soltarla
     todo volvía a subir. Copiar y pegar se sentía roto por eso. */
  const avisosDeEjecucion = (
    <>
      {/* Primera ejecución: avisar el costo ANTES de que parezca colgado. */}
      {running && <p className="text-2xs text-muted-foreground">{t("bdSql.firstRunHint")}</p>}

      {/* Que se pueda correr un fragmento no se descubre solo: sin este aviso
          el usuario asume que el botón siempre corre la hoja entera. */}
      {!running && hasSelection && (
        <p className="text-2xs text-muted-foreground">{t("bdSql.selectionHint")}</p>
      )}

      {/* Si la selección falla por algo de más arriba, el motivo tiene que estar
          en pantalla: el contexto corre sin mostrar sus resultados. */}
      {!running && contextoFallido > 0 && (
        <p className="flex items-start gap-1.5 text-2xs text-warning-on-subtle">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {t("bdSql.contextFailed", { count: contextoFallido })}
        </p>
      )}
    </>
  );

  const bloqueResultados = (
    <>
      {avisosDeEjecucion}

      {loadError && (
        /* Que el motor no cargue NO es quedarse sin responder, y hay que
           decirlo: el SQL escrito se guarda igual y la propia directiva de
           calificación manda leerlo («si NO hay salida de ejecución… calificá
           el SQL leyéndolo — NO pongas 0 por no haber ejecutado»). Sin esta
           segunda línea, el alumno lee «no se pudo cargar el motor» y concluye
           que la pregunta se perdió. */
        <div className="space-y-1">
          <p className="flex items-start gap-1.5 text-2xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("bdSql.engineLoadError", { error: loadError })}
          </p>
          {/* En solo lectura no se persiste nada, así que hablar de que «queda
              guardado» sería inventar; y fuera de una entrega no hay calificación
              que prometer. */}
          {!readOnly && (
            <p className="text-2xs text-muted-foreground">
              {graded ? t("bdSql.engineLoadErrorKeep") : t("bdSql.engineLoadErrorKeepPlain")}
            </p>
          )}
        </div>
      )}

      {setupError && (
        <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-2xs text-warning-on-subtle">
          <strong>{t("bdSql.setupErrorTitle")}</strong> {setupError}
        </div>
      )}

      {/* Estado vacío: sin esto, debajo del editor no había NADA y no quedaba
            claro que hubiera que pulsar Ejecutar para ver algo. */}
      {results.length === 0 && !loadError && !setupError && !running && (
        <div className="space-y-1 rounded-md border border-dashed p-3 text-center text-2xs text-muted-foreground">
          <p>{t("bdSql.emptyHint")}</p>
          {/* El costo de la primera corrida, ANTES de pulsar: si solo apareciera
              durante la ejecución, la espera larga llegaría sin explicación. */}
          <p>{t("bdSql.firstRunHintIdle")}</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r, i) => (
            <div key={i} className="rounded-md border bg-muted/30 p-2">
              <p className="mb-1 text-3xs text-muted-foreground" style={zoomStyle("--text-3xs")}>
                {t("bdSql.statementN", { n: i + 1 })}
              </p>
              {/* Antes del resultado, como los imprime psql: es el orden en que
                  ocurrieron. */}
              {r.notices && r.notices.length > 0 && (
                <pre
                  className="mb-1 whitespace-pre-wrap break-words border-l-2 border-primary/50 pl-2 font-mono text-2xs"
                  style={zoomStyle("--text-2xs")}
                >
                  {r.notices.join("\n")}
                </pre>
              )}
              {r.noticesTruncated && (
                <p className="mb-1 text-3xs text-muted-foreground" style={zoomStyle("--text-3xs")}>
                  {t("bdSql.noticesTruncated", { max: MAX_NOTICES })}
                </p>
              )}
              {r.error ? (
                <p
                  className="whitespace-pre-wrap break-words font-mono text-2xs text-destructive"
                  style={zoomStyle("--text-2xs")}
                >
                  {r.error}
                </p>
              ) : r.columns.length === 0 ? (
                <p
                  className="font-mono text-2xs text-muted-foreground"
                  style={zoomStyle("--text-2xs")}
                >
                  {t("bdSql.affectedRows", { count: r.affectedRows ?? 0 })}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <pre
                    className="font-mono text-2xs leading-relaxed"
                    style={zoomStyle("--text-2xs")}
                  >
                    {renderTable(r.columns, r.rows)}
                  </pre>
                  {r.rows.length >= MAX_PERSISTED_ROWS && (
                    <p
                      className="mt-1 text-3xs text-muted-foreground"
                      style={zoomStyle("--text-3xs")}
                    >
                      {t("bdSql.truncated", { max: MAX_PERSISTED_ROWS })}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className={cn(fillHeight && "flex h-full min-h-0 flex-col", className)}>
      <div className={cn("space-y-2", fillHeight && "flex min-h-0 flex-1 flex-col")}>
        {/* Bloque FIJO: el encabezado con Ejecutar y los avisos. En modo
            herramienta es `shrink-0`, así que el botón queda a la vista por
            mucho que crezcan el guion o los resultados — antes se iba con el
            scroll y había que subir para ejecutar. */}
        <div className={cn("space-y-2", fillHeight && "shrink-0")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* El encabezado nombra la TAREA ("Consulta"), no la tecnología. Antes
              la única etiqueta era el motor ("PostgreSQL real en tu navegador"),
              así que en la hoja de la pizarra —donde arriba hay OTRO editor de
              SQL, el del esquema— no había forma de saber cuál era cuál. El dato
              del motor sigue visible debajo, que es donde importa. */}
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {queryLabel ?? t("bdSql.queryLabel")}
              <HelpHint>{t("bdSql.queryHint")}</HelpHint>
            </span>
            <div className="ml-auto flex items-center gap-1">
              {/* El control (y el motivo de que sea solo-clic) vive en
                `EditorZoomControls`, compartido con los tres editores de
                código. Va también en readOnly: quien mira la hoja
                compartida es quien más necesita agrandar la letra. */}
              <EditorZoomControls
                zoomIn={zoomIn}
                zoomOut={zoomOut}
                reset={resetZoom}
                atMin={atMin}
                atMax={atMax}
                pct={pct}
              />
              {(!readOnly || readOnlyAllowRun) && (
                <Button
                  size="sm"
                  onClick={() => void run()}
                  disabled={running || !sql.trim()}
                  // Ctrl+Enter y «correr solo la selección» son capacidades de
                  // Monaco: sin él, el botón corre la hoja entera de un clic y el
                  // rótulo ya lo dice. Un tooltip que repite el rótulo no aporta;
                  // uno que promete un atajo inexistente, miente.
                  title={modoTexto ? undefined : t("bdSql.runShortcut")}
                >
                  {running ? (
                    <Spinner size="md" className="mr-1" />
                  ) : (
                    <Play className="mr-1 h-4 w-4" />
                  )}
                  {/* Los tres rótulos ocupan la MISMA celda y el botón toma el
                      ancho del más largo: si cambiara de ancho al seleccionar,
                      en una pantalla angosta la fila saltaría a dos renglones y
                      correría el editor bajo el mouse (ver `avisosDeEjecucion`). */}
                  <span className="grid">
                    {(
                      [
                        ["running", running, t("bdSql.running")],
                        ["selection", !running && hasSelection, t("bdSql.runSelection")],
                        ["run", !running && !hasSelection, t("bdSql.run")],
                      ] as const
                    ).map(([clave, activo, rotulo]) => (
                      <span
                        key={clave}
                        aria-hidden={!activo}
                        className={cn("col-start-1 row-start-1", !activo && "invisible")}
                      >
                        {rotulo}
                      </span>
                    ))}
                  </span>
                </Button>
              )}
            </div>
          </div>

          {/* El motor y —lo que más confunde— que la base se recrea en CADA
            ejecución. Ese comportamiento estaba documentado solo en un comentario
            del código: el usuario que insertaba una fila y en la corrida siguiente
            no la encontraba no tenía NADA en pantalla que lo explicara. */}
          <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
            <Database className="mt-0.5 h-3 w-3 shrink-0" />
            {t("bdSql.engineLabel")}
          </p>

          {/* Qué contiene la base, a la vista y en un botón. En readOnly Monaco no
            acepta escritura, así que la consulta no se podría insertar ni pegar en
            ningún lado: ahí lo único que corre es la consulta fija del docente.
            Es la única superficie que EJECUTA y queda sin la ayuda; cubrirla pide
            un editor propio para el alumno, que es trabajo aparte. */}
          {!readOnly && <SqlTablesHelp onInsert={insertListTables} />}
          {/* Nada de lo que está ARRIBA del editor puede aparecer o desaparecer
              mientras se trabaja: cambiaría su alto y lo correría bajo el mouse.
              Los avisos de la selección y de la corrida van debajo, con los
              resultados (`avisosDeEjecucion`). */}
        </div>

        {/* En modo herramienta se espera la lectura del reparto antes de montar
            el grupo. Sin esa espera el primer fotograma caía en la rama apilada
            —layout equivocado a la vista y Monaco montándose dos veces— porque
            `repartoListo` todavía era falso. */}
        {fillHeight ? (
          !repartoListo ? null : (
            /* Divisor arrastrable entre el guion y los resultados. El alto de la
             caja de resultados era el problema reportado: sin tope crecía sin
             control y empujaba todo, y no había forma de darle más aire para
             leer una consulta de muchas filas. Ahora se arrastra, cada mitad
             scrollea por dentro, y `autoSaveId` recuerda el reparto — el
             docente lo acomoda una vez y no vuelve a hacerlo.

             El id es UNO para todas las hojas, no uno por hoja: la proporción
             preferida es de la persona, y por hoja obligaría a re-arrastrar
             cada vez que crea una nueva. */
            <ResizablePanelGroup
              orientation="vertical"
              {...(reparto ? { defaultLayout: reparto } : {})}
              onLayoutChanged={guardarReparto}
              className="min-h-0 flex-1"
            >
              <ResizablePanel id={PANEL_EDITOR} defaultSize={55} minSize={20} className="min-h-0">
                {bloqueEditor}
              </ResizablePanel>
              <ResizableHandle
                withHandle
                orientation="vertical"
                ariaLabel={t("bdSql.resizeSplitAria")}
              />
              <ResizablePanel id={PANEL_RESULTS} defaultSize={45} minSize={15} className="min-h-0">
                <div className="h-full space-y-2 overflow-y-auto pt-2">{bloqueResultados}</div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )
        ) : (
          <>
            {bloqueEditor}
            {bloqueResultados}
          </>
        )}
      </div>
    </div>
  );
}
