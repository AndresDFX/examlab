/**
 * Qué tipos de pregunta montan el editor de código (Monaco), para poder
 * PRECALENTARLO mientras la persona está leyendo otra cosa.
 *
 * ── Por qué hace falta precalentar ────────────────────────────────────
 *
 * Monaco no viaja en el bundle: lo baja `@monaco-editor/loader` de jsDelivr en
 * el momento en que se monta el editor. Medido el 2026-09-28 contra
 * `monaco-editor@0.55.1`: **1,05 MB comprimidos / 4,1 MB sin comprimir**, casi
 * todo en un solo archivo (`editor.api-*.js`, 918 KB comprimidos). Y el
 * service worker hace bypass total de jsdelivr (`public/sw.js`), así que eso no
 * queda en su caché: lo guarda el navegador por HTTP, y en una pestaña nueva de
 * un salón con WiFi flojo son segundos de pantalla vacía JUSTO cuando aparece
 * la pregunta.
 *
 * Arrancar la descarga en la pantalla de «Antes de comenzar» es tiempo REGALADO:
 * la persona está leyendo las reglas, no escribiendo. Los bytes son los mismos;
 * lo único que cambia es que no se pagan con el cronómetro corriendo.
 *
 * ── Por qué una lista y no «precalentar siempre» ──────────────────────
 *
 * Un parcial de 30 preguntas de selección múltiple no debe bajar 1 MB para
 * nada, menos en un teléfono con datos. Con la lista, el examen que no tiene
 * ninguna pregunta de código no paga nada.
 *
 * ── Si la lista se desactualiza, NO se rompe nada ─────────────────────
 *
 * Un tipo nuevo que use Monaco y que alguien olvide agregar acá simplemente no
 * se precalienta: el editor se sigue cargando cuando se monta, o sea el
 * comportamiento de antes de esto. Es a propósito que el peor caso sea ese y no
 * un error. Igual hay un test que avisa cuando aparece un editor de Monaco
 * nuevo, para que la decisión se tome en vez de perderse.
 */

/**
 * Tipos de pregunta cuyo componente monta Monaco.
 *
 * `codigo` → `CodeEditor` · `bd_sql` → `SqlRunner` · `java_gui` →
 * `JavaGuiRunner` · `python_gui` → `PythonGuiRunner`.
 *
 * `so_consola` NO está: usa xterm + v86, que es otro motor (y otro CDN).
 */
export const TIPOS_CON_EDITOR: ReadonlySet<string> = new Set([
  "codigo",
  "bd_sql",
  "java_gui",
  "python_gui",
]);

/** ¿Alguna de estas preguntas va a necesitar el editor de código? */
export function necesitaEditorDeCodigo(
  tipos: ReadonlyArray<string | null | undefined>,
): boolean {
  return tipos.some((t) => !!t && TIPOS_CON_EDITOR.has(t));
}
