/**
 * El cliente de base de datos que usa el SIMULACRO de examen: lee igual que el
 * real y **no escribe nada**.
 *
 * ── Por qué un cliente y no un `if` en cada escritura ─────────────────
 * La pantalla de toma (`TakeExamScreen.tsx`) escribe en ONCE lugares:
 * crear la entrega, el autoguardado cada 1,5 s, el latido del bloqueo de
 * sesión, tres caminos de proctoring, la entrega, el aviso al docente, la
 * reanudación y la cancelación de trabajos de IA. Repartir un `if (simulacro)`
 * entre los once deja el arreglo a merced de que quien agregue el DOCE se
 * acuerde — y el modo de falla no es un error: es una fila real en
 * `submissions`, que entra al gradebook, a los pendientes de calificación, al
 * acta y a las estadísticas del curso. Una nota inventada por una prueba.
 *
 * Con un cliente que no sabe escribir, el punto de decisión es UNO. Un método
 * nuevo de escritura que aparezca en una versión futura de supabase-js cae en
 * la lista de abajo o no se usa; y si alguien agrega una escritura a la
 * pantalla, no hay nada que recordar.
 *
 * ── Qué sí pasa ───────────────────────────────────────────────────────
 *  · Las LECTURAS van a la base de verdad: el examen, sus preguntas, la
 *    configuración de proctoring y la del ejecutor de código son las reales.
 *    Un simulacro que lea de otro lado no prueba nada.
 *  · `functions.invoke` queda INTACTO a propósito. Ejecutar el código del
 *    alumno es justamente lo que el docente viene a probar, y ese camino no
 *    escribe notas (deja una fila de auditoría de ejecución, igual que cuando
 *    el docente prueba el código en cualquier otra pantalla).
 *  · `auth` y `storage` quedan intactos: el primero lo necesita la sesión, y el
 *    segundo sirve las imágenes del enunciado.
 *
 * ── Qué no pasa ───────────────────────────────────────────────────────
 *  · `insert` / `update` / `upsert` / `delete` devuelven «no pasó nada» sin
 *    tocar la red.
 *  · `rpc` tampoco corre: por ahí van el aviso al docente y la cancelación de
 *    trabajos de IA, y ninguna de las dos debe dispararse por un ensayo.
 *
 * El resultado que devuelven es `{ data: null, error: null }` — o sea ÉXITO
 * vacío, no error. Un error haría que la pantalla mostrara «no se pudo
 * guardar» durante todo el simulacro, que es exactamente la impresión
 * equivocada: no es que falló, es que no había nada que guardar.
 */

/** Los que no deben salir a la red en un simulacro. */
export const METODOS_QUE_ESCRIBEN = [
  "insert",
  "update",
  "upsert",
  "delete",
] as const;

/** Métodos de la cadena de PostgREST que siguen a una escritura y hay que
 *  poder encadenar para que el código del caller no se rompa. */
const METODOS_ENCADENABLES = [
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains",
  "match", "not", "or", "filter", "select", "order", "limit", "range", "single",
  "maybeSingle", "throwOnError", "abortSignal", "csv", "geojson", "returns",
];

/** Resultado vacío pero EXITOSO — ver el encabezado. */
export function resultadoVacio(): { data: null; error: null; count: null; status: number; statusText: string } {
  return { data: null, error: null, count: null, status: 200, statusText: "OK (simulacro)" };
}

/**
 * Un eslabón que se deja encadenar como el builder real y, cuando se espera,
 * resuelve a un resultado vacío. Se devuelve el MISMO objeto en cada eslabón
 * (no uno nuevo) para no crear basura en una cadena larga.
 */
function eslabonSinEfecto(): any {
  const nodo: any = {
    then: (resolver: (v: unknown) => unknown) => Promise.resolve(resultadoVacio()).then(resolver),
    catch: (f: (e: unknown) => unknown) => Promise.resolve(resultadoVacio()).catch(f),
    finally: (f: () => void) => Promise.resolve(resultadoVacio()).finally(f),
  };
  for (const m of METODOS_ENCADENABLES) nodo[m] = () => nodo;
  return nodo;
}

/**
 * Envuelve el builder de una tabla: las lecturas pasan al real, las escrituras
 * caen en el eslabón sin efecto.
 */
function envolverTabla(builderReal: any): any {
  return new Proxy(builderReal, {
    get(destino, prop, receptor) {
      if (typeof prop === "string" && (METODOS_QUE_ESCRIBEN as readonly string[]).includes(prop)) {
        return () => eslabonSinEfecto();
      }
      const valor = Reflect.get(destino, prop, receptor);
      return typeof valor === "function" ? valor.bind(destino) : valor;
    },
  });
}

/**
 * Cliente de simulacro sobre el cliente real.
 *
 * `cliente` se tipa laxo a propósito: el tipo generado de supabase-js es
 * genérico sobre el esquema y envolverlo en un Proxy tipado obligaría a
 * reconstruir toda esa firma. El caller lo recibe con el mismo tipo que el
 * real, que es lo que importa para el resto del archivo.
 */
export function clienteDeSimulacro<T>(cliente: T): T {
  return new Proxy(cliente as any, {
    get(destino, prop, receptor) {
      if (prop === "from") {
        return (tabla: string) => envolverTabla(destino.from(tabla));
      }
      if (prop === "rpc") {
        // El aviso al docente y la cancelación de trabajos de IA viven acá.
        return () => eslabonSinEfecto();
      }
      const valor = Reflect.get(destino, prop, receptor);
      return typeof valor === "function" ? valor.bind(destino) : valor;
    },
  }) as T;
}
