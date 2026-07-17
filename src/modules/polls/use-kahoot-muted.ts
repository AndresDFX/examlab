/**
 * Hook del toggle de sonido del Reto en vivo. Estado compartido entre todas las
 * instancias (bell del host + del jugador) y entre pestañas — mismo patrón que
 * use-theme: evento custom in-page + `storage` cross-tab. Init determinista
 * (false) para no romper la hidratación SSR; el valor real se lee post-mount.
 */
import { useCallback, useEffect, useState } from "react";
import { isKahootMuted, setKahootMuted, unlockAudio } from "./kahoot-sound";

const EVENT_NAME = "examlab:kahoot-muted-changed";

export function useKahootMuted(): { muted: boolean; toggle: () => void; setMuted: (m: boolean) => void } {
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    setMutedState(isKahootMuted());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      setMutedState(typeof detail === "boolean" ? detail : isKahootMuted());
    };
    const onStorage = () => setMutedState(isKahootMuted());
    window.addEventListener(EVENT_NAME, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setMuted = useCallback((m: boolean) => {
    // El click es un gesto de usuario → desbloquea el audio del navegador.
    unlockAudio();
    setKahootMuted(m);
    setMutedState(m);
  }, []);

  const toggle = useCallback(() => setMuted(!isKahootMuted()), [setMuted]);

  return { muted, toggle, setMuted };
}
