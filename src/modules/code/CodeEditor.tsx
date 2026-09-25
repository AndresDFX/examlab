import { useCallback, useRef, useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Editor, { type OnMount } from "@monaco-editor/react";
import { CharacterBar } from "@/components/ui/character-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Play, Terminal, Info, X, Maximize2, Minimize2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { RowAction } from "@/components/ui/row-action";
import { useEditorZoom } from "@/hooks/use-editor-zoom";
import { useVentana } from "@/hooks/use-ventana";
import { EditorZoomControls } from "./EditorZoomControls";
import { escalarAltoEditor } from "./editor-zoom";
import {
  altoDeEditorEnPantalla,
  esPantallaAngosta,
  opcionesBaseDeEditor,
  OPCIONES_EN_PANTALLA_ANGOSTA,
} from "./editor-opciones";
import {
  LANGUAGE_LABEL,
  MONACO_LANGUAGE,
  UI_EXECUTABLE_LANGUAGES,
  type CodeLanguage,
} from "./language-support";

// El tipo y la lista de lenguajes vienen del MAPEO OFICIAL
// (`language-support.ts`), que es lo que también consume el edge. Se re-exporta
// `CodeLanguage` porque varios módulos ya lo importaban desde acá; así no hay
// dos definiciones que puedan divergir.
export type { CodeLanguage };

// Las plantillas y `getStarterCode` viven en `./starters` (módulo PURO): el
// predicado de "pregunta respondida" las necesita y no puede arrastrar Monaco.
// Se re-exportan para no romper los imports que ya apuntaban acá.
export { JAVA_STARTER, getStarterCode } from "./starters";
import {
  JAVA_STARTER,
  PYTHON_STARTER,
  JAVASCRIPT_STARTER,
  KOTLIN_STARTER,
} from "./starters";


interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeLanguage;
  onLanguageChange?: (lang: CodeLanguage) => void;
  onRun?: () => void;
  /** Si se provee + `isRunning=true`, aparece un botón "Cancelar" al
   *  lado del de Ejecutar. Útil cuando el estudiante quiere cambiar de
   *  compilador (ej. CheerpJ se quedó pegado descargando tools.jar) sin
   *  esperar a que termine el run actual. La cancelación no necesariamente
   *  mata el worker remoto (especialmente CheerpJ no expone API de kill),
   *  pero libera la UI inmediatamente para que el alumno pueda reintentar
   *  con otro provider. */
  onCancel?: () => void;
  output?: string;
  isRunning?: boolean;
  readOnly?: boolean;
  height?: string;
  showLanguageSelector?: boolean;
  showRunButton?: boolean;
  /**
   * Caracteres que el alumno puede insertar con un toque (`ñ`, `;`, `<`…).
   * Ver `@/modules/exams/caracteres-especiales`: el examen bloquea el
   * portapapeles, así que un teclado sin la tecla dejaba al estudiante
   * buscando el carácter en otra ventana para copiarlo — justo lo que el
   * proctoring le marca como intento de trampa. Se inserta por la API del
   * editor, nunca por el portapapeles.
   */
  caracteresRapidos?: readonly string[];
  /**
   * Bloquea silenciosamente copiar/pegar/cortar dentro del editor.
   * Usado en el flujo de examen — Monaco intercepta los atajos antes
   * que el listener de documento, así que hay que deshabilitarlos
   * a nivel del editor o se cuela el paste.
   */
  blockClipboard?: boolean;
  /** Esconde tips informativos (ej. el banner de Java cold-start).
   *  Útil para vistas read-only de revisión donde el banner sobra. */
  hideHints?: boolean;
  /** Identidad estable de ESTA pregunta/superficie para que el zoom quede
   *  guardado solo acá — ver `useEditorZoom`. Sin esto, cae en la preferencia
   *  compartida de siempre. */
  zoomScopeKey?: string | null;
  /**
   * Lo que NO puede desaparecer cuando el editor se amplía. Se dibuja arriba
   * del todo y SOLO en modo ampliado.
   *
   * Existe por un caso concreto: el editor ampliado es un `fixed inset-0`, así
   * que tapa el encabezado de la pantalla de examen — y ahí vive el RELOJ. Un
   * alumno que amplía para escribir código y deja de ver cuánto le queda es un
   * problema peor que el que el modo ampliado resuelve.
   */
  barraSuperior?: ReactNode;
}

const LANGUAGE_CONFIG: Partial<Record<
  CodeLanguage,
  { label: string; monacoLang: string; defaultCode: string }
>> = {
  java: {
    label: "Java",
    monacoLang: "java",
    defaultCode: JAVA_STARTER,
  },
  python: {
    label: "Python",
    monacoLang: "python",
    defaultCode: PYTHON_STARTER,
  },
  javascript: {
    label: "JavaScript",
    monacoLang: "javascript",
    defaultCode: JAVASCRIPT_STARTER,
  },
  kotlin: {
    label: "Kotlin",
    monacoLang: "kotlin",
    defaultCode: KOTLIN_STARTER,
  },
};

export function CodeEditor({
  value,
  onChange,
  language = "java",
  onLanguageChange,
  onRun,
  onCancel,
  output,
  isRunning = false,
  readOnly = false,
  height = "300px",
  showLanguageSelector = true,
  showRunButton = true,
  caracteresRapidos,
  blockClipboard = false,
  hideHints = false,
  zoomScopeKey = null,
  barraSuperior,
}: CodeEditorProps) {
  const { t } = useTranslation();
  const editorRef = useRef<any>(null);

  /**
   * Inserta en la POSICIÓN DEL CURSOR con la API del editor, no concatenando
   * al final del `value`: en un archivo de 30 líneas, un `;` que aterriza al
   * final no sirve de nada. `executeEdits` además deja el paso en la pila de
   * deshacer, así que Ctrl+Z lo revierte como cualquier otra escritura.
   */
  const insertarCaracterEnCursor = (caracter: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelection();
    if (!sel) return;
    ed.executeEdits("barra-caracteres", [{ range: sel, text: caracter, forceMoveMarkers: true }]);
    // El foco vuelve al editor para que pueda seguir escribiendo sin tocar la
    // pantalla otra vez.
    ed.focus();
  };

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      if (blockClipboard) {
        // 1) Atajos de teclado: anula la acción a nivel de Monaco.
        const noop = () => {};
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, noop);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, noop);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, noop);
        editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Insert, noop);
        // 2) Red de seguridad: si algo se cuela (clic derecho → Pegar,
        //    drag-drop, menú Edit del browser), undo inmediato. La
        //    inserción ocurre y se revierte en el mismo tick — el
        //    estudiante no logra dejarlo en el editor.
        editor.onDidPaste(() => {
          editor.trigger("anti-paste", "undo", null);
        });
      }
    },
    [blockClipboard],
  );

  // Fallback a Java si el q.language guardado no está en
  // LANGUAGE_CONFIG (p. ej. valor heredado de migraciones, "html",
  // null o un typo). Sin esto config queda undefined y el render
  // crashea con "Cannot read properties of undefined (reading 'label')".
  const config =
    LANGUAGE_CONFIG[language as keyof typeof LANGUAGE_CONFIG] ??
    (LANGUAGE_LABEL[language as keyof typeof LANGUAGE_LABEL]
      ? {
          label: LANGUAGE_LABEL[language as keyof typeof LANGUAGE_LABEL],
          monacoLang: MONACO_LANGUAGE[language as keyof typeof MONACO_LANGUAGE],
          defaultCode: "",
        }
      : LANGUAGE_CONFIG.java!);

  // Reactive dark mode detection
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Zoom del editor. Compartido con la hoja de SQL y con los editores de
  // Java/Python con interfaz gráfica: una sola preferencia por persona.
  const { zoom, zoomIn, zoomOut, reset: resetZoom, atMin, atMax, pct } = useEditorZoom(zoomScopeKey);

  // En un teléfono el editor recorta la decoración de Monaco y crece a la mitad
  // de la pantalla — ver `editor-opciones.ts`.
  const ventana = useVentana();
  const angosta = esPantallaAngosta(ventana);

  /**
   * Modo AMPLIADO: el editor ocupa la pantalla entera.
   *
   * ── Por qué hace falta, y por qué no alcanzaba con achicar la decoración ──
   * Medido en la pantalla real de examen a 390 px: al código le quedan 292 px,
   * porque entre el shell (`px-4`), el relleno de la tarjeta (`p-5`) y los
   * bordes se van 74 px — el 19 % del ancho. Con fuente monoespaciada de 13 px
   * eso son ~30 caracteres por renglón, así que UNA instrucción normal
   * (`ArrayList<HashMap<String, Object>> personas = new ArrayList<>();`) se
   * parte en tres. No es un problema de tamaño de letra: es que la pantalla se
   * comprime en vez de reorganizarse.
   *
   * ── Por qué es un overlay y NO la Fullscreen API ─────────────────────
   * Aunque el design system ya tiene `useFullscreen`/`FullscreenButton`, acá no
   * sirven, por dos motivos independientes:
   *   · En un EXAMEN la pantalla ya está en pantalla completa y el proctoring
   *     cuenta `fullscreenchange` como advertencia. Pedir pantalla completa para
   *     un elemento de adentro saca de la del examen y le cobra un strike al
   *     alumno por ampliar su propio editor.
   *   · En iPhone la pantalla completa de ELEMENTOS no existe, y ese es
   *     justamente el dispositivo donde esto hace falta. La regla del design
   *     system dice que ahí no se renderice el botón — o sea, no habría botón
   *     donde más se necesita.
   * Un contenedor `fixed inset-0` no toca nada de eso: no hay evento de
   * pantalla completa, no hay strike, y funciona igual en iOS.
   *
   * Monaco se reacomoda solo (`automaticLayout`), así que no hay que avisarle.
   */
  const [ampliado, setAmpliado] = useState(false);

  // Con el editor ampliado, el fondo no debe poder desplazarse detrás.
  useEffect(() => {
    if (!ampliado) return;
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previo;
    };
  }, [ampliado]);

  return (
    <div
      className={
        ampliado
          ? // `dvh` y no `vh`: en iOS la barra de direcciones se lleva ~80 px y
            // con `vh` el panel de salida queda cortado abajo.
            "fixed inset-0 z-50 flex flex-col gap-2 bg-background p-2 pt-[max(env(safe-area-inset-top),0.5rem)] pb-[max(env(safe-area-inset-bottom),0.5rem)] h-[100dvh]"
          : "space-y-2"
      }
    >
      {ampliado && barraSuperior && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{barraSuperior}</div>
      )}
      {/* La barra ENVUELVE. A 320 px el selector, el zoom (tres botones de 44 px
          en táctil) y «Ejecutar» suman más que el ancho disponible, y sin
          envolver empujaban la página entera a scroll horizontal. */}
      <div className="flex flex-wrap items-center gap-2">
        {showLanguageSelector && onLanguageChange && (
          <Select value={language} onValueChange={(v) => onLanguageChange(v as CodeLanguage)}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_EXECUTABLE_LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {LANGUAGE_LABEL[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {!showLanguageSelector && (
          <Badge variant="outline" className="text-xs">
            {config.label}
          </Badge>
        )}
        {/* El zoom y «Ejecutar» viajan JUNTOS: si envuelven por separado,
            «Ejecutar» cae solo a la izquierda de la segunda línea mientras el
            zoom queda a la derecha de la primera. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {/* El zoom va SIEMPRE, aunque el editor sea de solo lectura o no
              tenga botón de Ejecutar: en la revisión de una entrega es cuando
              más falta hace poder agrandar la letra. */}
          <EditorZoomControls
            zoomIn={zoomIn}
            zoomOut={zoomOut}
            reset={resetZoom}
            atMin={atMin}
            atMax={atMax}
            pct={pct}
          />
          {/* Ampliar va al lado del zoom porque resuelven lo mismo —ver el
              código más grande— y así envuelven juntos en una pantalla angosta. */}
          <RowAction
            label={ampliado ? t("codeEditor.restore") : t("codeEditor.expand")}
            icon={ampliado ? Minimize2 : Maximize2}
            variant="outline"
            onClick={() => setAmpliado((v) => !v)}
          />
          {showRunButton && onRun && (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={onRun}
                disabled={isRunning}
                className="h-8 text-xs"
              >
                {isRunning ? (
                  <Spinner size="xs" className="mr-1" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                {t("codeEditor.runButton")}
              </Button>
              {/* Cancelar visible solo mientras hay un run en curso. Si
                  el caller no pasó onCancel, no lo mostramos — algunos
                  callers (review read-only, etc.) no implementan cancel. */}
              {isRunning && onCancel && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onCancel}
                  className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                  title={t("codeEditor.cancelTitle")}
                >
                  <X className="h-3 w-3 mr-1" />
                  {t("codeEditor.cancelButton")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {language === "java" && !hideHints && (
        <div className="flex items-start gap-1.5 text-2xs text-muted-foreground bg-muted/30 border rounded-md px-2.5 py-1.5">
          <Info className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
          <span>
            {t("codeEditor.javaHint")}
          </span>
        </div>
      )}

      <div
        className={
          ampliado
            ? "flex-1 min-h-0 overflow-hidden rounded-md border"
            : "rounded-md border overflow-hidden"
        }
      >
        <Editor
          // Ampliado el alto lo manda el contenedor (`flex-1`), no el caller:
          // el sentido del modo es usar TODA la pantalla.
          height={
            ampliado
              ? "100%"
              : escalarAltoEditor(altoDeEditorEnPantalla(height, ventana), zoom)
          }
          language={config.monacoLang}
          value={value}
          onChange={(v) => onChange(v ?? "")}
          onMount={handleMount}
          theme={isDark ? "vs-dark" : "vs"}
          options={{
            ...opcionesBaseDeEditor({ zoom, readOnly }),
            ...(angosta ? OPCIONES_EN_PANTALLA_ANGOSTA : {}),
          }}
        />
      </div>

      {caracteresRapidos && caracteresRapidos.length > 0 && !readOnly ? (
        <CharacterBar
          characters={caracteresRapidos}
          onInsert={insertarCaracterEnCursor}
          label={t("codeEditor.quickChars")}
          className={ampliado ? "shrink-0" : undefined}
        />
      ) : null}

      {output !== undefined && (
        <Card className={ampliado ? "shrink-0 bg-muted/50" : "bg-muted/50"}>
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Terminal className="h-3 w-3" /> {t("codeEditor.outputTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            <pre className="text-xs font-mono whitespace-pre-wrap max-h-40 overflow-auto">
              {output || t("codeEditor.outputEmpty")}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
