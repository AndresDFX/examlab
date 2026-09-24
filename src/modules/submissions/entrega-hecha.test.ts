import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { isSubmittedStatus } from "@/modules/courses/diagnostic";
import {
  ESTADOS_SIN_ENTREGAR,
  entregaHecha,
  esEstadoDeEntrega,
  estaVencido,
} from "./entrega-hecha";

describe("entregaHecha", () => {
  it("sin fila, no entregó", () => {
    expect(entregaHecha(null)).toBe(false);
    expect(entregaHecha(undefined)).toBe(false);
  });

  it.each(["entregado", "calificado", "ai_revisado", "requiere_revision", "completado", "sospechoso"])(
    "'%s' cuenta como entregado",
    (status) => {
      expect(entregaHecha({ status })).toBe(true);
    },
  );

  it.each(ESTADOS_SIN_ENTREGAR)("'%s' NO cuenta como entregado", (status) => {
    expect(entregaHecha({ status })).toBe(false);
  });

  it("un estado DESCONOCIDO cuenta como entregado", () => {
    // La razón de ser del módulo: `ai_revisado` era «desconocido» para la
    // pantalla del estudiante y por eso 37 entregas reales salían vencidas.
    // Los estados nuevos de estas tablas nacen del pipeline de calificación,
    // o sea DESPUÉS de entregar.
    expect(entregaHecha({ status: "revisado_por_pares_2027" })).toBe(true);
  });
});

describe("estaVencido — pasó el plazo Y no entregó", () => {
  const ahora = new Date("2026-09-23T12:00:00Z").getTime();
  const ayer = "2026-09-22T12:00:00Z";
  const manana = "2026-09-24T12:00:00Z";

  it("plazo pasado y sin entrega: vencido", () => {
    expect(estaVencido({ plazo: ayer, entrega: null, ahora })).toBe(true);
  });

  it("plazo pasado pero YA entregó: NO vencido", () => {
    // El caso reportado. Vale para cualquier estado posterior a la entrega.
    for (const status of ["entregado", "calificado", "ai_revisado"]) {
      expect(estaVencido({ plazo: ayer, entrega: { status }, ahora })).toBe(false);
    }
  });

  it("plazo pasado con la entrega solo INICIADA: vencido", () => {
    // Abrir no es entregar.
    expect(estaVencido({ plazo: ayer, entrega: { status: "iniciado" }, ahora })).toBe(true);
  });

  it("plazo futuro sin entregar: todavía no vence", () => {
    expect(estaVencido({ plazo: manana, entrega: null, ahora })).toBe(false);
  });

  it("sin plazo, nada vence", () => {
    expect(estaVencido({ plazo: null, entrega: null, ahora })).toBe(false);
    expect(estaVencido({ plazo: undefined, entrega: null, ahora })).toBe(false);
  });

  it("una fecha ilegible NO vence", () => {
    // Marcar «Vencido» por no haber podido leer una fecha es el peor resultado.
    expect(estaVencido({ plazo: "no es una fecha", entrega: null, ahora })).toBe(false);
  });

  it("justo en el límite todavía no vence", () => {
    expect(estaVencido({ plazo: "2026-09-23T12:00:00Z", entrega: null, ahora })).toBe(false);
  });
});

describe("una sola lista en todo el proyecto", () => {
  it("el `isSubmittedStatus` del diagnóstico del docente ES este predicado", () => {
    // La lista vivía SOLO dentro del módulo del docente, así que las pantallas
    // del estudiante no la encontraban y se escribieron una lista blanca de dos
    // estados. Dos listas que se contradicen es justo lo que produjo el bug.
    expect(isSubmittedStatus).toBe(esEstadoDeEntrega);
  });

  it("cubre los estados de borrador de las tres tablas de entregas", () => {
    // exámenes crean la fila al INICIAR; talleres y proyectos, al entregar.
    for (const s of ["en_progreso", "iniciado", "borrador", "draft", "pendiente", "no_entregado"]) {
      expect(ESTADOS_SIN_ENTREGAR).toContain(s);
    }
  });
});

describe("espejo en SQL", () => {
  it("`estado_es_entrega` de la migración lista los MISMOS estados", () => {
    // El cron de «vence pronto» excluye con esta función a quien ya entregó.
    // Si las listas divergen, el correo del servidor y la pantalla del alumno
    // se contradicen sobre la misma entrega — el síntoma exacto que el fix
    // vino a cerrar. Se busca la ÚLTIMA migración que la define, no un nombre
    // fijo: con un nombre fijo, la migración siguiente que cambie el set
    // dejaría al test leyendo una versión vieja y pasando en verde contra
    // ella. Mismo patrón que `proctoring.test.ts`.
    const dir = "supabase/migrations";
    const archivo = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse()
      .find((f) =>
        fs
          .readFileSync(path.join(dir, f), "utf8")
          .includes("FUNCTION public.estado_es_entrega"),
      );
    expect(archivo, "ninguna migración define estado_es_entrega").toBeTruthy();

    const sql = fs.readFileSync(path.join(dir, archivo!), "utf8");
    const m = sql.match(/NOT IN \(([^)]*)\)/);
    expect(m, "no se encontró la lista de estados en la función").toBeTruthy();
    const enSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(enSql).toEqual([...ESTADOS_SIN_ENTREGAR].sort());
  });
});
