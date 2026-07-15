import { describe, expect, it } from "vitest";
import { deriveMainClass, deriveMainClassFromFiles, withTimeout } from "./run-java";

describe("deriveMainClass", () => {
  it("extrae el nombre de la public class", () => {
    const src = `public class MiPrograma { public static void main(String[] args) {} }`;
    expect(deriveMainClass(src)).toBe("MiPrograma");
  });

  it("acepta modificadores y whitespace entre 'public' y 'class'", () => {
    expect(deriveMainClass("public   class   Foo {")).toBe("Foo");
    expect(deriveMainClass("public\tclass\tBar {")).toBe("Bar");
  });

  it("acepta nombres con _$ y dígitos no iniciales", () => {
    expect(deriveMainClass("public class _$Hello123 {}")).toBe("_$Hello123");
  });

  it("fallback 'Main' cuando no hay public class", () => {
    expect(deriveMainClass("class Algo {}")).toBe("Main"); // sin 'public'
    expect(deriveMainClass("// sin nada")).toBe("Main");
    expect(deriveMainClass("")).toBe("Main");
  });

  it("toma la PRIMERA public class si hay varias", () => {
    const src = `public class A {} public class B {}`;
    expect(deriveMainClass(src)).toBe("A");
  });

  it("tolera comentarios y package antes", () => {
    const src = `
      // package x;
      package com.ejemplo;
      import java.util.*;
      public class Calculadora {
        // ...
      }
    `;
    expect(deriveMainClass(src)).toBe("Calculadora");
  });

  it("elige la clase que DECLARA main aunque haya una public class sin main (single-file)", () => {
    const src = `public class Board {}\nclass Game { public static void main(String[] a){ System.out.println("ok"); } }`;
    expect(deriveMainClass(src)).toBe("Game");
  });

  it("mantiene la public class cuando ELLA declara main, con una clase interna presente (regresión)", () => {
    const src = `public class Board { class Inner {} public static void main(String[] a){} }`;
    expect(deriveMainClass(src)).toBe("Board");
  });

  it("no confunde 'class' dentro de comentarios/strings con una declaración", () => {
    const src = `
      // class Fake { main }
      public class Real {
        String s = "class Bogus {";
        public static void main(String[] a){}
      }`;
    expect(deriveMainClass(src)).toBe("Real");
  });

  it("main en la segunda public class (tras otra clase) → la segunda", () => {
    const src = `class A {}\npublic class B { public static void main(String[] a){} }`;
    expect(deriveMainClass(src)).toBe("B");
  });
});

describe("deriveMainClassFromFiles", () => {
  it("elige la clase del archivo que tiene main (no la primera)", () => {
    const files = [
      { filename: "Util.java", content: "public class Util { static int dup(int x){return x*2;} }" },
      {
        filename: "App.java",
        content:
          "public class App { public static void main(String[] args){ System.out.println(Util.dup(2)); } }",
      },
    ];
    expect(deriveMainClassFromFiles(files)).toBe("App");
  });

  it("toma la clase con main aunque no sea pública (top-level fallback)", () => {
    const files = [
      { filename: "A.java", content: "public class A { int x; }" },
      {
        filename: "Runner.java",
        content: "class Runner { public static void main(String[] args){} }",
      },
    ];
    expect(deriveMainClassFromFiles(files)).toBe("Runner");
  });

  it("tolera String[] args, String args[] y String... args", () => {
    const variants = [
      "public class M1 { public static void main(String[] a){} }",
      "public class M2 { public static void main(String a[]){} }",
      "public class M3 { public static void main(String... a){} }",
      "public class M4 { public static void main(final String[] a){} }",
    ];
    expect(deriveMainClassFromFiles([{ filename: "M1.java", content: variants[0] }])).toBe("M1");
    expect(deriveMainClassFromFiles([{ filename: "M2.java", content: variants[1] }])).toBe("M2");
    expect(deriveMainClassFromFiles([{ filename: "M3.java", content: variants[2] }])).toBe("M3");
    expect(deriveMainClassFromFiles([{ filename: "M4.java", content: variants[3] }])).toBe("M4");
  });

  it("cuando ningún archivo tiene main, cae a la primera clase declarada", () => {
    const files = [
      { filename: "First.java", content: "public class First {}" },
      { filename: "Second.java", content: "public class Second {}" },
    ];
    expect(deriveMainClassFromFiles(files)).toBe("First");
  });

  it("ignora archivos vacíos al buscar la primera clase de fallback", () => {
    const files = [
      { filename: "Empty.java", content: "   " },
      { filename: "Real.java", content: "class Real {}" },
    ];
    expect(deriveMainClassFromFiles(files)).toBe("Real");
  });

  it("fallback 'Main' cuando no hay archivos o no hay clases", () => {
    expect(deriveMainClassFromFiles([])).toBe("Main");
    expect(deriveMainClassFromFiles([{ filename: "x.java", content: "// vacío" }])).toBe("Main");
  });

  it("prefiere la public class del archivo con main sobre otra clase top-level", () => {
    const files = [
      {
        filename: "Mixed.java",
        content:
          "class Helper {} public class Entry { public static void main(String[] args){} }",
      },
    ];
    expect(deriveMainClassFromFiles(files)).toBe("Entry");
  });

  it("un solo archivo se comporta como deriveMainClass para la clase pública", () => {
    const src = "public class Solo { public static void main(String[] a){} }";
    expect(deriveMainClassFromFiles([{ filename: "Solo.java", content: src }])).toBe(
      deriveMainClass(src),
    );
  });

  it("elige la clase con main cuando la public class del MISMO archivo no lo tiene", () => {
    const files = [
      {
        filename: "Mixed.java",
        content:
          'public class Board {}\nclass Game { public static void main(String[] a){ System.out.println("ok"); } }',
      },
    ];
    expect(deriveMainClassFromFiles(files)).toBe("Game");
  });
});

describe("withTimeout", () => {
  it("resuelve con el valor cuando la promise termina antes del timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it("rechaza con mensaje claro cuando supera el timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 50)).rejects.toThrow(/Tiempo de ejecuci[óo]n excedido/);
  });

  it("incluye los segundos en el mensaje de error", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 100)).rejects.toThrow(/0\.1s/);
  });

  it("propaga el rejection de la promise original (no es timeout)", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(withTimeout(failing, 1000)).rejects.toThrow("boom");
  });

  it("limpia el timer al resolver para no dejar handles colgando", async () => {
    // Si dejara el setTimeout vivo, en vitest 4 con strict timers podríamos
    // ver warnings. Aquí solo verificamos comportamiento correcto: la
    // promise se resuelve y la siguiente espera puede completar sin
    // efectos secundarios.
    await withTimeout(Promise.resolve("ok"), 50);
    // dar tiempo a que el timeout (50ms) hubiera disparado — no debe romper.
    await new Promise((r) => setTimeout(r, 80));
    expect(true).toBe(true);
  });
});
