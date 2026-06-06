/**
 * OnboardingTour — wrapper de driver.js para mostrar el tour guiado
 * del rol actual.
 *
 * Recibe el rol y dispara el tour correspondiente. Al terminar (Skip,
 * Finalizar, X o ESC) llama a `onComplete(role)` para que el hook
 * marque el tour como visto en DB. Si el usuario lo cierra ANTES de
 * llegar al final (modo manual desde el botón "Ver tour"), llamamos
 * a `onDismiss()` que solo cierra sin marcar.
 *
 * Customización CSS: el design system de ExamLab usa Tailwind v4 con
 * tokens OKLCH. Sobrescribimos las CSS vars de driver.js para que el
 * popover use los mismos colores (primary, foreground, etc.) y se vea
 * coherente con el resto de la app.
 */
import { useEffect, useRef } from "react";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
// Overrides del design system (debe importarse DESPUÉS de driver.css
// para que las reglas tengan precedencia en cascada).
import "./onboarding-tour.css";
import { useRouter } from "@tanstack/react-router";
import { getTourForRole, getTourMetaForRole, type TourStep } from "./tour-config";

interface Props {
  /** Rol cuyo tour se muestra. Si null, no se monta nada. */
  role: "Admin" | "Docente" | "Estudiante" | null;
  /** Llamado cuando el tour termina (Skip, Finalizar). Marca el rol
   *  como completado en DB. */
  onComplete: (role: "Admin" | "Docente" | "Estudiante") => void;
  /** Llamado cuando el usuario cierra el tour SIN completarlo (X o ESC).
   *  En modo automático (primer login) lo tratamos igual que onComplete
   *  para no fastidiar. En modo manual, solo cierra. */
  onDismiss: () => void;
  /** Si true, cerrar SIN marcar como visto (modo manual "Ver tour de
   *  nuevo"). Default false → cerrar = marcar como visto. */
  manualMode?: boolean;
}

export function OnboardingTour({ role, onComplete, onDismiss, manualMode = false }: Props) {
  const driverRef = useRef<Driver | null>(null);
  const router = useRouter();
  // Guardamos role + callbacks + router en refs para que el effect de
  // instanciar driver.js NO re-corra cuando cambian. Solo arranca/destruye
  // al cambiar el `role`.
  const onCompleteRef = useRef(onComplete);
  const onDismissRef = useRef(onDismiss);
  const manualRef = useRef(manualMode);
  const routerRef = useRef(router);
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onDismissRef.current = onDismiss;
    manualRef.current = manualMode;
    routerRef.current = router;
  });

  useEffect(() => {
    if (!role) return;
    const steps = getTourForRole(role);
    if (steps.length === 0) return;
    const meta = getTourMetaForRole(role);

    // Filtrar pasos cuyo elemento no exista en el DOM. driver.js
    // intenta avanzar si no encuentra el selector, pero preferimos
    // saltarlos limpiamente para no dejar steps "ciegos".
    const validSteps: TourStep[] = steps.filter((s) => {
      try {
        return document.querySelector(s.element) !== null;
      } catch {
        return false;
      }
    });
    if (validSteps.length === 0) return;

    // Si el rol tiene un video introductorio configurado (HeyGen output),
    // injectamos un anchor HTML en la descripción del PRIMER step con
    // estilo de botón. driver.js renderiza el `description` como HTML,
    // así que aprovechamos para añadir el CTA "Ver video introductorio".
    // Target="_blank" + rel para abrir en pestaña nueva sin perder el
    // tour. El usuario puede continuar el tour en la pestaña original.
    if (meta.videoUrl && validSteps.length > 0) {
      const escapedUrl = meta.videoUrl
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      const videoButton = `<p style="margin-top:0.75rem"><a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:0.375rem;padding:0.375rem 0.75rem;background:var(--primary);color:var(--primary-foreground);border-radius:0.375rem;text-decoration:none;font-weight:500;font-size:0.875rem">▶ Ver video introductorio (1 min)</a></p>`;
      validSteps[0] = {
        ...validSteps[0],
        description: validSteps[0].description + videoButton,
      };
    }

    const driverObj = driver({
      showProgress: true,
      showButtons: ["next", "previous", "close"],
      // Texto de los botones en español. driver.js los expone via prop.
      nextBtnText: "Siguiente →",
      prevBtnText: "← Anterior",
      doneBtnText: "Finalizar",
      progressText: "{{current}} de {{total}}",
      // Overlay y animación.
      overlayOpacity: 0.6,
      animate: true,
      // No permitir click fuera del popover para no cerrar accidentalmente.
      allowClose: true,
      smoothScroll: true,
      // Click fuera del popover NO debe cerrar — ya hay X y "Saltar".
      overlayClickBehavior: "nextStep",
      // Inyectamos un botón "Saltar tour" al final del footer del popover.
      // driver.js NO trae un botón explícito de skip; solo el X minimal en
      // la esquina, que el usuario suele no notar. Para tours largos (15+
      // pasos), perder al usuario por no saber cómo cerrar es UX pobre.
      // El render se ejecuta DESPUÉS de que driver.js crea el footer, así
      // que solo agregamos el botón si todavía no existe (evita duplicar
      // al re-renderear). Llama a driver.destroy() → dispara onDestroyed
      // → marca el tour como visto (igual que el X o terminar).
      onPopoverRender: (popover) => {
        if (popover.footer.querySelector("[data-tour-skip]")) return;
        const skipBtn = document.createElement("button");
        skipBtn.type = "button";
        skipBtn.dataset.tourSkip = "true";
        skipBtn.textContent = "Saltar tour";
        // Clase propia (`.driver-tour-skip-btn`, estilada en
        // onboarding-tour.css) — look ghost/muted distinto al primary
        // de "Siguiente", para no competir como CTA. Posición a la
        // izquierda del footer (marginRight:auto separa del grupo
        // progress + nav que queda a la derecha).
        skipBtn.className = "driver-tour-skip-btn";
        skipBtn.style.marginRight = "auto";
        skipBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          driverObj.destroy();
        });
        // Insertamos al principio del footer (queda alineado a la
        // izquierda gracias a marginRight: auto). El footer típico tiene
        // progress + prev + next, así que el skip queda separado.
        popover.footer.insertBefore(skipBtn, popover.footer.firstChild);
      },
      // Cada step puede declarar `route` para que el tour navegue al
      // módulo correspondiente ANTES de mostrar el popover. UX: el
      // usuario ve simultáneamente el item del sidebar resaltado Y el
      // contenido del módulo cargado. Sin esto, el tour solo recorría
      // el sidebar y nunca "entraba" a las pantallas.
      //
      // Implementación: cada step lleva su propio `onHighlightStarted`.
      // driver.js lo invoca antes de pintar el popover/highlight. Si la
      // ruta actual ya coincide, no navegamos (evita flicker en steps
      // anclados a la misma ruta que el anterior).
      steps: validSteps.map((s) => ({
        element: s.element,
        ...(s.route
          ? {
              onHighlightStarted: () => {
                const wanted = s.route!;
                const current =
                  typeof window !== "undefined" ? window.location.pathname : "";
                if (current === wanted) return;
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  void (routerRef.current as any).navigate({ to: wanted });
                } catch (err) {
                  // Si la ruta no existe en el router, no rompemos el
                  // tour — solo logueamos a consola y seguimos.
                  console.warn(`[tour] no se pudo navegar a ${wanted}`, err);
                }
              },
            }
          : {}),
        popover: {
          title: s.title,
          description: s.description,
          side: s.side ?? "right",
          align: s.align ?? "center",
        },
      })),
      // onDestroyed se dispara cuando el tour termina o el usuario cierra
      // (X, ESC, o el botón "Saltar tour" inyectado en onPopoverRender).
      onDestroyed: () => {
        // Si el tour llegó al final naturalmente O el usuario hizo X
        // → marcamos como visto, excepto en modo manual.
        if (manualRef.current) {
          onDismissRef.current();
        } else if (role) {
          onCompleteRef.current(role);
        }
      },
    });

    driverRef.current = driverObj;
    // Pequeño delay para que el DOM termine cualquier animación de
    // entrada del sidebar antes de calcular posiciones.
    const startTimer = setTimeout(() => {
      driverObj.drive();
    }, 100);

    return () => {
      clearTimeout(startTimer);
      try {
        driverObj.destroy();
      } catch {
        // driver.js a veces tira al destruir si ya estaba destruido.
        // No es un error real.
      }
      driverRef.current = null;
    };
  }, [role]);

  return null;
}
