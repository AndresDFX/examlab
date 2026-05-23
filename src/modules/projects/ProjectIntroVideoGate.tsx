/**
 * ProjectIntroVideoGate — Thin wrapper sobre `IntroVideoGate` shared.
 *
 * Antes este archivo tenía toda la implementación. Se extrajo a
 * `src/shared/components/IntroVideoGate.tsx` para reutilizarse desde
 * el flujo de talleres (mismo patrón: lista de N videos en orden
 * estricto antes de habilitar la entrega).
 *
 * Mantengo este re-export por compat con los imports existentes
 * (`@/modules/projects/ProjectIntroVideoGate`). En un refactor futuro
 * los callers pueden importar directo desde `@/shared/components/IntroVideoGate`.
 */
export {
  IntroVideoGate as ProjectIntroVideoGate,
  type IntroVideo as ProjectIntroVideo,
} from "@/shared/components/IntroVideoGate";
