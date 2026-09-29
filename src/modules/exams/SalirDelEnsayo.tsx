/**
 * La salida del ENSAYO, y la única fuente de esa afordancia.
 *
 * ── Por qué hizo falta ────────────────────────────────────────────────
 *
 * El simulacro reusa la pantalla del alumno TAL CUAL, y lo que encierra al
 * docente son las **capas que tapan la pantalla entera**: salir de pantalla
 * completa levanta una con un único botón —«volver a pantalla completa»—, y si
 * el examen estaba pausado, la de pausa no tiene NINGÚN botón. Como tapan todo,
 * también tapan el menú lateral, que es por donde el docente sí podría salir.
 *
 * Y se llega ahí por el gesto más natural: la tecla Esc está interceptada por el
 * examen, así que lo único que hace es soltar la pantalla completa… que es
 * justamente lo que levanta la primera capa. Quedaba una sola salida real: el
 * botón «Atrás» del NAVEGADOR, que no está en la página y nadie busca.
 *
 * Ojo con una precisión que es fácil dar por hecha: el menú lateral **no** queda
 * inerte en el simulacro. `isTakingExam` (`AppLayout.tsx`) matchea SOLO
 * `/app/student/take/$examId`, así que fuera de las capas el docente ya podía
 * salir con un clic. Por eso la salida tiene que estar DENTRO de las capas, no
 * solo en el aviso.
 *
 * Para el alumno eso es exactamente lo que se quiere. Para quien está probando,
 * no: no hay nada que proteger porque no hay entrega, ni nota, ni advertencia
 * que cobrar.
 *
 * ── Por qué un componente y no tres botones sueltos ───────────────────
 *
 * Se monta en TRES lugares —el aviso permanente y las dos capas que bloquean la
 * pantalla— y el modo de falla de olvidarse de uno es justamente el que se está
 * arreglando: una capa nueva sin salida vuelve a encerrar al docente, sin error
 * y sin que nadie se entere hasta que le pasa. Con un nombre propio, `grep` lo
 * encuentra y un test puede contarlo (`salida-del-ensayo.test.ts`).
 *
 * ── El rótulo dice «simulación», aunque acá se llame «ensayo» ─────────
 *
 * TODO lo que esta pantalla muestra habla de **simular / simulación**
 * («Estás simulando este examen», «Simulación terminada»); «ensayo» solo existe
 * en nombres internos. El botón que alguien busca cuando se siente encerrado no
 * puede ser la primera vez que lee una palabra nueva, así que el rótulo sigue al
 * resto de la pantalla y el nombre del módulo sigue al del código. No unificar
 * «corrigiendo» el rótulo.
 *
 * Usa `BackButton` del design system: es la afordancia documentada para «salir
 * de una vista embebida», y con eso la flecha y el alto del área táctil salen
 * de un solo lado en vez de reinventarse acá.
 */
import { useTranslation } from "react-i18next";
import { BackButton } from "@/components/ui/back-button";

export function SalirDelEnsayo({
  onSalir,
  className,
}: {
  onSalir: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <BackButton
      onClick={onSalir}
      label={t("simulacroExamen.salirDelEnsayo")}
      className={className}
    />
  );
}
