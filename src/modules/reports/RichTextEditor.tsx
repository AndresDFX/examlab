/**
 * RichTextEditor — editor VISUAL (WYSIWYG) ligero para el cuerpo de los
 * informes, sin dependencias nuevas (contentEditable + document.execCommand).
 *
 * Por qué: el editor de plantillas era un textarea de HTML crudo —"editar
 * desde código"— y el texto se veía apretado. Los docentes quieren escribir
 * el informe como en Word (negrita, títulos, listas) sin tocar HTML. Este
 * editor renderiza el `body_html` y lo edita en vivo; emite el HTML
 * resultante al padre. El tab "HTML" sigue disponible para casos avanzados
 * (bloques {{#each}}/{{#if}} que no se pueden tipear visualmente).
 *
 * execCommand está deprecado pero sigue funcionando en todos los navegadores
 * modernos (Chrome/Edge/Firefox/Safari) y es la vía sin-librería para un
 * editor básico. Para insertar variables del catálogo se expone `insertText`
 * vía ref (inserta el `{{placeholder}}` como texto en el cursor).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Pilcrow,
  Underline as UnderlineIcon,
  Eraser,
} from "lucide-react";

export interface RichTextEditorHandle {
  /** Inserta texto plano (ej. un `{{placeholder}}`) en la posición del cursor. */
  insertText(text: string): void;
}

interface Props {
  value: string;
  onChange: (html: string) => void;
  className?: string;
  placeholder?: string;
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { value, onChange, className, placeholder },
  ref,
) {
  const { t } = useTranslation();
  const elRef = useRef<HTMLDivElement>(null);
  // Última selección dentro del editor — para que el insert del catálogo
  // (que ocurre tras hacer click en el sidebar y perder el foco del editor)
  // caiga donde el docente estaba escribiendo.
  const lastRange = useRef<Range | null>(null);

  // Sincroniza el innerHTML cuando `value` cambia DESDE AFUERA (importar un
  // .docx, generar con IA, insertar variable). El guard `!== value` evita
  // re-escribir mientras el docente tipea (eso movería el cursor al inicio).
  useEffect(() => {
    const el = elRef.current;
    if (el && el.innerHTML !== value) el.innerHTML = value || "";
  }, [value]);

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && elRef.current?.contains(sel.anchorNode)) {
      lastRange.current = sel.getRangeAt(0).cloneRange();
    }
  };

  const emit = () => onChange(elRef.current?.innerHTML ?? "");

  const exec = (cmd: string, arg?: string) => {
    const el = elRef.current;
    if (!el) return;
    el.focus();
    // Restaurar la selección guardada si el foco se había perdido.
    if (lastRange.current) {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(lastRange.current);
      }
    }
    document.execCommand(cmd, false, arg);
    saveSelection();
    emit();
  };

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      const el = elRef.current;
      if (!el) return;
      el.focus();
      if (lastRange.current) {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(lastRange.current);
        }
      }
      document.execCommand("insertText", false, text);
      saveSelection();
      emit();
    },
  }));

  const ToolbarBtn = ({
    icon: Icon,
    label,
    onClick,
  }: {
    icon: typeof Bold;
    label: string;
    onClick: () => void;
  }) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0"
      title={label}
      aria-label={label}
      // onMouseDown + preventDefault para NO perder la selección del editor
      // al clickear el botón de la toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );

  return (
    <div className={cn("rounded-md border", className)}>
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 px-1 py-1">
        <ToolbarBtn icon={Bold} label={t("hc_modulesReportsRichTextEditor.bold")} onClick={() => exec("bold")} />
        <ToolbarBtn icon={Italic} label={t("hc_modulesReportsRichTextEditor.italic")} onClick={() => exec("italic")} />
        <ToolbarBtn icon={UnderlineIcon} label={t("hc_modulesReportsRichTextEditor.underline")} onClick={() => exec("underline")} />
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolbarBtn icon={Heading1} label={t("hc_modulesReportsRichTextEditor.heading1")} onClick={() => exec("formatBlock", "h1")} />
        <ToolbarBtn icon={Heading2} label={t("hc_modulesReportsRichTextEditor.heading2")} onClick={() => exec("formatBlock", "h2")} />
        <ToolbarBtn icon={Heading3} label={t("hc_modulesReportsRichTextEditor.heading3")} onClick={() => exec("formatBlock", "h3")} />
        <ToolbarBtn icon={Pilcrow} label={t("hc_modulesReportsRichTextEditor.paragraph")} onClick={() => exec("formatBlock", "p")} />
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolbarBtn icon={List} label={t("hc_modulesReportsRichTextEditor.bulletList")} onClick={() => exec("insertUnorderedList")} />
        <ToolbarBtn icon={ListOrdered} label={t("hc_modulesReportsRichTextEditor.numberedList")} onClick={() => exec("insertOrderedList")} />
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolbarBtn icon={Eraser} label={t("hc_modulesReportsRichTextEditor.clearFormat")} onClick={() => exec("removeFormat")} />
      </div>
      <div
        ref={elRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={() => {
          saveSelection();
          emit();
        }}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        className={cn(
          "min-h-[400px] max-h-[60dvh] overflow-y-auto p-3 text-sm outline-none",
          // Espaciado tipo documento (el reporte real lo hereda del CSS de
          // impresión; acá damos un default legible para que NO se vea apretado).
          "[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-2",
          "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5",
          "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1",
          "[&_p]:my-2 [&_p]:leading-relaxed",
          "[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-2",
          "[&_li]:my-0.5",
          "[&_table]:border-collapse [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:p-1.5",
          "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground",
        )}
      />
    </div>
  );
});
