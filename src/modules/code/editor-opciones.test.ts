import { describe, expect, it } from "vitest";

import { escalarAltoEditor } from "./editor-zoom";
import {
  altoDeEditorEnPantalla,
  esPantallaAngosta,
  opcionesBaseDeEditor,
  OPCIONES_EN_PANTALLA_ANGOSTA,
} from "./editor-opciones";

const TELEFONO = { ancho: 390, alto: 844 };
const TELEFONO_ACOSTADO = { ancho: 844, alto: 390 };
const ESCRITORIO = { ancho: 1280, alto: 800 };

describe("esPantallaAngosta", () => {
  it("sin medir todavía NO es angosta: el primer render tiene que ser el de escritorio", () => {
    // Si `null` contara como angosta, el HTML prerenderizado saldría con el
    // editor de teléfono y al hidratar cambiaría — el mismatch de React #418.
    expect(esPantallaAngosta(null)).toBe(false);
  });

  it("corta en el breakpoint sm de Tailwind", () => {
    expect(esPantallaAngosta({ ancho: 639, alto: 800 })).toBe(true);
    expect(esPantallaAngosta({ ancho: 640, alto: 800 })).toBe(false);
  });

  it("un teléfono acostado ya no es angosto", () => {
    expect(esPantallaAngosta(TELEFONO_ACOSTADO)).toBe(false);
  });
});

describe("altoDeEditorEnPantalla", () => {
  it("en escritorio devuelve lo que pidió el caller", () => {
    expect(altoDeEditorEnPantalla("250px", ESCRITORIO)).toBe("250px");
  });

  it("antes de medir devuelve lo que pidió el caller", () => {
    expect(altoDeEditorEnPantalla("250px", null)).toBe("250px");
  });

  it("en un teléfono sube a la mitad de la ventana", () => {
    expect(altoDeEditorEnPantalla("250px", TELEFONO)).toBe("422px");
  });

  it("NUNCA achica: con una ventana baja queda el alto pedido", () => {
    // Pantalla dividida / teclado abierto: la mitad de 420 son 210, menos que
    // los 250 que pedía el caller. Un editor calculado más chico que el fijo
    // sería peor que no hacer nada.
    expect(altoDeEditorEnPantalla("250px", { ancho: 390, alto: 420 })).toBe("250px");
  });

  it("deja en paz un alto que ya es relativo", () => {
    // La hoja de código de la pizarra pide "55vh": ya se adapta sola.
    expect(altoDeEditorEnPantalla("55vh", TELEFONO)).toBe("55vh");
    expect(altoDeEditorEnPantalla("100%", TELEFONO)).toBe("100%");
    expect(altoDeEditorEnPantalla("20rem", TELEFONO)).toBe("20rem");
  });

  it("deja en paz lo que no sabe leer en vez de inventar un alto", () => {
    expect(altoDeEditorEnPantalla("auto", TELEFONO)).toBe("auto");
    expect(altoDeEditorEnPantalla("calc(100% - 2rem)", TELEFONO)).toBe("calc(100% - 2rem)");
    expect(altoDeEditorEnPantalla("", TELEFONO)).toBe("");
  });

  it("tolera espacios alrededor", () => {
    expect(altoDeEditorEnPantalla("  280px ", TELEFONO)).toBe("422px");
  });

  it("el zoom sigue escalando el alto que resultó del teléfono", () => {
    // Los dos helpers se componen en ese orden en los tres editores: primero el
    // piso de la pantalla, después el zoom. Si se invirtieran, el zoom quedaría
    // pisado por el piso y subir la letra no agrandaría el recuadro.
    expect(escalarAltoEditor(altoDeEditorEnPantalla("250px", TELEFONO), 1.5)).toBe("633px");
    expect(escalarAltoEditor(altoDeEditorEnPantalla("250px", ESCRITORIO), 1.5)).toBe("375px");
  });
});

describe("opcionesBaseDeEditor", () => {
  it("la letra escala con el zoom", () => {
    expect(opcionesBaseDeEditor({ zoom: 1, readOnly: false }).fontSize).toBe(13);
    expect(opcionesBaseDeEditor({ zoom: 1.5, readOnly: false }).fontSize).toBe(20);
  });

  it("pasa el solo-lectura", () => {
    expect(opcionesBaseDeEditor({ zoom: 1, readOnly: true }).readOnly).toBe(true);
  });
});

describe("OPCIONES_EN_PANTALLA_ANGOSTA", () => {
  it("solo QUITA adorno: no toca ninguna opción que cambie el comportamiento", () => {
    // El recorte se esparce ENCIMA de las opciones base. Si alguna vez se le
    // colara una de estas cuatro, en un teléfono el editor se volvería
    // editable en una revisión (`readOnly`), perdería el ajuste de línea, se
    // quedaría con la letra sin zoom o dejaría de recalcular su tamaño — y
    // solo pasaría en teléfono, así que nadie lo vería probando en el monitor.
    const base = Object.keys(opcionesBaseDeEditor({ zoom: 1, readOnly: false }));
    const recorte = Object.keys(OPCIONES_EN_PANTALLA_ANGOSTA);
    expect(recorte.filter((k) => base.includes(k))).toEqual([]);
    for (const clave of ["readOnly", "wordWrap", "fontSize", "automaticLayout"]) {
      expect(recorte).not.toContain(clave);
    }
  });

  it("los números de línea conservan separación del código", () => {
    // Con 2 px el número queda pegado al texto y «11}» se lee como un token.
    expect(OPCIONES_EN_PANTALLA_ANGOSTA.lineDecorationsWidth).toBeGreaterThanOrEqual(8);
  });
});
