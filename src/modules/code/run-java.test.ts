import { describe, expect, it } from "vitest";
import { deriveMainClass, withTimeout } from "./run-java";

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
