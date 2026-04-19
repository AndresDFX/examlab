import { createContext, useContext } from "react";
import type { AppRole } from "@/hooks/use-auth";

export const ActiveRoleContext = createContext<AppRole | null>(null);

export function useActiveRole(): AppRole | null {
  return useContext(ActiveRoleContext);
}
