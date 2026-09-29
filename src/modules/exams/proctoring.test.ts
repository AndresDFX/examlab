import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  GRACIA_OCULTO_MOVIL_MS,
  TIPOS_QUE_SUMAN_STRIKE,
  MAX_WARNINGS,
  avisaDelLimite,
  blurCuentaComoStrike,
  contarAdvertencia,
  suspendePorAdvertencias,
  creaVentanasDeProctoring,
  isStrikeEvent,
  eventoSumoStrike,
  pegarCuentaComoStrike,
  TIPOS_DONDE_PEGAR_ES_NORMAL,
  ocultarCuentaComoStrike,
  salidaDePantallaCompletaCuentaComoStrike,
  shouldMarkSuspicious,
  type WarningEvent,
  warningEventTimestamp,
  warningLabel,
  permiteMenuContextual,
} from "./proctoring";

describe("shouldMarkSuspicious", () => {
  it("is false while warnings are under the threshold", () => {
    expect(shouldMarkSuspicious(0)).toBe(false);
    expect(shouldMarkSuspicious(1)).toBe(false);
    expect(shouldMarkSuspicious(2)).toBe(false);
  });

  it("flips to true when warnings reach the configured max", () => {
    expect(shouldMarkSuspicious(MAX_WARNINGS)).toBe(true);
    expect(shouldMarkSuspicious(MAX_WARNINGS + 1)).toBe(true);
  });

  it("accepts a custom threshold", () => {
    expect(shouldMarkSuspicious(4, 5)).toBe(false);
    expect(shouldMarkSuspicious(5, 5)).toBe(true);
  });

  it("treats the default MAX_WARNINGS as 3", () => {
    expect(MAX_WARNINGS).toBe(3);
  });
});

describe("warningLabel", () => {
  it("maps Spanish take-flow keys to Spanish labels", () => {
    expect(warningLabel("pestaña")).toBe("Salida de pestaña/ventana");
    expect(warningLabel("copiar")).toBe("Intento de copiar");
    expect(warningLabel("pegar")).toBe("Intento de pegar");
    expect(warningLabel("cortar")).toBe("Intento de cortar");
    expect(warningLabel("menu")).toBe("Menú contextual");
  });

  it("maps legacy English monitor keys to the same Spanish labels", () => {
    expect(warningLabel("blur")).toBe("Salida de pestaña/ventana");
    expect(warningLabel("copy")).toBe("Intento de copiar");
    expect(warningLabel("paste")).toBe("Intento de pegar");
    expect(warningLabel("context_menu")).toBe("Menú contextual");
  });

  it("covers visibility and fullscreen events", () => {
    expect(warningLabel("visibility_hidden")).toBe("Pestaña oculta");
    expect(warningLabel("fullscreen_exit")).toBe("Salida de pantalla completa");
  });

  it("falls back to the raw type for unknown keys", () => {
    expect(warningLabel("some_future_type")).toBe("some_future_type");
  });
});

describe("warningEventTimestamp", () => {
  it("reads numeric ts (ms)", () => {
    const ev: WarningEvent = { type: "blur", ts: 1_700_000_000_000 };
    expect(warningEventTimestamp(ev)).toBe(1_700_000_000_000);
  });

  it("reads numeric at (ms)", () => {
    const ev: WarningEvent = { type: "blur", at: 1_700_000_000_000 };
    expect(warningEventTimestamp(ev)).toBe(1_700_000_000_000);
  });

  it("parses ISO at strings", () => {
    const iso = "2026-04-20T12:34:56.000Z";
    const ev: WarningEvent = { type: "pestaña", at: iso };
    expect(warningEventTimestamp(ev)).toBe(Date.parse(iso));
  });

  it("returns null for invalid / missing timestamps", () => {
    expect(warningEventTimestamp({ type: "blur" })).toBeNull();
    expect(warningEventTimestamp({ type: "blur", at: "not-a-date" })).toBeNull();
  });
});

describe("proctoring flow simulation", () => {
  /**
   * Mirrors how the take-flow increments warnings on window blur / visibility
   * events and flips the submission into "sospechoso" once the threshold is
   * reached. The utilities are pure, so we reproduce the loop without needing
   * a full React render.
   */
  it("increments the counter and flips to suspicious at MAX_WARNINGS", () => {
    const events: WarningEvent[] = [
      { type: "pestaña", at: new Date().toISOString() },
      { type: "copiar", at: new Date().toISOString() },
      { type: "pestaña", at: new Date().toISOString() },
    ];

    let warnings = 0;
    let suspicious = false;
    for (const ev of events) {
      warnings += 1;
      expect(warningLabel(ev.type)).toBeTruthy();
      if (shouldMarkSuspicious(warnings)) suspicious = true;
    }

    expect(warnings).toBe(3);
    expect(suspicious).toBe(true);
  });

  it("stays within bounds for 2 warnings (autosave but not suspended)", () => {
    const warnings = 2;
    expect(shouldMarkSuspicious(warnings)).toBe(false);
  });
});

describe("blurCuentaComoStrike", () => {
  it("en un teléfono o tableta, el blur suelto NO suma strike", () => {
    // Es lo que produce la burbuja del corrector ortográfico al tocar una
    // palabra subrayada: corregir una palabra no puede costar un strike.
    expect(blurCuentaComoStrike({ punteroGrueso: true, punteroFino: false })).toBe(false);
  });

  it("en un computador SÍ suma: ahí el blur es la única señal del alt+tab", () => {
    expect(blurCuentaComoStrike({ punteroGrueso: false, punteroFino: true })).toBe(true);
  });

  it("un portátil con pantalla táctil sigue contando como computador", () => {
    // Tiene los dos punteros y el alt+tab sigue siendo posible.
    expect(blurCuentaComoStrike({ punteroGrueso: true, punteroFino: true })).toBe(true);
  });

  it("sin información de puntero, falla del lado seguro (cuenta)", () => {
    expect(blurCuentaComoStrike({ punteroGrueso: false, punteroFino: false })).toBe(true);
  });

  it("salir de la app en móvil SIGUE sumando por la otra vía", () => {
    // `visibility_hidden` es lo que dispara cambiar de app en un teléfono, y
    // se mantiene en el set de tipos que suman: el proctoring no se debilita.
    expect(isStrikeEvent("visibility_hidden")).toBe(true);
    expect(isStrikeEvent("fullscreen_exit")).toBe(true);
  });

  it("el pantallazo y el botón «atrás» SUMAN", () => {
    // `retroceso` sumaba desde siempre —la pantalla de toma incrementa el
    // contador al confirmar el diálogo— pero estaba fuera de la lista, así que
    // perdonarlo desde el monitor borraba la fila y dejaba el strike puesto.
    expect(isStrikeEvent("retroceso")).toBe(true);
    expect(isStrikeEvent("pantallazo")).toBe(true);
  });

  it("copiar y pegar NO suman: en una pregunta de código son parte de responder", () => {
    for (const t of ["copiar", "pegar", "cortar"]) expect(isStrikeEvent(t)).toBe(false);
  });

  it("la clave VIEJA del pantallazo sigue sin sumar", () => {
    // Hay 11 `screenshot_attempt` en producción que nunca sumaron. Si esta clave
    // pasara a sumar, perdonar uno de esos once DESCONTARÍA un strike que no
    // existió, y si eso baja del umbral des-suspende a un alumno.
    expect(isStrikeEvent("screenshot_attempt")).toBe(false);
  });

  // El mismo set vive en SQL (`_exam_warning_is_strike`), que es lo que usa
  // `teacher_clear_exam_warnings` para decidir si descuenta. Si divergen, el
  // monitor muestra una cosa y la base hace otra con el expediente del alumno.
  it("el set coincide con el espejo en SQL, leído de la migración", () => {
    // Se busca la ÚLTIMA migración que define la función, no un nombre fijo:
    // con el archivo escrito a mano, la migración siguiente que cambie el set
    // dejaría al test leyendo una versión vieja y pasando en verde contra ella
    // — que es justo el modo de falla que este test existe para tapar. Mismo
    // patrón que `page-types.test.ts`.
    const dir = "supabase/migrations";
    const archivo = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse()
      .find((f) =>
        fs.readFileSync(path.join(dir, f), "utf8").includes(
          "FUNCTION public._exam_warning_is_strike",
        ),
      );
    expect(archivo, "ninguna migración define _exam_warning_is_strike").toBeTruthy();

    const sql = fs.readFileSync(path.join(dir, archivo!), "utf8");
    const m = sql.match(/_type IN \(([^)]*)\)/);
    expect(m, "no se encontró la lista en la migración").not.toBeNull();
    const enSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();

    // Contra el set REAL, no contra una copia escrita en el test: si alguien
    // agrega un tipo de un solo lado, con una copia los dos seguirían
    // coincidiendo entre sí y nadie se enteraría.
    expect(enSql).toEqual([...TIPOS_QUE_SUMAN_STRIKE].sort());
    for (const t of enSql) expect(isStrikeEvent(t), t).toBe(true);
  });

  it("y `eventoSumoStrike` coincide con SU espejo: la marca gana, el tipo respalda", () => {
    // La hermana del espejo de arriba. Desde que pegar puede sumar o no según la
    // pregunta, el tipo dejó de alcanzar y la decisión pasó a mirar el EVENTO.
    // Si el cliente y el servidor no la toman igual, perdonar una advertencia
    // descuenta distinto de lo que la pantalla acaba de mostrar.
    const dir = "supabase/migrations";
    const archivo = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse()
      .find((f) =>
        fs.readFileSync(path.join(dir, f), "utf8").includes(
          "FUNCTION public._exam_warning_event_is_strike",
        ),
      );
    expect(archivo, "ninguna migración define _exam_warning_event_is_strike").toBeTruthy();

    const sql = fs.readFileSync(path.join(dir, archivo!), "utf8");
    // El orden importa: `suma` PRIMERO dentro del COALESCE. Al revés, el tipo
    // ganaría siempre y la marca no serviría para nada.
    const cuerpo = /_exam_warning_event_is_strike[\s\S]*?COALESCE\(([\s\S]*?)\);/.exec(sql);
    expect(cuerpo, "no se encontró el cuerpo de la función").not.toBeNull();
    const dentro = cuerpo![1];
    expect(dentro.indexOf("'suma'")).toBeGreaterThan(-1);
    expect(dentro.indexOf("_exam_warning_is_strike")).toBeGreaterThan(dentro.indexOf("'suma'"));

    // Y el lado TS se comporta igual, contra la función real.
    expect(eventoSumoStrike({ type: "copiar", suma: true })).toBe(true);
    expect(eventoSumoStrike({ type: "pestaña", suma: false })).toBe(false);
    expect(eventoSumoStrike({ type: "pestaña" })).toBe(true);
  });
});

describe("creaVentanasDeProctoring", () => {
  it("una señal blanda NO puede tragarse el strike que viene detrás", () => {
    // La secuencia real de un cambio de app en un teléfono: primero `blur`
    // (blanda, por el arreglo del corrector) y enseguida `visibilitychange`
    // (strike). Con una sola ventana compartida, el strike se perdía.
    const v = creaVentanasDeProctoring(500);
    expect(v.permiteBlanda(1000)).toBe(true);
    expect(v.permiteStrike(1050)).toBe(true);
  });

  it("y un strike tampoco silencia la señal blanda", () => {
    const v = creaVentanasDeProctoring(500);
    expect(v.permiteStrike(1000)).toBe(true);
    expect(v.permiteBlanda(1050)).toBe(true);
  });

  it("cada clase sí se deduplica contra sí misma", () => {
    const v = creaVentanasDeProctoring(500);
    expect(v.permiteStrike(1000)).toBe(true);
    expect(v.permiteStrike(1200)).toBe(false);
    expect(v.permiteStrike(1600)).toBe(true);
    expect(v.permiteBlanda(1000)).toBe(true);
    expect(v.permiteBlanda(1200)).toBe(false);
  });
});

describe("qué cuenta como strike en un teléfono", () => {
  const movil = { punteroGrueso: true, punteroFino: false };
  const computador = { punteroGrueso: false, punteroFino: true };
  // Un portátil con pantalla táctil: tiene los dos punteros y sigue siendo un
  // computador (el alt+tab existe).
  const portatilTactil = { punteroGrueso: true, punteroFino: true };

  it("perder la pantalla completa no suma en un teléfono, sí en un computador", () => {
    expect(salidaDePantallaCompletaCuentaComoStrike(movil)).toBe(false);
    expect(salidaDePantallaCompletaCuentaComoStrike(computador)).toBe(true);
    expect(salidaDePantallaCompletaCuentaComoStrike(portatilTactil)).toBe(true);
  });

  it("en computador, ocultarse suma siempre — sin esperar", () => {
    // Ahí ocultarse ES cambiar de pestaña; no hay burbujas del sistema de por
    // medio y el menú contextual está bloqueado.
    expect(ocultarCuentaComoStrike(computador, 0)).toBe(true);
    expect(ocultarCuentaComoStrike(portatilTactil, 10)).toBe(true);
  });

  it("en móvil, ocultarse un instante NO suma; quedarse oculto SÍ", () => {
    // Las tres primeras son las diferencias REALES medidas en producción entre
    // el `blur` de la corrección y el ocultamiento que lo acompaña.
    expect(ocultarCuentaComoStrike(movil, 0)).toBe(false);
    expect(ocultarCuentaComoStrike(movil, 1000)).toBe(false);
    expect(ocultarCuentaComoStrike(movil, 2000)).toBe(false);
    // Irse a otra aplicación de verdad deja el documento oculto mucho más.
    expect(ocultarCuentaComoStrike(movil, GRACIA_OCULTO_MOVIL_MS)).toBe(true);
    expect(ocultarCuentaComoStrike(movil, 30_000)).toBe(true);
  });

  it("la gracia es corta: no alcanza para mirar nada", () => {
    // Si alguien la sube, que sea una decisión consciente: con 10 s se puede
    // leer un mensaje entero y volver sin que quede registro de strike.
    expect(GRACIA_OCULTO_MOVIL_MS).toBeLessThanOrEqual(3000);
  });

  it("las señales blandas nuevas NO suman strike", () => {
    expect(isStrikeEvent("oculto_breve_movil")).toBe(false);
    expect(isStrikeEvent("fullscreen_exit_movil")).toBe(false);
    // Y las que sí suman siguen sumando.
    expect(isStrikeEvent("visibility_hidden")).toBe(true);
    expect(isStrikeEvent("fullscreen_exit")).toBe(true);
  });

  it("las señales blandas nuevas tienen etiqueta legible y dicen que no suman", () => {
    for (const t of ["oculto_breve_movil", "fullscreen_exit_movil"] as const) {
      const etiqueta = warningLabel(t);
      expect(etiqueta).not.toBe(t);
      expect(etiqueta).toContain("no suma");
    }
  });
});

describe("permiteMenuContextual — el corrector ortográfico vive en ese menú", () => {
  const hacer = (html: string, selector: string): HTMLElement => {
    document.body.innerHTML = html;
    const el = document.body.querySelector(selector);
    if (!el) throw new Error(`no se encontró ${selector}`);
    return el as HTMLElement;
  };

  it("SÍ sobre el área de respuesta abierta", () => {
    // El caso que originó el cambio: el navegador subrayaba la palabra en rojo
    // y el estudiante no tenía cómo aceptar la corrección.
    expect(permiteMenuContextual(hacer("<textarea></textarea>", "textarea"))).toBe(true);
  });

  it("SÍ sobre un input de texto y sobre uno sin `type`", () => {
    expect(permiteMenuContextual(hacer('<input type="text">', "input"))).toBe(true);
    expect(permiteMenuContextual(hacer("<input>", "input"))).toBe(true);
  });

  it("SÍ dentro del editor de código, incluso en un hijo hondo", () => {
    const el = hacer(
      '<div class="monaco-editor"><div><span id="t">x</span></div></div>',
      "#t",
    );
    expect(permiteMenuContextual(el)).toBe(true);
  });

  it("SÍ sobre un contenteditable", () => {
    expect(
      permiteMenuContextual(hacer('<div contenteditable="true"></div>', "div")),
    ).toBe(true);
  });

  it("NO sobre el enunciado", () => {
    // Ahí el menú no aporta nada al examen y sí ofrece «abrir en otra pestaña».
    expect(permiteMenuContextual(hacer("<p>Enunciado</p>", "p"))).toBe(false);
  });

  it("NO sobre una imagen del enunciado ni sobre una casilla", () => {
    expect(permiteMenuContextual(hacer('<img alt="figura">', "img"))).toBe(false);
    expect(permiteMenuContextual(hacer('<input type="checkbox">', "input"))).toBe(false);
  });

  it("NO con un target que no es un elemento", () => {
    expect(permiteMenuContextual(null)).toBe(false);
    expect(permiteMenuContextual(document as unknown as EventTarget)).toBe(false);
  });
});

describe("el simulacro del docente NO se cierra por advertencias", () => {
  // Reporte: «desde el simular como docente no debería cerrar el examen si se
  // cumplen los strikes; el objetivo es ver lo similar al estudiante». Antes,
  // AVISAR y CERRAR eran la misma condición, así que el docente que probaba el
  // proctoring se quedaba sin la pantalla justo cuando estaba probándola —
  // y el proctoring es lo único que no puede ver de otra forma.

  it("en un examen REAL se suspende al llegar al tope", () => {
    expect(suspendePorAdvertencias(3, 3, false)).toBe(true);
    expect(suspendePorAdvertencias(4, 3, false)).toBe(true);
  });

  it("en SIMULACRO nunca se suspende", () => {
    expect(suspendePorAdvertencias(3, 3, true)).toBe(false);
    expect(suspendePorAdvertencias(99, 3, true)).toBe(false);
  });

  it("pero SÍ se avisa en los dos modos: el docente ve lo mismo que el alumno", () => {
    expect(avisaDelLimite(3, 3)).toBe(true);
    expect(avisaDelLimite(2, 3)).toBe(false);
  });

  it("por debajo del tope no pasa nada en ninguno de los dos", () => {
    expect(suspendePorAdvertencias(2, 3, false)).toBe(false);
    expect(suspendePorAdvertencias(2, 3, true)).toBe(false);
  });

  it("el contador del simulacro NO pasa del tope", () => {
    // Sin esto la barra mostraría «4/3», un estado que el alumno nunca ve.
    expect(contarAdvertencia(2, 3, true)).toBe(3);
    expect(contarAdvertencia(3, 3, true)).toBe(3);
    expect(contarAdvertencia(10, 3, true)).toBe(3);
  });

  it("el contador de un examen real sí sube (el tope lo pone la suspensión)", () => {
    expect(contarAdvertencia(0, 3, false)).toBe(1);
    expect(contarAdvertencia(2, 3, false)).toBe(3);
  });

  it("respeta el maximo configurado del examen, no solo el default", () => {
    expect(suspendePorAdvertencias(5, 10, false)).toBe(false);
    expect(suspendePorAdvertencias(10, 10, false)).toBe(true);
    expect(contarAdvertencia(9, 10, true)).toBe(10);
    expect(contarAdvertencia(10, 10, true)).toBe(10);
  });
});

describe("eventoSumoStrike", () => {
  it("manda lo que quedó escrito en el evento, no el tipo", () => {
    // Desde que pegar puede sumar o no según la pregunta, el tipo dejó de
    // alcanzar. Si se deduce del tipo, perdonar un pegado que SÍ sumó no
    // descuenta el contador y el alumno se queda con el strike.
    expect(eventoSumoStrike({ type: "pegar", suma: true })).toBe(true);
    expect(eventoSumoStrike({ type: "pestaña", suma: false })).toBe(false);
  });

  it("un evento VIEJO, sin marca, se resuelve por tipo como siempre", () => {
    // Es lo que hay en producción: 451 eventos escritos antes de que la marca
    // existiera. Cambiarles el significado sería reescribir expedientes.
    expect(eventoSumoStrike({ type: "pestaña" })).toBe(true);
    expect(eventoSumoStrike({ type: "pegar" })).toBe(false);
    expect(eventoSumoStrike({ type: "copiar" })).toBe(false);
    expect(eventoSumoStrike({ type: "screenshot_attempt" })).toBe(false);
  });
});

describe("pegarCuentaComoStrike", () => {
  it("con el interruptor APAGADO nunca suma, pase lo que pase", () => {
    // El default. Encenderlo para todos haría que, el día que la suspensión
    // vuelva a funcionar, media clase se suspenda por pegar.
    expect(pegarCuentaComoStrike("abierta", false)).toBe(false);
    expect(pegarCuentaComoStrike("codigo", false)).toBe(false);
  });

  it("encendido, suma en una pregunta SIN editor", () => {
    expect(pegarCuentaComoStrike("abierta", true)).toBe(true);
    expect(pegarCuentaComoStrike("cerrada", true)).toBe(true);
    expect(pegarCuentaComoStrike("diagrama", true)).toBe(true);
  });

  it("encendido, NO suma donde pegar es parte de responder", () => {
    // La excepción original se mantiene intacta: mover una línea dentro del
    // propio editor es escribir la respuesta, no copiarse.
    for (const tipo of TIPOS_DONDE_PEGAR_ES_NORMAL) {
      expect(pegarCuentaComoStrike(tipo, true), tipo).toBe(false);
    }
  });

  it("sin saber en qué pregunta fue, NO suma", () => {
    // Falla cerrado: una acusación que no se puede ubicar no se puede
    // defender. Pasa en un examen viejo, cuyos eventos no traen la pregunta.
    expect(pegarCuentaComoStrike(null, true)).toBe(false);
    expect(pegarCuentaComoStrike(undefined, true)).toBe(false);
    expect(pegarCuentaComoStrike("", true)).toBe(false);
  });

  it("un tipo de pregunta desconocido suma: la lista de exentos es blanca", () => {
    // Al revés —denylist— un tipo nuevo con editor entraría sumando y el
    // perdón de más sería invisible. Acá lo peor que pasa es un strike de más,
    // que el docente VE y puede quitar.
    expect(pegarCuentaComoStrike("tipo_que_no_existe", true)).toBe(true);
  });
});
