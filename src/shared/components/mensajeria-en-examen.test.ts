import { describe, it, expect } from "vitest";
import fs from "node:fs";

/**
 * Durante un examen no puede haber ninguna puerta a mensajes ni notificaciones.
 *
 * ── Por qué se cuida contra el disco ─────────────────────────────────
 *
 * El agujero que esto arregla no se veía: de las cinco superficies que el shell
 * monta —las dos del pie del sidebar, las dos del encabezado móvil y el botón
 * flotante— cuatro estaban cerradas con `!isTakingExam` y la quinta se había
 * quedado afuera. Y de la peor manera: el propio examen COLAPSA el sidebar al
 * empezar, que es justo la condición que hace aparecer ese botón flotante.
 *
 * Lo que abría tampoco era cosmético. Es `fixed z-50` —flota sobre el examen
 * incluso en pantalla completa— y su contenido son `<Link>` del router: abrirlo
 * y saltar a /app/messages es navegación del SPA, sin recarga. Sin recarga no
 * hay `beforeunload`, y sin `popstate` no hay diálogo de salida: el alumno leía
 * y escribía mensajes en mitad del examen sin que se registrara una sola
 * advertencia. Escribir la URL a mano sí cuesta strike; esto no costaba nada.
 *
 * Agregar una superficie nueva y olvidar la puerta no da ningún error, no rompe
 * ninguna pantalla, y solo se descubre cuando alguien lo usa para copiarse.
 */

const SRC = fs.readFileSync("src/shared/components/AppLayout.tsx", "utf8");

/** Todo lo que comunica con otra persona o lleva fuera del examen. */
const SUPERFICIES = ["MessagesFab", "MessagesBell", "NotificationBell"] as const;

/**
 * ¿Este montaje está DENTRO de un bloque `{!isTakingExam && (…)}`?
 *
 * Se mira hacia arriba hasta encontrar lo primero de dos cosas: el guard, o un
 * `)}` — que cierra una expresión JSX y por lo tanto significa que el bloque de
 * arriba ya terminó y no nos envuelve.
 *
 * Una ventana de N líneas no servía: el guard del pie del sidebar está a quince
 * del `<MessagesBell>`, y agrandarla hasta que entre la vuelve tan laxa que un
 * `!isTakingExam` de OTRO bloque la haría pasar en falso — que es exactamente
 * lo que este test existe para no hacer.
 */
function estaDetrasDelGuard(lineas: string[], idx: number): boolean {
  for (let i = idx; i >= 0 && idx - i < 60; i--) {
    const l = lineas[i];
    if (l.includes("!isTakingExam")) return true;
    if (i < idx && l.trim().startsWith(")}")) return false;
  }
  return false;
}

describe("mensajería durante un examen", () => {
  const lineas = SRC.split("\n");

  for (const nombre of SUPERFICIES) {
    it(`cada montaje de ${nombre} está detrás de isTakingExam`, () => {
      const montajes = lineas
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.includes(`<${nombre}`));

      expect(montajes.length, `no se encontró ningún montaje de ${nombre}`).toBeGreaterThan(0);

      for (const { i } of montajes) {
        expect(
          estaDetrasDelGuard(lineas, i),
          `${nombre} en la línea ${i + 1} de AppLayout.tsx se monta SIN guard de examen. ` +
            `Durante un examen no puede quedar ninguna puerta a mensajes o notificaciones: ` +
            `son <Link> del router, así que salir por ahí no dispara beforeunload ni popstate ` +
            `y no cuesta ninguna advertencia.`,
        ).toBe(true);
      }
    });
  }

  it("el examen colapsa el sidebar, que es lo que hacía aparecer el flotante", () => {
    // Si esto cambiara, el agujero dejaría de ser alcanzable por esa vía — pero
    // el guard tiene que seguir igual, porque el flotante también sale solo en
    // móvil, donde el sidebar es un cajón cerrado por defecto.
    expect(SRC).toMatch(/if \(isTakingExam\) setSidebarCollapsed\(true\);/);
  });
});
