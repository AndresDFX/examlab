import { describe, expect, it } from "vitest";
import {
  ATTR_ACCION,
  CLASE_RANURA,
  codigoVerificacion,
  firmaHtml,
  ranuraPlantillaHtml,
  renderizarRanuras,
  tieneRanuras,
  type FirmaDeInforme,
} from "./signature-slots";

const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "22222222-2222-4222-8222-222222222222";

/** El HTML como queda en el snapshot: la ranura ya con el uid resuelto. */
function snapshot(...uids: string[]): string {
  return uids
    .map(
      (u) =>
        `<tr><td>Nombre</td><td><span class="${CLASE_RANURA}" data-firma-uid="${u}"` +
        ' style="display:block;min-height:30px;">&nbsp;</span></td></tr>',
    )
    .join("");
}

const firma = (over: Partial<FirmaDeInforme> = {}): FirmaDeInforme => ({
  id: "3f9a2c4d-0000-4000-8000-000000000000",
  user_id: ANA,
  nombre: "Ana Gómez",
  signed_at: "2026-08-27T14:30:00Z",
  ...over,
});

describe("ranuraPlantillaHtml", () => {
  it("deja {{user_id}} sin resolver para que lo llene el motor por estudiante", () => {
    // Si acá viniera ya resuelto, todas las filas apuntarían al mismo firmante.
    expect(ranuraPlantillaHtml()).toContain("{{user_id}}");
  });

  it("le da alto mínimo, que es lo que deja lugar para firmar a mano", () => {
    expect(ranuraPlantillaHtml()).toContain("min-height:30px");
  });
});

describe("codigoVerificacion", () => {
  it("son los primeros 6 hex del id, en mayúsculas y sin guiones", () => {
    expect(codigoVerificacion("3f9a2c4d-0000-4000-8000-000000000000")).toBe("3F9A2C");
  });

  it("es estable: el mismo documento reimpreso muestra el mismo código", () => {
    const id = "abcdef12-3456-4000-8000-000000000000";
    expect(codigoVerificacion(id)).toBe(codigoVerificacion(id));
  });

  it("no se cae con un id vacío", () => {
    expect(codigoVerificacion("")).toBe("");
  });
});

describe("renderizarRanuras — estado FIRMADA", () => {
  it("dibuja nombre, fecha y código en el renglón de esa persona", () => {
    const h = renderizarRanuras(snapshot(ANA), { firmas: [firma()] });
    expect(h).toContain("Ana Gómez");
    expect(h).toContain("3F9A2C");
    // La fecha pasa por el formateador del proyecto (es-CO) y no sale el ISO
    // crudo. No se fija el formato exacto —hoy es "27 de ago de 2026, 09:30",
    // con la hora ya en la zona de Bogotá— para no romper este test si el
    // formateador cambia de estilo: lo que se afirma es que PASÓ por él.
    expect(h).toMatch(/ago.*2026/);
    expect(h).not.toContain("2026-08-27T14:30:00Z");
  });

  it("solo llena la ranura de quien firmó, no las de los demás", () => {
    const h = renderizarRanuras(snapshot(ANA, BETO), { firmas: [firma()] });
    expect(h).toContain("Ana Gómez");
    // La de Beto queda en blanco: una firma no puede aparecer en la fila de otro.
    const filaBeto = h.split(BETO)[1] ?? "";
    expect(filaBeto).not.toContain("Ana Gómez");
  });

  it("una solicitud SIN firmar no dibuja nada, aunque venga en la lista", () => {
    const h = renderizarRanuras(snapshot(ANA), { firmas: [firma({ signed_at: null })] });
    expect(h).not.toContain("Ana Gómez");
    expect(h).not.toContain("3F9A2C");
  });

  it("sin nombre cargado pone un guión, no 'null'", () => {
    const h = renderizarRanuras(snapshot(ANA), { firmas: [firma({ nombre: null })] });
    expect(h).not.toContain("null");
    expect(h).toContain("—");
  });

  it("escapa el nombre: un nombre con HTML no puede inyectar marcado", () => {
    const h = renderizarRanuras(snapshot(ANA), {
      firmas: [firma({ nombre: "<img src=x onerror=alert(1)>" })],
    });
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });
});

describe("renderizarRanuras — estado PENDIENTE", () => {
  it("deja la ranura en blanco, que es lo que hace que el papel siga sirviendo", () => {
    const h = renderizarRanuras(snapshot(ANA, BETO));
    expect(h).not.toContain(ATTR_ACCION);
    expect(h).toContain("&nbsp;");
    // Y no se pierde la ranura: el documento se puede volver a firmar después.
    expect(tieneRanuras(h)).toBe(true);
  });

  it("preserva la etiqueta de apertura tal como venía en el snapshot", () => {
    // El snapshot es inmutable —el hash de la firma se calcula sobre él—, así que
    // renderizar no puede reescribir sus atributos.
    const h = renderizarRanuras(snapshot(ANA), { firmas: [firma()] });
    expect(h).toContain(`data-firma-uid="${ANA}"`);
    expect(h).toContain("min-height:30px");
  });
});

describe("renderizarRanuras — estado FIRMABLE (el aporte de este cambio)", () => {
  it("pone el botón SOLO en el renglón de quien está mirando", () => {
    const h = renderizarRanuras(snapshot(ANA, BETO), { firmanteId: ANA });
    const [, filaAna, filaBeto] = h.split(/data-firma-uid="/);
    expect(filaAna).toContain(ATTR_ACCION);
    expect(filaBeto).not.toContain(ATTR_ACCION);
  });

  it("si ya firmó, muestra su firma y NO el botón", () => {
    const h = renderizarRanuras(snapshot(ANA), { firmanteId: ANA, firmas: [firma()] });
    expect(h).toContain("Ana Gómez");
    expect(h).not.toContain(ATTR_ACCION);
  });

  it("nadie puede firmar la ranura de otro: sin firmanteId no hay ningún botón", () => {
    // Es el caso de la vista del docente, la descarga y la impresión.
    const h = renderizarRanuras(snapshot(ANA, BETO), { firmas: [] });
    expect(h).not.toContain(ATTR_ACCION);
  });

  it("un firmanteId que no está en el documento no agrega ningún botón", () => {
    const h = renderizarRanuras(snapshot(ANA), { firmanteId: BETO });
    expect(h).not.toContain(ATTR_ACCION);
  });

  it("usa la etiqueta traducida que le pasa la pantalla", () => {
    const h = renderizarRanuras(snapshot(ANA), {
      firmanteId: ANA,
      etiquetaFirmar: "Sign here",
    });
    expect(h).toContain("Sign here");
  });
});

describe("renderizarRanuras — invariantes", () => {
  it("es idempotente: aplicarlo dos veces da lo mismo", () => {
    // La pantalla del estudiante lo re-ejecuta al firmar, sobre el mismo HTML.
    const una = renderizarRanuras(snapshot(ANA, BETO), { firmas: [firma()], firmanteId: BETO });
    const dos = renderizarRanuras(una, { firmas: [firma()], firmanteId: BETO });
    expect(dos).toBe(una);
  });

  it("no toca el resto del documento", () => {
    const html = `<h1>ACUERDO PEDAGÓGICO</h1>${snapshot(ANA)}<p>Firma del docente</p>`;
    const h = renderizarRanuras(html, { firmas: [firma()] });
    expect(h).toContain("<h1>ACUERDO PEDAGÓGICO</h1>");
    expect(h).toContain("<p>Firma del docente</p>");
  });

  it("un documento sin ranuras pasa intacto", () => {
    const html = "<p>Un informe viejo, generado antes de las firmas.</p>";
    expect(renderizarRanuras(html, { firmas: [firma()] })).toBe(html);
    expect(tieneRanuras(html)).toBe(false);
  });

  it("html vacío o nulo no rompe", () => {
    expect(renderizarRanuras("")).toBe("");
    expect(tieneRanuras(null)).toBe(false);
    expect(tieneRanuras(undefined)).toBe(false);
  });
});

describe("firmaHtml", () => {
  it("sin fecha no imprime una fecha vacía con formato raro", () => {
    const h = firmaHtml(firma({ signed_at: null }));
    expect(h).toContain("Ana Gómez");
    expect(h).not.toContain("Invalid");
    expect(h).not.toContain("NaN");
  });
});
