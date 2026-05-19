import * as React from "react";

import { cn } from "@/shared/lib/utils";

// Mobile-first height: 44px on touch devices (hit-area compliant), 36px on
// desktop. `text-base` (16px) on mobile prevents iOS auto-zoom on focus;
// downscales to 14px on md+. `touch-manipulation` removes the 300ms delay.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 md:h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors touch-manipulation file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
