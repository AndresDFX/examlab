/**
 * requestBrowserSaveCredential — dispara el prompt nativo de "¿Guardar /
 * actualizar contraseña?" del navegador vía Credential Management API.
 *
 * Por qué hace falta (y no basta el form): ExamLab es una SPA. Tanto el
 * login (`signInWithPassword` + `window.location.href`) como el cambio
 * forzado de contraseña (`updateUser` + desmontar un diálogo, SIN navegar)
 * evitan el "submit de form real + navegación" en el que se apoya el
 * heurístico de Chrome para ofrecer guardar la credencial. Síntoma
 * reportado: al ENTRAR con una cuenta nueva el navegador no ofrece
 * guardarla (las ya guardadas se autocompletan, por eso solo se nota con
 * cuentas nuevas). `navigator.credentials.store()` con un `PasswordCredential`
 * lo dispara explícitamente y Chrome/Edge muestran su burbuja nativa.
 *
 * Feature-detected + try/catch: Firefox y Safari no implementan
 * `PasswordCredential` (caen al heurístico del form, que ya tiene los
 * `autoComplete` username/current-password/new-password correctos);
 * contextos no seguros (http) tampoco lo exponen. En todos esos casos es un
 * no-op silencioso.
 *
 * Llamar SOLO en el camino válido (no cuando se va a cerrar sesión) y, en el
 * login, ANTES de navegar — el await deja la burbuja encolada y Chrome la
 * muestra tras el redirect / tras el cambio.
 */
export async function requestBrowserSaveCredential(
  email: string,
  password: string,
): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (typeof w.PasswordCredential !== "function" || !navigator.credentials?.store) return;
    if (!email || !password) return;
    const cred = new w.PasswordCredential({ id: email, password, name: email });
    await navigator.credentials.store(cred);
  } catch {
    /* no-op: si falla, queda el heurístico del form como fallback */
  }
}
