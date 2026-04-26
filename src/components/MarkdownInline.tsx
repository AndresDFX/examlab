/**
 * Lightweight Markdown renderer for short statements (e.g. workshop / exam
 * question content) so things like **Java** render as bold instead of
 * literal asterisks.
 *
 * We deliberately whitelist a small set of elements and keep paragraphs
 * inline-friendly by collapsing the wrapper <p> margin so it sits well
 * inside cards.
 */
import ReactMarkdown from "react-markdown";

export function MarkdownInline({ children }: { children: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap [&_p]:my-0 [&_p+p]:mt-2 [&_ul]:my-1 [&_ol]:my-1 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-muted [&_code]:text-foreground">
      <ReactMarkdown
        allowedElements={[
          "p",
          "strong",
          "em",
          "code",
          "ul",
          "ol",
          "li",
          "br",
          "del",
        ]}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
