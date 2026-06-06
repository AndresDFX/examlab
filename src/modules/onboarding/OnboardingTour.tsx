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
 *
 * Demo interactivo (clickBefore):
 * Algunos steps (ej. "Crear curso") abren el dialog "Nuevo X" para
 * mostrar los campos. Driver.js NO soporta hooks async, así que el
 * timing es complicado:
 *   1. driver.js fija `__activeElement` con el resultado de
 *      `querySelector(s.element)` cuando entra al step. Si el dialog
 *      no existe todavía, cachea `driver-dummy-element` (centro de
 *      pantalla). `refresh()` NO re-resuelve el selector — sólo
 *      reposiciona contra el cache. Verificado leyendo el source de
 *      driver.js.
 *   2. Solución: tras el clickBefore, esperamos con MutationObserver
 *      a que el dialog aparezca y llamamos `moveTo(activeIndex)`
 *      (que SÍ re-llama `querySelector`). Esto re-ancla el popover
 *      contra el dialog real.
 *   3. Si el botón está disabled (caso típico: Docente sin cursos →
 *      "Nueva pregunta"/"Nueva encuesta" disabled), skipeamos el demo
 *      con `moveNext()` para no dejar al user con popover huérfano.
 *   4. Trackeamos todos los timeouts/observers en un ref y los
 *      cancelamos al destruir el tour Y entre steps (para evitar que
 *      un click pendiente abra un dialog huérfano si el user clickea
 *      Siguiente rápido).
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

/** Espera a que aparezca un elemento en el DOM. Resuelve con el
 *  elemento o null si pasó el timeout. Usa MutationObserver para no
 *  polear el DOM. Útil cuando un click programático monta un dialog
 *  async vía React y necesitamos saber cuándo está listo. */
function waitForElement(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  // Comprobación rápida: si ya está en el DOM, no creamos observer.
  const immediate = document.querySelector<HTMLElement>(selector);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let observer: MutationObserver | null = null;
    const timer = setTimeout(() => {
      observer?.disconnect();
      resolve(null);
    }, timeoutMs);
    observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        clearTimeout(timer);
        observer?.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/** Cierra el dialog de confirmación "Cambios sin guardar" que algunos
 *  forms (course/exam/workshop/project) muestran al intentar cerrar
 *  con `dirty=true`. El tour abre estos dialogs vacíos y al cerrarlos
 *  con Esc puede aparecer el confirm bloqueando el flow. Buscamos el
 *  botón "Descartar" dentro de un `[role="dialog"]` y le hacemos click.
 *
 *  Idempotente: si no hay confirm visible, no hace nada. Se invoca
 *  con cada Esc programático del tour. */
function dismissUnsavedConfirm(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[role="dialog"] button, [role="alertdialog"] button',
  );
  for (const btn of buttons) {
    const text = btn.textContent?.trim().toLowerCase() ?? "";
    if (text === "descartar" || text === "discard") {
      btn.click();
      return;
    }
  }
}

export function OnboardingTour({ role, onComplete, onDismiss, manualMode = false }: Props) {
  const driverRef = useRef<Driver | null>(null);
  const router = useRouter();
  // Refs para callbacks/router — el effect que instancia driver.js solo
  // re-corre al cambiar `role`, así que cualquier valor "vivo" va por ref.
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

    // Filtro: un step se considera válido si tiene `route` o
    // `clickBefore` (ambos pueden traer el element al DOM dinámicamente)
    // o si su `element` ya existe en el DOM. Esto incluye los demo
    // steps interactivos (cuyo dialog se crea con clickBefore) que el
    // filtro estricto anterior excluía.
    const validSteps: TourStep[] = steps.filter((s) => {
      if (s.route || s.clickBefore) return true;
      try {
        return document.querySelector(s.element) !== null;
      } catch {
        return false;
      }
    });
    if (validSteps.length === 0) return;

    // Video introductorio (HeyGen) en el primer step si el rol lo tiene.
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

    // Tracking de async pendientes para cancelarlos cuando el user
    // avance manualmente antes de que el demo termine, o cuando el
    // tour se destruye. Sin esto un click pendiente puede abrir un
    // dialog huérfano en el siguiente step (o después de cerrar el
    // tour).
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    let pendingAbort: AbortController | null = null;
    const cancelPending = () => {
      pendingTimers.forEach((t) => clearTimeout(t));
      pendingTimers.clear();
      if (pendingAbort) {
        pendingAbort.abort();
        pendingAbort = null;
      }
    };

    // Flag para evitar loop de re-ancla: cuando llamamos `moveTo(idx)`
    // tras detectar el dialog, driver.js re-dispara `onHighlightStarted`
    // del mismo step. Sin esta flag, las pre-actions (escapeBefore +
    // click) corren otra vez → Esc cierra el dialog → click lo reabre
    // → waitForElement vuelve a disparar moveTo → titileo infinito.
    //
    // Setteo la flag al activeIndex ANTES de moveTo. En el siguiente
    // onHighlightStarted comparo y, si matchea, skipeo pre-actions y
    // limpio. Si el user avanzó/retrocedió mid-reanchor, el index no
    // matchea y las pre-actions corren normales.
    let reanchoringStep: number | null = null;

    /** Helper para programar un setTimeout que respeta el abort
     *  controller del step. Si el step termina antes, el callback no
     *  corre. */
    const scheduleStepTimer = (fn: () => void, ms: number, signal: AbortSignal) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (!signal.aborted) fn();
      }, ms);
      pendingTimers.add(timer);
    };

    const driverObj = driver({
      showProgress: true,
      showButtons: ["next", "previous", "close"],
      nextBtnText: "Siguiente →",
      prevBtnText: "← Anterior",
      doneBtnText: "Finalizar",
      progressText: "{{current}} de {{total}}",
      overlayOpacity: 0.6,
      animate: true,
      allowClose: true,
      smoothScroll: true,
      overlayClickBehavior: "nextStep",
      // Botón "Saltar tour" inyectado en el footer del popover.
      onPopoverRender: (popover) => {
        if (popover.footer.querySelector("[data-tour-skip]")) return;
        const skipBtn = document.createElement("button");
        skipBtn.type = "button";
        skipBtn.dataset.tourSkip = "true";
        skipBtn.textContent = "Saltar tour";
        skipBtn.className = "driver-tour-skip-btn";
        skipBtn.style.marginRight = "auto";
        skipBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          driverObj.destroy();
        });
        popover.footer.insertBefore(skipBtn, popover.footer.firstChild);
      },
      steps: validSteps.map((s) => ({
        element: s.element,
        ...(s.route || s.clickBefore || s.escapeBefore
          ? {
              onHighlightStarted: (element) => {
                // Guard de re-anchor: si entramos al step por moveTo()
                // (post waitForElement), `reanchoringStep` matchea el
                // activeIndex. Skipeamos pre-actions — driver.js solo
                // está re-resolviendo el selector. Sin este guard:
                // escapeBefore cierra el dialog que recién abrimos →
                // click lo reabre → moveTo otra vez → loop infinito
                // (= titileo del popover).
                const currentIdx = driverObj.getActiveIndex();
                if (typeof currentIdx === "number" && reanchoringStep === currentIdx) {
                  reanchoringStep = null;
                  return;
                }
                reanchoringStep = null;

                // Cancelar cualquier async del step anterior. Si el user
                // clickeó Siguiente antes de que el clickBefore terminara,
                // queremos descartar ese click pending (no abrir un
                // dialog que ya no aplica).
                cancelPending();
                const abort = new AbortController();
                pendingAbort = abort;

                // 1. Escape: cierra Dialog/Popover del step anterior.
                //    Tras el Esc puede aparecer el confirm de "Cambios
                //    sin guardar" si el form estaba dirty. Lo
                //    descartamos automáticamente para que el flow no
                //    quede atrapado.
                if (s.escapeBefore) {
                  try {
                    document.dispatchEvent(
                      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
                    );
                  } catch {
                    /* no-op */
                  }
                  // Doble pasada — la primera tras el Esc para el
                  // dialog directo, la segunda tras un tick por si
                  // el confirm aparece async.
                  dismissUnsavedConfirm();
                  scheduleStepTimer(() => dismissUnsavedConfirm(), 120, abort.signal);
                }

                // 2. Route: navegar si la ruta actual no coincide.
                if (s.route) {
                  const wanted = s.route;
                  const current = typeof window !== "undefined" ? window.location.pathname : "";
                  if (current !== wanted) {
                    try {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      void (routerRef.current as any).navigate({ to: wanted });
                    } catch (err) {
                      console.warn(`[tour] no se pudo navegar a ${wanted}`, err);
                    }
                  }
                }

                // 3. Scroll del item del sidebar al centro de su
                //    contenedor scrolleable (no del window — driver.js
                //    ya hace eso con smoothScroll).
                if (element instanceof HTMLElement) {
                  try {
                    element.scrollIntoView({ block: "center", behavior: "auto" });
                  } catch {
                    /* no-op */
                  }
                }

                // 4. Skip-en-runtime: si el step NO abre un dialog
                //    dinámico (no tiene clickBefore) y su element no
                //    existe en el DOM tras dar tiempo al route + render
                //    del sidebar, skipear con moveNext().
                //
                //    Caso típico: el step apunta a un item del nav
                //    (ej. data-tour-module="teacher_students") que NO
                //    está visible para el rol activo (Admin no tiene
                //    "Mis estudiantes" en su sidebar) o está oculto por
                //    module_visibility. Sin este skip, driver.js deja
                //    el highlight del step anterior pegado y el
                //    popover dice "Mis estudiantes" apuntando a
                //    "Usuarios" — bug visible reportado.
                //
                //    400ms cubre: route navigate (~100ms) + React
                //    re-render del sidebar (~50-100ms) + margen.
                if (!s.clickBefore) {
                  scheduleStepTimer(
                    () => {
                      try {
                        const exists = document.querySelector(s.element);
                        if (!exists) {
                          console.info(
                            `[tour] element no encontrado en runtime — skipeando step: ${s.element}`,
                          );
                          try {
                            driverObj.moveNext();
                          } catch {
                            /* no-op */
                          }
                        }
                      } catch {
                        /* no-op */
                      }
                    },
                    400,
                    abort.signal,
                  );
                }

                // 5. ClickBefore: abrir el dialog target.
                if (s.clickBefore) {
                  const delay = s.waitMs ?? 250;
                  scheduleStepTimer(
                    () => {
                      const btnSelector = s.clickBefore!;
                      const btn = document.querySelector<HTMLElement>(btnSelector);

                      // (a) Selector no existe → warn + auto-skip al
                      //     siguiente step.
                      if (!btn) {
                        console.warn(`[tour] clickBefore selector no encontrado: ${btnSelector}`);
                        try {
                          driverObj.moveNext();
                        } catch {
                          /* no-op */
                        }
                        return;
                      }

                      // (b) Botón disabled → skip el demo. Caso típico:
                      //     Docente sin cursos viendo "Nueva pregunta"
                      //     / "Nueva encuesta".
                      if (btn instanceof HTMLButtonElement && btn.disabled) {
                        console.info(
                          `[tour] clickBefore button disabled — skipeando demo: ${btnSelector}`,
                        );
                        try {
                          driverObj.moveNext();
                        } catch {
                          /* no-op */
                        }
                        return;
                      }

                      // (c) Disparar click.
                      try {
                        btn.click();
                      } catch (err) {
                        console.warn(`[tour] click falló en ${btnSelector}`, err);
                        return;
                      }

                      // (d) Esperar al dialog. moveTo(idx) re-llama
                      //     querySelector y re-ancla. ANTES del moveTo
                      //     marcamos `reanchoringStep` para que el
                      //     onHighlightStarted que dispara moveTo
                      //     skipee pre-actions (rompe el loop).
                      void waitForElement(s.element, 3000).then((dialogEl) => {
                        if (abort.signal.aborted) return;
                        if (!dialogEl) {
                          console.warn(`[tour] dialog no apareció en 3s tras click: ${s.element}`);
                          return;
                        }
                        try {
                          const idx = driverObj.getActiveIndex();
                          if (typeof idx === "number") {
                            reanchoringStep = idx;
                            driverObj.moveTo(idx);
                          }
                        } catch (err) {
                          reanchoringStep = null;
                          console.warn(`[tour] no se pudo re-anclar al dialog`, err);
                        }
                      });
                    },
                    delay,
                    abort.signal,
                  );
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
      onDestroyed: () => {
        // Cancelar todo lo pendiente para no dejar dialogs huérfanos.
        cancelPending();
        // Cerrar el dialog que el último clickBefore haya abierto
        // (típicamente "Nuevo X"). Sin esto el user cierra el tour
        // pero queda un formulario flotando sobre la ruta destino.
        try {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        } catch {
          /* no-op */
        }
        if (manualRef.current) {
          onDismissRef.current();
        } else if (role) {
          onCompleteRef.current(role);
        }
      },
    });

    driverRef.current = driverObj;
    // Pequeño delay para animaciones de entrada del sidebar.
    const startTimer = setTimeout(() => {
      driverObj.drive();
    }, 100);

    return () => {
      clearTimeout(startTimer);
      cancelPending();
      try {
        driverObj.destroy();
      } catch {
        /* driver.js a veces tira al destruir si ya estaba destruido. */
      }
      driverRef.current = null;
    };
  }, [role]);

  return null;
}
