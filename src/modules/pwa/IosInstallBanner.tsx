/**
 * IosInstallBanner — banner pegado en bottom con instrucciones para
 * "Añadir a la pantalla de inicio" en iPhone/iPad.
 *
 * Por qué este componente existe:
 *   - Safari iOS NO dispara `beforeinstallprompt` (es un evento Chromium).
 *   - Sin él, no podemos llamar `prompt()` para instalar la PWA. El
 *     usuario debe hacerlo manualmente: Compartir → "Añadir a pantalla
 *     de inicio". La mayoría no descubre esa opción.
 *   - Además, Safari iOS solo permite Web Push (notificaciones cuando la
 *     app está cerrada) si la PWA está instalada en home screen — sin
 *     instalación, los mensajes no llegan al estudiante con la app
 *     cerrada. Por eso es load-bearing, no estética.
 *
 * Detección:
 *   - iOS = /iPad|iPhone|iPod/.test(userAgent) || iPad moderno con
 *     userAgent "Macintosh" + touch (iPadOS 13+ se identifica como Mac).
 *   - PWA instalada = matchMedia('(display-mode: standalone)') ||
 *     navigator.standalone === true (Safari-specific).
 *   - Mostramos solo si: iOS Safari, NO instalado, y no descartado por
 *     el usuario (localStorage).
 */
import { useEffect, useState } from "react";
import { Share, Plus, X } from "lucide-react";

const STORAGE_KEY = "examlab_ios_install_dismissed_at";
/** Días de "silencio" tras descartar el banner. Después vuelve a salir
 *  para no quedarse cerrado para siempre — el usuario podría haberlo
 *  cerrado por error. 14 días es un buen tradeoff entre molestar y
 *  ayudar a quien aún no instaló. */
const RESHOW_AFTER_DAYS = 14;

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPhone/iPod estándar
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPad moderno (iPadOS 13+) miente y dice "Macintosh". Detectamos por
  // touch + plataforma Mac.
  if (ua.includes("Macintosh") && navigator.maxTouchPoints > 1) return true;
  return false;
}

function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  // Safari iOS legacy property
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window.navigator as any).standalone === true) return true;
  return false;
}

function wasRecentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;
    const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    return ageDays < RESHOW_AFTER_DAYS;
  } catch {
    return false;
  }
}

export function IosInstallBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIos()) return;
    if (isInstalled()) return;
    if (wasRecentlyDismissed()) return;
    // Pequeño delay para no aparecer al instante en la carga inicial.
    const t = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      /* localStorage puede estar deshabilitado en modo privado iOS — ok */
    }
    setVisible(false);
  };

  return (
    <div
      className="fixed inset-x-3 bottom-3 z-[60] rounded-lg border border-primary/30 bg-background/95 backdrop-blur shadow-lg p-3 sm:max-w-md sm:left-auto sm:right-3"
      role="dialog"
      aria-label="Instalar ExamLab en iPhone"
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center">
          <Plus className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-sm font-medium">Instala ExamLab en tu iPhone</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Toca{" "}
            <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5">
              <Share className="h-3 w-3" />
              Compartir
            </span>{" "}
            y luego{" "}
            <span className="font-medium">"Añadir a pantalla de inicio"</span>. Necesario para
            recibir notificaciones cuando la app esté cerrada.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Cerrar"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
