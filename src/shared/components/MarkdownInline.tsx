/**
 * Renderer de Markdown para enunciados / texto corto embebido en cards
 * (preguntas de examen, taller, proyecto; mensajes de foro; tutor IA).
 *
 * Versión 2: lista de elementos permitidos AMPLIA, alineada con lo que
 * la IA realmente genera para los enunciados — headers, code blocks
 * multilínea, blockquotes, tablas (vía remark-gfm), enlaces.
 *
 * Diferencia con MarkdownViewer: spacing más compacto (`my-0` en `p`)
 * para que se vea bien dentro de cards con padding pequeño. Para
 * documentos completos (guías, talleres extensos) seguir usando
 * MarkdownViewer.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

export function MarkdownInline({ children }: { children: string }) {
  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none
        [&_p]:my-0 [&_p+p]:mt-2 [&_p]:leading-relaxed
        [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-3 [&_h1]:mb-1.5
        [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2.5 [&_h2]:mb-1
        [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
        [&_h4]:text-sm [&_h4]:font-medium [&_h4]:mt-2 [&_h4]:mb-0.5
        [&_h5]:text-sm [&_h5]:font-medium [&_h5]:mt-1.5 [&_h5]:mb-0.5
        [&_h6]:text-xs [&_h6]:font-medium [&_h6]:mt-1.5 [&_h6]:mb-0.5
        [&_ul]:my-1 [&_ul]:pl-5 [&_ul>li]:my-0.5
        [&_ol]:my-1 [&_ol]:pl-5 [&_ol>li]:my-0.5
        [&_blockquote]:border-l-4 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:my-2
        [&_hr]:my-2 [&_hr]:border-border
        [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:opacity-80
        [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-muted [&_code]:text-foreground [&_code]:text-[0.85em]
        [&_pre]:bg-muted [&_pre]:rounded [&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre>code]:bg-transparent [&_pre>code]:p-0 [&_pre>code]:text-xs
        [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_table]:my-2
        [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_th]:font-medium [&_th]:text-left
        [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1"
    >
      <ReactMarkdown
        // gfm: tablas, strikethrough, autolinks, task lists.
        // breaks: salto de línea simple del textarea → <br> (los docentes
        // escriben con Enter normal y esperan ver el salto; sin esto,
        // markdown colapsaría newlines simples a espacio).
        remarkPlugins={[remarkGfm, remarkBreaks]}
        allowedElements={[
          "h1", "h2", "h3", "h4", "h5", "h6",
          "p", "strong", "em", "del", "br",
          "ul", "ol", "li",
          "blockquote", "hr",
          "code", "pre",
          "table", "thead", "tbody", "tr", "th", "td",
          "a",
        ]}
        unwrapDisallowed
        components={{
          // Links externos: target="_blank" + rel seguro
          a: ({ href, children, ...rest }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...rest}
            >
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
