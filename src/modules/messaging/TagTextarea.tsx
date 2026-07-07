/**
 * TagTextarea — textarea controlado con etiquetado de contenido, donde el
 * id del tag NUNCA es visible para el usuario.
 *
 * Modelo: el `value` que recibe/emite es el body TOKENIZADO
 * (`texto [[T:type:id:label]] ...`), que es lo que se guarda y se manda
 * (búsqueda full-text + render de chips en el bubble). PERO la UI separa
 * ese body en dos:
 *   - el `<textarea>` muestra SOLO el texto libre (sin tokens),
 *   - los tags se muestran como CHIPS removibles (`#Label`, sin id ni
 *     brackets) debajo.
 * Al editar el texto o agregar/quitar chips, recomponemos el body
 * tokenizado (tags al final) y lo emitimos por `onChange`. Así el `<textarea>`
 * jamás muestra `[[T:...id...]]`.
 *
 * El usuario agrega tags escribiendo `#texto` (autocomplete inline) o desde
 * el picker por tabs del padre (que anexa el token al `value`; acá lo
 * parseamos a chip). La detección del `#` vive en `findActiveTagQuery`.
 *
 * Nota de diseño: los tags se normalizan SIEMPRE al final del body. Es una
 * simplificación deliberada — evita el problema de mantener posiciones de
 * chips dentro de un `<textarea>` plano (que solo renderiza texto). El
 * orden relativo de los tags se preserva.
 */
import { useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/shared/lib/utils";
import { Hammer, FileText, FolderKanban, X } from "lucide-react";
import {
  buildTagToken,
  findActiveTagQuery,
  parseMessageBody,
  TAG_TYPE_LABEL,
  type ContentTag,
  type TagType,
} from "./message-tags";

const TYPE_ICON: Record<TagType, typeof Hammer> = {
  workshop: Hammer,
  exam: FileText,
  project: FolderKanban,
  content: FileText,
  video: FileText,
};

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
  maxLength?: number;
  /** Se llama en Enter SIN modificadores y CON el dropdown cerrado, o en
   *  Ctrl/Cmd+Enter siempre. Úsalo para "enviar". */
  onSubmit?: () => void;
  /** Enter "limpio" envía. Default false → solo Ctrl/Cmd+Enter. */
  submitOnEnter?: boolean;
}

/** Separa el body tokenizado en texto libre (sin tokens, sin el espacio
 *  separador final) + lista de tags en orden. */
function splitBody(value: string): { text: string; tags: ContentTag[] } {
  const segs = parseMessageBody(value);
  let text = "";
  const tags: ContentTag[] = [];
  for (const s of segs) {
    if (s.kind === "text") text += s.text;
    else tags.push(s.tag);
  }
  // Si hay tags, quitamos el/los espacios separadores finales que quedaron
  // entre el texto y el primer token — así el textarea no muestra un
  // espacio fantasma y el caret no salta.
  if (tags.length > 0) text = text.replace(/[ \t]+$/, "");
  return { text, tags };
}

/** Recompone el body tokenizado: texto libre + tags (al final). */
function composeBody(text: string, tags: ContentTag[]): string {
  const tokens = tags.map(buildTagToken).join(" ");
  if (!tokens) return text;
  return text.length ? `${text} ${tokens}` : tokens;
}

export function TagTextarea({
  value,
  onChange,
  placeholder,
  disabled,
  rows = 2,
  className,
  maxLength,
  onSubmit,
  submitOnEnter = false,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [tagQuery, setTagQuery] = useState<{ query: string; start: number } | null>(null);
  const [taggable, setTaggable] = useState<ContentTag[] | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  // Derivamos texto libre + chips del `value` tokenizado en cada render.
  const { text, tags } = useMemo(() => splitBody(value), [value]);

  const loadTaggable = async () => {
    if (taggable !== null) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = supabase as any;
    const [ws, ex, pj] = await Promise.all([
      dbAny.from("workshops").select("id, title").is("deleted_at", null).order("title").limit(200),
      dbAny.from("exams").select("id, title").is("deleted_at", null).order("title").limit(200),
      dbAny.from("projects").select("id, title").is("deleted_at", null).order("title").limit(200),
    ]);
    const out: ContentTag[] = [];
    const noTitle = t("hc_modulesMessagingTagTextarea.noTitle", { defaultValue: "(sin título)" });
    for (const r of (ws.data ?? []) as Array<{ id: string; title: string | null }>)
      out.push({ type: "workshop", id: String(r.id), label: String(r.title ?? noTitle) });
    for (const r of (ex.data ?? []) as Array<{ id: string; title: string | null }>)
      out.push({ type: "exam", id: String(r.id), label: String(r.title ?? noTitle) });
    for (const r of (pj.data ?? []) as Array<{ id: string; title: string | null }>)
      out.push({ type: "project", id: String(r.id), label: String(r.title ?? noTitle) });
    setTaggable(out);
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    // El textarea solo edita el texto libre; los tags actuales se
    // re-anexan al recomponer el body.
    onChange(composeBody(newText, tags));
    const caret = e.target.selectionStart ?? newText.length;
    const q = findActiveTagQuery(newText, caret);
    setTagQuery(q);
    setActiveIdx(0);
    if (q) void loadTaggable();
  };

  const matches = useMemo(() => {
    if (!tagQuery || !taggable) return [];
    const q = tagQuery.query.trim().toLowerCase();
    const base = q ? taggable.filter((t) => t.label.toLowerCase().includes(q)) : taggable;
    return base.slice(0, 8);
  }, [tagQuery, taggable]);

  const dropdownOpen = !!tagQuery && matches.length > 0;

  const applyTag = (tag: ContentTag) => {
    if (!tagQuery) return;
    // Quitamos el `#query` del texto libre y agregamos el tag como chip.
    const before = text.slice(0, tagQuery.start);
    const after = text.slice(tagQuery.start + 1 + tagQuery.query.length);
    const newText = `${before}${after}`;
    onChange(composeBody(newText, [...tags, tag]));
    setTagQuery(null);
    setActiveIdx(0);
    setTimeout(() => ref.current?.focus(), 0);
  };

  const removeTag = (idx: number) => {
    onChange(
      composeBody(
        text,
        tags.filter((_, i) => i !== idx),
      ),
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (dropdownOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const sel = matches[activeIdx];
        if (sel) applyTag(sel);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTagQuery(null);
        return;
      }
    }
    if (e.key === "Enter") {
      const wantSubmit = submitOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey;
      if (wantSubmit && onSubmit) {
        e.preventDefault();
        onSubmit();
      }
    }
  };

  return (
    <div className="relative flex-1">
      {dropdownOpen && (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-20 rounded-md border bg-popover shadow-md overflow-hidden">
          <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground border-b">
            {t("hc_modulesMessagingTagTextarea.taggerHint", {
              defaultValue: "Etiquetar contenido — Enter para insertar",
            })}
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {matches.map((tg, idx) => {
              const TagIcon = TYPE_ICON[tg.type];
              return (
                <li key={`${tg.type}:${tg.id}`}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      // onMouseDown (no onClick) para que el blur del
                      // textarea no cierre el dropdown antes de aplicar.
                      e.preventDefault();
                      applyTag(tg);
                    }}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={cn(
                      "w-full text-left px-2.5 py-1.5 text-sm flex items-center gap-2",
                      idx === activeIdx ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <TagIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{tg.label}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {TAG_TYPE_LABEL[tg.type]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <Textarea
        ref={ref}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        maxLength={maxLength}
        className={className}
      />
      {/* Chips removibles de los tags — muestran SOLO `#Label` (sin id). */}
      {tags.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {tags.map((tag, i) => {
            const TagIcon = TYPE_ICON[tag.type];
            return (
              <span
                key={`${tag.type}:${tag.id}:${i}`}
                className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
              >
                <TagIcon className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[160px]">{tag.label}</span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => removeTag(i)}
                    className="ml-0.5 rounded-full hover:bg-primary/20"
                    aria-label={`Quitar etiqueta ${tag.label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
