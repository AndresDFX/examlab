import javafx.application.Application;

/**
 * JavaFxBootstrap — análogo a GuiBootstrap pero para JavaFX.
 *
 * Por qué un wrapper aparte (no extender GuiBootstrap):
 *   - JavaFX tiene un entry-point distinto: el estudiante extiende
 *     `javafx.application.Application` e implementa `start(Stage)`. El
 *     launcher canónico es `Application.launch(MyApp.class, args)` —
 *     NO `main(String[])`. GuiBootstrap llama main() por reflection;
 *     eso no aplica.
 *   - `Application.launch()` solo puede invocarse UNA VEZ por JVM.
 *     Si el estudiante también tiene un `public static void main()`
 *     que llama `launch()`, no podemos llamar a main + launch (la
 *     segunda invocación lanza IllegalStateException). Acá detectamos
 *     si la clase es Application-subclass y la pasamos a launch
 *     directo, SIN tocar el main del estudiante.
 *
 * Cómo se usa desde `app.py`:
 *   javac --module-path $JAVAFX_HOME/lib --add-modules javafx.controls,javafx.fxml,javafx.graphics \
 *         -d /tmp /tmp/MyApp.java
 *   java --module-path $JAVAFX_HOME/lib \
 *        --add-modules javafx.controls,javafx.fxml,javafx.graphics \
 *        -Dprism.order=sw \
 *        -Dexamlab.gui.mainClass=MyApp \
 *        -Dexamlab.gui.sleepMs=3500 \
 *        -cp /tmp:/opt \
 *        JavaFxBootstrap
 *
 * Comportamiento:
 *   - Spawn hilo daemon que llama `Application.launch(StudentClass)`.
 *     Si la clase NO extiende Application (caso raro: estudiante pasó
 *     una clase regular), fallback a `main(String[])` por reflection
 *     — mismo patrón que GuiBootstrap. Útil para preguntas mixtas.
 *   - Main thread duerme `sleepMs` ms. JavaFX App Thread (no-daemon)
 *     se queda vivo durante ese tiempo pintando la escena.
 *   - Al final `System.exit(0)` — JavaFX App Thread NO termina por
 *     cuenta propia (necesita `Platform.exit()` desde el código del
 *     estudiante, que casi nunca pone). Forzar exit evita que Lambda
 *     mate el proceso con SIGKILL tras el timeout.
 *   - Excepción en student code (incluido en `start()` después de
 *     launch()): JavaFX la printea al stderr del proceso y termina
 *     con exit code != 0. La capturamos en err[0] solo si pasa al
 *     `launch()` directo (errores en `start()` ya van a stderr nativo).
 *
 * Por qué no `Platform.startup()`: ese pattern requiere que el
 * estudiante NO use Application + launch(), sino que cree Stage
 * manualmente. Es no-canónico — los tutoriales/libros enseñan el
 * patrón con Application. Forzar startup() rompe la portabilidad del
 * código del estudiante (no compila en su IDE local).
 */
public class JavaFxBootstrap {
    public static void main(String[] args) throws Exception {
        final String target = System.getProperty("examlab.gui.mainClass", "Main");
        final long sleepMs = Long.getLong("examlab.gui.sleepMs", 4000L);
        final Throwable[] err = new Throwable[1];

        Thread t = new Thread(() -> {
            try {
                Class<?> cls = Class.forName(target);
                if (Application.class.isAssignableFrom(cls)) {
                    // Patrón canónico JavaFX. Application.launch
                    // bloquea hasta que la app termine (Platform.exit
                    // o cierre de la última Stage).
                    @SuppressWarnings("unchecked")
                    Class<? extends Application> appCls =
                        (Class<? extends Application>) cls;
                    Application.launch(appCls, args);
                } else {
                    // Fallback: clase regular con main(). Útil si el
                    // docente pide algo no-FX bajo el mismo runner.
                    java.lang.reflect.Method m = cls.getMethod("main", String[].class);
                    m.invoke(null, (Object) args);
                }
            } catch (Throwable ex) {
                err[0] = ex;
            }
        }, "examlab-fx-launcher");
        t.setDaemon(true);
        t.start();

        Thread.sleep(sleepMs);

        if (err[0] != null) {
            Throwable real = err[0];
            if (real instanceof java.lang.reflect.InvocationTargetException
                    && real.getCause() != null) {
                real = real.getCause();
            }
            real.printStackTrace();
            System.exit(2);
        }

        // JavaFX App Thread es non-daemon; sin esto Lambda colgaría
        // hasta el timeout. System.exit(0) cierra todos los hilos.
        System.exit(0);
    }
}
