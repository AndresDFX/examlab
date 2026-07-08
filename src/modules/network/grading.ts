/**
 * Calificación DETERMINISTA de preguntas tipo "Red" — PURA (sin DOM). Compara
 * el estado FINAL de la topología (y opcionalmente el historial de comandos)
 * contra una lista de aserciones definidas por el docente. Cada aserción es un
 * ítem de rúbrica con puntos. Es tolerante: ignora IDs/posiciones y verifica
 * hechos semánticos (una interfaz tiene tal IP, hay conectividad, etc.).
 *
 * Este es el camino "barato" del patrón híbrido del research doc; si el
 * escenario tiene aspectos abiertos, el fallback es el juez IA
 * (`ai-grade-submission` con un directive "redes"), fuera de este módulo.
 */
import {
  type Topology,
  canReach,
  findDeviceByName,
  findInterface,
  ipToInt,
  maskToPrefix,
} from "./topology";

export type Assertion =
  | { kind: "hostname"; device: string; equals: string; points: number; label?: string }
  | {
      kind: "interface_ip";
      device: string;
      iface: string;
      ip: string;
      /** Máscara esperada (dotted o prefijo). Opcional: si se omite, solo valida IP. */
      mask?: string;
      points: number;
      label?: string;
    }
  | { kind: "interface_up"; device: string; iface: string; points: number; label?: string }
  | { kind: "connectivity"; from: string; toIp: string; points: number; label?: string }
  | {
      kind: "command_used";
      device: string;
      /** Substring (case-insensitive) o /regex/ que debe aparecer en el historial. */
      pattern: string;
      points: number;
      label?: string;
    };

export interface GradeItem {
  label: string;
  passed: boolean;
  points: number;
  earned: number;
  detail?: string;
}

export interface GradeResult {
  earned: number;
  total: number;
  /** earned/total en 0..1 (0 si total=0). */
  ratio: number;
  items: GradeItem[];
}

export interface NetworkSubmissionState {
  topology: Topology;
  /** Historial de comandos por Device.id (para command_used). */
  histories?: Record<string, string[]>;
}

function defaultLabel(a: Assertion): string {
  switch (a.kind) {
    case "hostname":
      return `${a.device}: hostname = "${a.equals}"`;
    case "interface_ip":
      return `${a.device} ${a.iface}: IP ${a.ip}${a.mask ? " /" + (maskToPrefix(a.mask) ?? "?") : ""}`;
    case "interface_up":
      return `${a.device} ${a.iface}: activa (no shutdown)`;
    case "connectivity":
      return `${a.from} alcanza ${a.toIp}`;
    case "command_used":
      return `${a.device}: usó "${a.pattern}"`;
  }
}

/** Compila un patrón `/regex/flags` o lo trata como substring case-insensitive. */
function matchPattern(pattern: string, lines: string[]): boolean {
  const re = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2].includes("i") ? re[2] : re[2] + "i");
      return lines.some((l) => rx.test(l));
    } catch {
      // Regex inválida → cae a substring.
    }
  }
  const needle = pattern.toLowerCase();
  return lines.some((l) => l.toLowerCase().includes(needle));
}

function evalAssertion(a: Assertion, state: NetworkSubmissionState): { passed: boolean; detail?: string } {
  const { topology } = state;
  switch (a.kind) {
    case "hostname": {
      const d = findDeviceByName(topology, a.device);
      if (!d) return { passed: false, detail: `dispositivo "${a.device}" no encontrado` };
      const ok = d.name.trim().toLowerCase() === a.equals.trim().toLowerCase();
      return { passed: ok, detail: ok ? undefined : `hostname actual: "${d.name}"` };
    }
    case "interface_ip": {
      const d = findDeviceByName(topology, a.device);
      if (!d) return { passed: false, detail: `dispositivo "${a.device}" no encontrado` };
      const i = findInterface(d, a.iface);
      if (!i) return { passed: false, detail: `interfaz "${a.iface}" no encontrada` };
      const ipOk = ipToInt(i.ip) != null && ipToInt(i.ip) === ipToInt(a.ip);
      if (!ipOk) return { passed: false, detail: `IP actual: ${i.ip ?? "sin asignar"}` };
      if (a.mask != null) {
        const maskOk = maskToPrefix(i.mask) != null && maskToPrefix(i.mask) === maskToPrefix(a.mask);
        if (!maskOk) return { passed: false, detail: `máscara actual: ${i.mask ?? "sin asignar"}` };
      }
      return { passed: true };
    }
    case "interface_up": {
      const d = findDeviceByName(topology, a.device);
      if (!d) return { passed: false, detail: `dispositivo "${a.device}" no encontrado` };
      const i = findInterface(d, a.iface);
      if (!i) return { passed: false, detail: `interfaz "${a.iface}" no encontrada` };
      return { passed: i.up, detail: i.up ? undefined : "interfaz administrativamente abajo" };
    }
    case "connectivity": {
      const from = findDeviceByName(topology, a.from);
      if (!from) return { passed: false, detail: `dispositivo "${a.from}" no encontrado` };
      const ok = canReach(topology, from.id, a.toIp);
      return { passed: ok, detail: ok ? undefined : `sin conectividad a ${a.toIp}` };
    }
    case "command_used": {
      const d = findDeviceByName(topology, a.device);
      const lines = (d && state.histories?.[d.id]) || [];
      const ok = matchPattern(a.pattern, lines);
      return { passed: ok, detail: ok ? undefined : "comando no encontrado en el historial" };
    }
  }
}

/** Califica una entrega de red contra las aserciones. Puntos negativos se ignoran. */
export function gradeNetwork(state: NetworkSubmissionState, assertions: Assertion[]): GradeResult {
  const items: GradeItem[] = [];
  let earned = 0;
  let total = 0;
  for (const a of assertions) {
    const points = Math.max(0, a.points || 0);
    total += points;
    const { passed, detail } = evalAssertion(a, state);
    const gained = passed ? points : 0;
    earned += gained;
    items.push({
      label: a.label?.trim() || defaultLabel(a),
      passed,
      points,
      earned: gained,
      detail,
    });
  }
  return { earned, total, ratio: total > 0 ? earned / total : 0, items };
}
