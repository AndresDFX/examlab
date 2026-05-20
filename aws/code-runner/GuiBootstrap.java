/**
 * GuiBootstrap — wrapper que invoca al `main` del estudiante mediante
 * reflection y luego deja la JVM viva el tiempo necesario para que
 * Swing pinte antes de que `app.py` capture el framebuffer de Xvfb.
 *
 * Por qué existe:
 *   El estudiante escribe un `JFrame f = new JFrame(...); f.setVisible(true);`
 *   y termina su `main`. En modo headless con AWT eso a veces deja
 *   la JVM colgada (EDT non-daemon) y a veces sale de inmediato — depende
 *   de cómo configuró `setDefaultCloseOperation`, si llamó `System.exit`,
 *   etc. Sin un sleep explícito el framebuffer puede quedar negro porque
 *   Xvfb no alcanzó a recibir los `XPutImage` del EDT.
 *
 *   Pedirle al estudiante que ponga `Thread.sleep(4000)` al final del
 *   main es ruido pedagógico (no es lo que evalúa la pregunta) y se les
 *   olvida. Este wrapper lo hace por ellos sin tocar su código.
 *
 * Cómo se usa desde `app.py`:
 *   javac student's Main.java → /tmp/Main.class
 *   java -Dexamlab.gui.mainClass=Main \
 *        -Dexamlab.gui.sleepMs=3500   \
 *        -cp /tmp:/opt                \
 *        GuiBootstrap
 *
 * Comportamiento:
 *   - Lanza el `main` del estudiante en un hilo DAEMON. El EDT que cree
 *     internamente (no-daemon) puede mantener viva la JVM si quiere; si
 *     no lo hace, este wrapper sigue vivo mientras dura el sleep.
 *   - Si el `main` del estudiante lanza una excepción, la imprimimos a
 *     stderr (la causa real desempaquetada de InvocationTargetException)
 *     y salimos con exit code 2 para que el cliente sepa que falló —
 *     antes de capturar el screenshot, así no se muestra una ventana
 *     fantasma de algo que crasheó.
 *   - El sleep se controla con `-Dexamlab.gui.sleepMs=<ms>`. Default 4000.
 *   - Al final hacemos `System.exit(0)`. Necesario porque si el EDT
 *     quedó vivo (típico con `setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE)`)
 *     la JVM no saldría sola en Lambda y el cleanup de Python tendría
 *     que matarla con SIGKILL.
 *
 * NO usar `final` en variables compartidas con el lambda: Java 21 con
 * `--release 11` no acepta capturas implícitas de mutables. Por eso el
 * `Throwable[1]` truco — el array es final, el slot 0 es mutable.
 */
public class GuiBootstrap {
    public static void main(String[] args) throws Exception {
        final String target = System.getProperty("examlab.gui.mainClass", "Main");
        final long sleepMs = Long.getLong("examlab.gui.sleepMs", 4000L);
        final Throwable[] err = new Throwable[1];

        Thread t = new Thread(() -> {
            try {
                Class<?> cls = Class.forName(target);
                java.lang.reflect.Method m = cls.getMethod("main", String[].class);
                m.invoke(null, (Object) args);
            } catch (Throwable ex) {
                err[0] = ex;
            }
        }, "examlab-student-main");
        t.setDaemon(true);
        t.start();

        // Damos tiempo a Swing para terminar de pintar antes de la
        // captura. Si el estudiante eligió bloquear su propio main (con
        // su propio sleep o invokeAndWait), igual lo respetamos — el
        // sleep nuestro corre en paralelo. Solo añade tiempo si el
        // estudiante NO bloqueó.
        Thread.sleep(sleepMs);

        if (err[0] != null) {
            // Desempaqueta InvocationTargetException para mostrar la
            // causa real (NPE, ArrayIndexOutOfBounds, etc.) en stderr,
            // no el wrapper de reflection.
            Throwable real = err[0];
            if (real instanceof java.lang.reflect.InvocationTargetException
                    && real.getCause() != null) {
                real = real.getCause();
            }
            real.printStackTrace();
            System.exit(2);
        }

        // Forzamos salida limpia. Sin esto, si el EDT del estudiante
        // quedó vivo (setDefaultCloseOperation != EXIT_ON_CLOSE) la JVM
        // colgaría hasta que Lambda la mate por timeout.
        System.exit(0);
    }
}
