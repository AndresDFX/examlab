import * as React from "react";

import { cn } from "@/lib/utils";

// Same mobile-first pattern as Input: 16px on mobile (anti-zoom on iOS),
// 14px on desktop. Taller min-height on mobile for comfortable multi-line
// tapping / scrolling.
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] md:min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm touch-manipulation placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
