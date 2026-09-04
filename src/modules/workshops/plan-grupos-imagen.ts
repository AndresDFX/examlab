/**
 * Del borrador revisado por el docente al PLAN de escritura: qué grupos crear, qué
 * membresías borrar y qué insertar.
 *
 * ── Por qué un plan y no escribir directo ─────────────────────────────────
 * Tres razones, todas medidas contra el esquema real:
 *
 * 1. **`trg_one_workshop_group_per_user` rechaza estar en dos grupos del mismo
 *    taller** (`assert_one_workshop_group_per_user`). Insertar sin borrar antes la
 *    membresía previa hace fallar el INSERT en lote ENTERO, no solo esa fila. El
 *    orden borrar→insertar no es una preferencia, es la única secuencia que funciona.
 * 2. **El índice de nombre de grupo es case-insensitive.** "Sala 1" y "sala 1" chocan.
 *    Si la etiqueta leída coincide con un grupo que ya existe, se REUSA ese grupo en
 *    vez de crear otro: crear el segundo falla, y crearlo con otro nombre le esconde
 *    al docente que ya tenía ese grupo.
 * 3. **Quien ya entregó individual no se puede meter a un grupo**: lo rechaza
 *    `tg_block_ws_group_member_with_individual` (mig 20261068000000) con P0001, y otra
 *    vez cae el lote completo. Esas filas se BLOQUEAN con su motivo a la vista, en vez
 *    de dejar que el docente pulse Aplicar y reciba un error del que no puede deducir
 *    a quién tiene que sacar.
 *
 * Todo esto es determinista y sin efectos: por eso vive acá, con tests, y no dentro
 * del diálogo.
 */
import { fueraDeRango, nombresLibres, type GrupoPropuesto } from "./reparto-grupos";

/** Una fila del borrador, ya revisada por el docente. */
export interface FilaAsignacion {
  id: string;
  leido: string;
  etiqueta: string;
  /** `null` = el docente no eligió a nadie (ambiguo o sin coincidencia). */
  user_id: string | null;
  descartada?: boolean;
}

export interface GrupoExistente {
  id: string;
  name: string;
}

export interface ContextoPlan {
  grupos: readonly GrupoExistente[];
  /** userId → id del grupo en el que ya está, si está en alguno. */
  miembroPorUsuario: ReadonlyMap<string, string>;
  /** Grupos que YA tienen una entrega: no se tocan. */
  gruposConEntrega: ReadonlySet<string>;
  /** Quien ya entregó por su cuenta: no puede pasar a un grupo. */
  conEntregaIndividual: ReadonlySet<string>;
  /** userId → nombre, para poder nombrar a la persona en los avisos. */
  nombrePorUsuario: ReadonlyMap<string, string>;
  groupSizeMin?: number | null;
  groupSizeMax?: number | null;
}

export type MotivoBloqueo =
  | "sin_estudiante"
  | "entrega_individual"
  | "grupo_con_entrega"
  | "repetido_en_el_plan";

export interface FilaBloqueada {
  id: string;
  leido: string;
  etiqueta: string;
  motivo: MotivoBloqueo;
  /** Nombre del estudiante cuando se lo pudo identificar. */
  nombre?: string;
}

export interface Plan {
  /** Etiquetas que hay que crear, ya sin choque con las existentes. */
  gruposACrear: { etiqueta: string; nombre: string }[];
  /** Etiqueta → id del grupo que ya existe y se reusa. */
  gruposAReusar: { etiqueta: string; groupId: string }[];
  /** Membresías previas que hay que quitar ANTES de insertar. */
  membresiasABorrar: { groupId: string; userId: string }[];
  /** Lo que se inserta. `groupId` se resuelve al crear, de ahí la etiqueta. */
  membresiasAInsertar: { etiqueta: string; userId: string }[];
  bloqueadas: FilaBloqueada[];
  /** Avisos de tamaño (no bloquean: el docente manda). */
  avisosDeTamano: { nombre: string; integrantes: number; motivo: "min" | "max" }[];
  resumen: { personas: number; grupos: number; bloqueadas: number };
}

const clave = (s: string) => s.trim().toLowerCase();

/** Por qué una fila NO se puede aplicar, o `null` si se puede. */
export function validarFila(fila: FilaAsignacion, ctx: ContextoPlan): MotivoBloqueo | null {
  if (!fila.user_id) return "sin_estudiante";
  if (ctx.conEntregaIndividual.has(fila.user_id)) return "entrega_individual";
  const grupoActual = ctx.miembroPorUsuario.get(fila.user_id);
  // Sacarlo de un grupo que ya entregó dejaría la entrega sin su autor.
  if (grupoActual && ctx.gruposConEntrega.has(grupoActual)) return "grupo_con_entrega";
  const destino = ctx.grupos.find((g) => clave(g.name) === clave(fila.etiqueta));
  if (destino && ctx.gruposConEntrega.has(destino.id)) return "grupo_con_entrega";
  return null;
}

/**
 * Construye el plan. No consulta ni escribe nada: recibe el estado y devuelve la
 * secuencia de operaciones.
 */
export function construirPlan(filas: readonly FilaAsignacion[], ctx: ContextoPlan): Plan {
  const bloqueadas: FilaBloqueada[] = [];
  const porUsuario = new Map<string, FilaAsignacion>();
  const etiquetas: string[] = [];

  for (const f of filas) {
    if (f.descartada) continue;
    const motivo = validarFila(f, ctx);
    if (motivo) {
      bloqueadas.push({
        id: f.id,
        leido: f.leido,
        etiqueta: f.etiqueta,
        motivo,
        nombre: f.user_id ? ctx.nombrePorUsuario.get(f.user_id) : undefined,
      });
      continue;
    }
    const uid = f.user_id!;
    // La misma persona asignada a dos grupos: se queda la PRIMERA y la segunda se
    // bloquea con su motivo. Aplicar las dos dejaría el resultado a merced del orden.
    if (porUsuario.has(uid)) {
      bloqueadas.push({
        id: f.id,
        leido: f.leido,
        etiqueta: f.etiqueta,
        motivo: "repetido_en_el_plan",
        nombre: ctx.nombrePorUsuario.get(uid),
      });
      continue;
    }
    porUsuario.set(uid, f);
    if (!etiquetas.some((e) => clave(e) === clave(f.etiqueta))) etiquetas.push(f.etiqueta);
  }

  // Etiquetas que ya existen como grupo (comparando sin mayúsculas, como el índice).
  const gruposAReusar: Plan["gruposAReusar"] = [];
  const aCrear: string[] = [];
  for (const e of etiquetas) {
    const existente = ctx.grupos.find((g) => clave(g.name) === clave(e));
    if (existente) gruposAReusar.push({ etiqueta: e, groupId: existente.id });
    else aCrear.push(e);
  }

  // Nombres libres para los que hay que crear: `nombresLibres` ya evita chocar con
  // los tomados. Solo se usa cuando la etiqueta leída viene vacía; si tiene texto, se
  // respeta lo que el docente vio en la captura.
  const tomados = ctx.grupos.map((g) => g.name);
  const libres = nombresLibres(aCrear.length, tomados);
  const gruposACrear = aCrear.map((e, i) => ({
    etiqueta: e,
    nombre: e.trim() || libres[i] || `Grupo ${i + 1}`,
  }));

  // Borrar la membresía previa de todo el que cambia de grupo. Se compara contra el
  // grupo DESTINO: quien ya estaba donde va no genera borrado ni inserción inútil.
  const idPorEtiqueta = new Map(gruposAReusar.map((g) => [clave(g.etiqueta), g.groupId]));
  const membresiasABorrar: Plan["membresiasABorrar"] = [];
  const membresiasAInsertar: Plan["membresiasAInsertar"] = [];
  for (const [uid, f] of porUsuario) {
    const destinoId = idPorEtiqueta.get(clave(f.etiqueta));
    const actual = ctx.miembroPorUsuario.get(uid);
    if (actual && destinoId && actual === destinoId) continue; // ya está donde va
    if (actual) membresiasABorrar.push({ groupId: actual, userId: uid });
    membresiasAInsertar.push({ etiqueta: f.etiqueta, userId: uid });
  }

  // Aviso de tamaño sobre el resultado FINAL de cada grupo tocado.
  const porEtiqueta = new Map<string, number>();
  for (const m of membresiasAInsertar) {
    const k = clave(m.etiqueta);
    porEtiqueta.set(k, (porEtiqueta.get(k) ?? 0) + 1);
  }
  // A los grupos reusados se les suman los que ya tenían y no se mueven.
  for (const g of gruposAReusar) {
    let quedan = 0;
    for (const [uid, gid] of ctx.miembroPorUsuario) {
      if (gid !== g.groupId) continue;
      const f = porUsuario.get(uid);
      if (!f || clave(f.etiqueta) === clave(g.etiqueta)) quedan++;
    }
    const k = clave(g.etiqueta);
    if (quedan) porEtiqueta.set(k, (porEtiqueta.get(k) ?? 0) + quedan);
  }
  const propuestos: GrupoPropuesto[] = [...porEtiqueta.entries()].map(([k, n]) => ({
    nombre: etiquetas.find((e) => clave(e) === k) ?? k,
    integrantes: Array.from({ length: n }, (_, i) => String(i)),
  }));

  return {
    gruposACrear,
    gruposAReusar,
    membresiasABorrar,
    membresiasAInsertar,
    bloqueadas,
    avisosDeTamano: fueraDeRango(propuestos, ctx.groupSizeMin, ctx.groupSizeMax),
    resumen: {
      personas: membresiasAInsertar.length,
      grupos: gruposACrear.length + gruposAReusar.length,
      bloqueadas: bloqueadas.length,
    },
  };
}
