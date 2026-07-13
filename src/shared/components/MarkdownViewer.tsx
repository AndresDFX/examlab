/**
 * Full-document Markdown renderer for generated content files (guías, talleres).
 * Wider allowedElements than MarkdownInline — headings, hr, blockquote, table, etc.
 * Used in the inline preview dialogs of FilesByClassDialog and student course board.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

export function MarkdownViewer({ children }: { children: string }) {
  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none
        [&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2
        [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5
        [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
        [&_h4]:text-sm [&_h4]:font-medium [&_h4]:mt-2 [&_h4]:mb-1
        [&_p]:my-1.5 [&_p]:leading-relaxed
        [&_ul]:my-1.5 [&_ul]:pl-5 [&_ul>li]:my-0.5
        [&_ol]:my-1.5 [&_ol]:pl-5 [&_ol>li]:my-0.5
        [&_blockquote]:border-l-4 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:my-2
        [&_hr]:my-3 [&_hr]:border-border
        [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-muted [&_code]:text-foreground [&_code]:text-[0.8em]
        [&_pre]:bg-muted [&_pre]:rounded [&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre>code]:bg-transparent [&_pre>code]:p-0
        [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_table]:my-2
        [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_th]:font-medium [&_th]:text-left
        [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1"
    >
      <ReactMarkdown
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
        components={{
          // Links externos: nueva pestaña + rel seguro (paridad con MarkdownInline).
          a: ({ href, children, ...rest }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          ),
        }}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
