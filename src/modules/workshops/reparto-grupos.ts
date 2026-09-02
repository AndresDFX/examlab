/**
 * Reparto AL AZAR de estudiantes en grupos. PURO: sin React, sin base, sin
 * `Math.random` implícito.
 *
 * ── Qué resuelve ──────────────────────────────────────────────────────────
 * Los grupos de taller existían pero se armaban a mano: crear cada grupo
 * escribiendo su nombre y arrastrar a cada estudiante uno por uno. Para un curso
 * de 31 en grupos de 4 son 8 nombres y 31 arrastres, en clase y con la gente
 * esperando. En toda la producción había UN grupo creado — la función existía y
 * nadie la usaba.
 *
 * ── Los tamaños se EQUILIBRAN, no se rellenan hasta el tope ───────────────
 * Con 31 estudiantes en grupos de 4, el reparto ingenuo hace 7 grupos de 4 y uno
 * de 3 — que está bien— pero con 25 en grupos de 4 haría 6 de 4 y **uno de 1**, y
 * un grupo de una persona no es un grupo: es alguien que va a hacer el taller
 * solo sin que nadie se lo haya dicho.
 *
 * Por eso el tamaño pedido decide CUÁNTOS grupos (`ceil(n / tamaño)`) y después
 * las personas se reparten lo más parejo posible entre ellos. Con 25 y tamaño 4
 * salen 7 grupos: cuatro de 4 y tres de 3. Ninguno queda por debajo del resto en
 * más de una persona, que es la propiedad que hace que nadie quede solo.
 *
 * ── El azar se INYECTA ────────────────────────────────────────────────────
 * `aleatorio` es un parámetro con default `Math.random`. Sin eso esta función no
 * se puede testear —el resultado cambiaría en cada corrida— y justamente lo que
 * hay que fijar con tests es el reparto, no el azar. Es además la razón por la que
 * el módulo no lee la hora ni genera ids: todo lo no-determinista entra por la
 * firma.
 */

/** Un grupo propuesto: su nombre y quiénes van. */
export interface GrupoPropuesto {
  nombre: string;
  integrantes: string[];
}

export interface OpcionesReparto {
  /** Personas por grupo. Excluyente con `cantidad`. */
  tamano?: number;
  /** Cantidad de grupos. Excluyente con `tamano`. */
  cantidad?: number;
  /** Desde qué número empiezan los nombres ("Grupo 3"). Default 1. */
  desde?: number;
  /**
   * Nombres que YA existen en el taller. Los nombres nuevos los saltan.
   *
   * No es cosmético: `workshop_groups` tiene `UNIQUE (workshop_id, name)`, así
   * que un nombre repetido hace fallar el INSERT ENTERO con 23505 y no se crea
   * ningún grupo. Y numerar desde "la cantidad + 1" no alcanza: con "Grupo 1",
   * "Grupo 2" y "Grupo 4" ya creados, empezar en 4 choca.
   */
  nombresTomados?: readonly string[];
  /** Inyectable para poder testear. Default `Math.random`. */
  aleatorio?: () => number;
}

/**
 * Mezcla una copia del arreglo (Fisher-Yates). No toca el original: quien llama
 * suele estar mostrando esa misma lista en pantalla.
 */
export function mezclar<T>(items: readonly T[], aleatorio: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(aleatorio() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/**
 * Cuántos grupos y de qué tamaño, ya equilibrados. Separado del reparto porque
 * es lo que la pantalla necesita para mostrar la previsualización ANTES de
 * escribir nada en la base: "8 grupos: 7 de 4 y 1 de 3".
 */
export function tamanosEquilibrados(total: number, cantidad: number): number[] {
  const n = Math.max(0, Math.floor(total));
  const g = Math.max(1, Math.floor(cantidad));
  if (n === 0) return [];
  const grupos = Math.min(g, n); // nunca más grupos que personas
  const base = Math.floor(n / grupos);
  const resto = n % grupos;
  // El resto se reparte de a UNO entre los primeros: así ningún grupo queda a
  // más de una persona de otro.
  return Array.from({ length: grupos }, (_, i) => base + (i < resto ? 1 : 0));
}

/** Nombre por defecto de un grupo. Se numera desde 1 y no desde 0. */
export function nombreDeGrupo(indice: number): string {
  return `Grupo ${indice}`;
}

/**
 * `cantidad` nombres que NO choquen con los ya tomados, empezando a buscar en
 * `desde`. La comparación ignora mayúsculas y espacios de borde, porque el UNIQUE
 * de la base es sobre el texto tal cual y "grupo 2" escrito a mano por el docente
 * es el mismo grupo para una persona.
 */
export function nombresLibres(
  cantidad: number,
  tomados: readonly string[] = [],
  desde = 1,
): string[] {
  const usados = new Set(tomados.map((n) => String(n ?? "").trim().toLowerCase()));
  const salida: string[] = [];
  let i = Math.max(1, Math.floor(desde) || 1);
  // Tope defensivo: sin él, una lista de tomados patológica colgaría el bucle.
  const tope = i + cantidad + usados.size + 1000;
  while (salida.length < cantidad && i < tope) {
    const n = nombreDeGrupo(i);
    if (!usados.has(n.toLowerCase())) salida.push(n);
    i++;
  }
  return salida;
}

/**
 * Reparte a los estudiantes al azar. Devuelve los grupos con su nombre y sus
 * integrantes, listos para insertar.
 *
 * Si no se pasa ni `tamano` ni `cantidad`, o los ids están vacíos, devuelve `[]`:
 * quien llama decide qué decirle al usuario, y esta función no inventa un
 * reparto que nadie pidió.
 */
export function repartirAlAzar(
  ids: readonly string[],
  opciones: OpcionesReparto = {},
): GrupoPropuesto[] {
  const limpios = Array.from(new Set(ids.filter((x) => typeof x === "string" && x !== "")));
  if (limpios.length === 0) return [];

  const { tamano, cantidad, desde = 1, nombresTomados = [], aleatorio = Math.random } = opciones;
  let grupos: number;
  if (typeof cantidad === "number" && cantidad >= 1) {
    grupos = Math.floor(cantidad);
  } else if (typeof tamano === "number" && tamano >= 1) {
    grupos = Math.ceil(limpios.length / Math.floor(tamano));
  } else {
    return [];
  }

  const tamanos = tamanosEquilibrados(limpios.length, grupos);
  const mezclados = mezclar(limpios, aleatorio);

  const nombres = nombresLibres(tamanos.length, nombresTomados, desde);
  const salida: GrupoPropuesto[] = [];
  let cursor = 0;
  tamanos.forEach((t, i) => {
    salida.push({
      nombre: nombres[i] ?? nombreDeGrupo(desde + i),
      integrantes: mezclados.slice(cursor, cursor + t),
    });
    cursor += t;
  });
  return salida;
}

/**
 * ¿El reparto respeta el tamaño que declaró el taller?
 *
 * `workshops.group_size_min` y `group_size_max` existen y están puestos en los
 * talleres reales (2 y 5), pero NADA en la interfaz los leía: se podía armar un
 * grupo de una persona o de doce y nadie avisaba. Esto los pone a trabajar, y
 * devuelve el detalle para poder decir CUÁL grupo se sale y por qué — un "no se
 * puede" sin el motivo obliga a adivinar.
 */
export function fueraDeRango(
  grupos: readonly GrupoPropuesto[],
  min: number | null | undefined,
  max: number | null | undefined,
): { nombre: string; integrantes: number; motivo: "min" | "max" }[] {
  const salida: { nombre: string; integrantes: number; motivo: "min" | "max" }[] = [];
  for (const g of grupos) {
    const n = g.integrantes.length;
    if (typeof min === "number" && min > 0 && n < min) {
      salida.push({ nombre: g.nombre, integrantes: n, motivo: "min" });
    } else if (typeof max === "number" && max > 0 && n > max) {
      salida.push({ nombre: g.nombre, integrantes: n, motivo: "max" });
    }
  }
  return salida;
}

/**
 * Resumen legible de los tamaños, para la previsualización: `[4,4,4,3]` se
 * cuenta como "3 de 4 · 1 de 3".
 *
 * Devuelve las PARTES y no una frase armada: la traducción vive en la pantalla, y
 * así los tests no dependen de las claves de i18n.
 */
export function resumenDeTamanos(
  grupos: readonly GrupoPropuesto[],
): { cuantos: number; integrantes: number }[] {
  const cuenta = new Map<number, number>();
  for (const g of grupos) {
    const n = g.integrantes.length;
    cuenta.set(n, (cuenta.get(n) ?? 0) + 1);
  }
  return [...cuenta.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([integrantes, cuantos]) => ({ cuantos, integrantes }));
}
