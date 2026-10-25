import { describe, it, expect } from "vitest";
// Se importa del edge por ruta relativa: es la lista que de verdad aplican
// `calendar` (init) y `calendar-oauth-callback`.
import {
  esOrigenPermitido,
  origenDeVuelta,
  ORIGEN_GENERAL,
} from "../../../supabase/functions/_shared/origen-permitido.ts";

describe("esOrigenPermitido (a dónde vuelve el OAuth del calendario)", () => {
  it("acepta el Worker de cada institución y el general", () => {
    for (const o of [
      "https://uniaj.examlab.workers.dev",
      "https://app.examlab.workers.dev",
      "https://fesna.examlab.workers.dev",
      "https://demo-global-corp.examlab.workers.dev",
      "https://examlab-demo.examlab.workers.dev",
    ]) {
      expect(esOrigenPermitido(o), o).toBe(true);
    }
  });

  it("mira solo el origen, no la ruta", () => {
    expect(esOrigenPermitido("https://uniaj.examlab.workers.dev/app/teacher/calendar")).toBe(true);
  });

  it("acepta el desarrollo local y el sitio viejo de Lovable", () => {
    expect(esOrigenPermitido("http://localhost:8080")).toBe(true);
    expect(esOrigenPermitido("http://localhost")).toBe(true);
    expect(esOrigenPermitido("https://examlab.lovable.app")).toBe(true);
  });

  it("rechaza dominios que se parecen pero no son nuestros", () => {
    for (const o of [
      "https://uniaj.examlab.workers.dev.otro.com",
      "https://uniaj.examlab.workers.dev@otro.com",
      "https://uniaj.otracuenta.workers.dev",
      "https://examlab.workers.dev",
      "https://x.uniaj.examlab.workers.dev",
      "https://examlabworkers.dev",
      "http://localhost.otro.com",
      // Cualquiera crea un proyecto en lovable.app: solo vale el nuestro.
      "https://otro-proyecto.lovable.app",
      "https://abc.lovableproject.com",
    ]) {
      expect(esOrigenPermitido(o), o).toBe(false);
    }
  });

  it("rechaza http en producción y lo que no es una URL", () => {
    expect(esOrigenPermitido("http://uniaj.examlab.workers.dev")).toBe(false);
    expect(esOrigenPermitido("javascript:alert(1)")).toBe(false);
    expect(esOrigenPermitido("no es una url")).toBe(false);
    expect(esOrigenPermitido("")).toBe(false);
  });
});

describe("origenDeVuelta (la redirección del callback)", () => {
  it("vuelve al origen pedido, sin ruta ni consulta", () => {
    expect(origenDeVuelta("https://uniaj.examlab.workers.dev/x?y=1")).toBe(
      "https://uniaj.examlab.workers.dev",
    );
  });

  it("cualquier otro destino cae al Worker general, nunca a un sitio ajeno", () => {
    // Lo que llega decodificado del `state` de una URL armada a mano.
    expect(origenDeVuelta("https://otro.com")).toBe(ORIGEN_GENERAL);
    // El dominio de Supabase, que era el respaldo cuando el state no decodificaba.
    expect(origenDeVuelta("https://uxxpzfsfcnqiwwdxoelm.supabase.co")).toBe(ORIGEN_GENERAL);
    expect(origenDeVuelta(null)).toBe(ORIGEN_GENERAL);
    expect(origenDeVuelta("")).toBe(ORIGEN_GENERAL);
  });

  it("el respaldo también está en la lista", () => {
    expect(esOrigenPermitido(ORIGEN_GENERAL)).toBe(true);
  });
});
