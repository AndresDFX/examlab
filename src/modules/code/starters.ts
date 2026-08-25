/**

 * Plantillas de código por defecto. Módulo PURO: sin React, sin Monaco, sin

 * i18n, sin Supabase.

 *

 * ── Por qué se sacaron de `CodeEditor` ────────────────────────────────

 * El predicado de "pregunta respondida" (`src/modules/exams/answered.ts`) las

 * necesita para saber si el alumno TOCÓ el editor o dejó la plantilla intacta.

 * Ese predicado lo usan la pantalla de toma de examen, la de talleres y el

 * MONITOR del docente — y el monitor no tiene por qué arrastrar Monaco ni el

 * runner de Java GUI a su bundle solo para contar respuestas.

 *

 * `CodeEditor`, `JavaGuiRunner` y `PythonGuiRunner` re-exportan lo suyo desde

 * acá, así que todos los imports que ya existían siguen funcionando y no hay

 * dos definiciones de la misma plantilla que puedan divergir.

 */

import type { CodeLanguage } from "@/modules/code/language-support";

/**

 * Plantilla por defecto para preguntas de tipo `codigo` con

 * `language='java'`. Usada como starter_code al crear preguntas

 * nuevas en el form del docente y como fallback en el taker del

 * estudiante cuando una pregunta vieja no tiene starter_code.

 *

 * Es deliberadamente mínima — clase Main + main + un println — para

 * que el estudiante arranque desde algo compilable y enfoque su

 * tiempo en el problema, no en escribir el boilerplate.

 */

export const JAVA_STARTER = `public class Main {

    public static void main(String[] args) {

        System.out.println("¡Hola, mundo!");

    }

}`;

// El idiom `if __name__ == "__main__":` con una función `main()` es el punto

// de entrada canónico/profesional de un programa Python — mismo espíritu que

// la clase Main + main de Java. Arranca al estudiante desde una estructura

// real (funciones + guard de ejecución), no desde un print suelto.

export const PYTHON_STARTER = `def main():

    print("¡Hola, mundo!")





if __name__ == "__main__":

    main()`;

export const JAVASCRIPT_STARTER = `console.log("¡Hola, mundo!");`;

/**

 * Kotlin: `fun main()` sin argumentos es la forma idiomática y la que se enseña

 * primero. Se evita `fun main(args: Array<String>)` (herencia de Java) porque

 * agrega ruido que la pregunta no evalúa.

 */

export const KOTLIN_STARTER = `fun main() {

    println("¡Hola, mundo!")

}`;

/**

 * Devuelve el starter code por defecto para un lenguaje. Lo usan los

 * takers (alumno) y los formularios (docente) como fallback cuando la

 * pregunta no tiene `starter_code` propio. Mismo template que ve el

 * docente al previsualizar y el alumno al entrar — consistencia

 * docente↔alumno garantizada.

 *

 * Para lenguajes desconocidos (legacy/typo) devuelve string vacío en vez

 * de tirar — el editor renderea ok y el alumno puede empezar desde 0.

 */

export function getStarterCode(language: CodeLanguage | string | null | undefined): string {
  switch (language) {
    case "java":
      return JAVA_STARTER;

    case "python":
      return PYTHON_STARTER;

    case "javascript":
      return JAVASCRIPT_STARTER;

    case "kotlin":
      return KOTLIN_STARTER;

    default:
      return "";
  }
}

/**
 * Snippet inicial para preguntas JavaFX. NO incluye `Application.launch()`
 * en el `main` — el `JavaFxBootstrap` server-side lo invoca por reflection
 * cuando detecta `extends Application`. Aún así dejamos el `main` con la
 * llamada porque permite al alumno compilar/correr local en su IDE.
 */
export const JAVAFX_STARTER = `import javafx.application.Application;
import javafx.scene.Scene;
import javafx.scene.control.Button;
import javafx.scene.control.Label;
import javafx.scene.layout.VBox;
import javafx.geometry.Pos;
import javafx.geometry.Insets;
import javafx.stage.Stage;

public class Main extends Application {
    @Override
    public void start(Stage stage) {
        Label label = new Label("¡Hola, mundo desde JavaFX!");
        label.setStyle("-fx-font-size: 16px; -fx-font-weight: bold;");

        Button btn = new Button("Saludar");
        btn.setOnAction(e -> label.setText("¡Hola, " + System.currentTimeMillis() + "!"));

        VBox root = new VBox(12, label, btn);
        root.setAlignment(Pos.CENTER);
        root.setPadding(new Insets(24));

        stage.setScene(new Scene(root, 420, 240));
        stage.setTitle("Hola JavaFX");
        stage.show();
    }

    // Permite correr local desde IDE. En el runner del servidor NO se
    // invoca este \`main\`: el wrapper JavaFxBootstrap detecta que la
    // clase extiende Application y llama Application.launch directamente.
    public static void main(String[] args) {
        launch(args);
    }
}
`;
export const JAVA_GUI_STARTER = `import javax.swing.*;
import java.awt.*;

public class Main {
    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            JFrame frame = new JFrame("Hola Swing");
            frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
            frame.setSize(420, 240);

            JPanel panel = new JPanel(new BorderLayout());
            JLabel label = new JLabel("¡Hola, mundo desde Swing!", SwingConstants.CENTER);
            label.setFont(new Font("SansSerif", Font.BOLD, 18));
            panel.add(label, BorderLayout.CENTER);

            JButton btn = new JButton("Saludar");
            btn.addActionListener(e -> label.setText("¡Hola, " + System.currentTimeMillis() + "!"));
            panel.add(btn, BorderLayout.SOUTH);

            frame.setContentPane(panel);
            frame.setVisible(true);
        });
    }
}
`;
/**
 * Snippet inicial. Crea una ventana sencilla con un Label y un Button —
 * suficiente para validar que el flujo de captura funciona. El alumno
 * NO necesita escribir `root.after(..., root.destroy)`: el bootstrap
 * server-side lo agrega automáticamente.
 */
export const PYTHON_GUI_STARTER = `import tkinter as tk

root = tk.Tk()
root.title("Hola tkinter")
root.geometry("420x240")

label = tk.Label(
    root,
    text="¡Hola, mundo desde tkinter!",
    font=("Helvetica", 16, "bold"),
)
label.pack(pady=24)

btn = tk.Button(root, text="Saludar", command=lambda: label.config(text="¡Hola!"))
btn.pack()

root.mainloop()
`;
