// ⚠️ COPIA Deno de src/modules/network/scenario.ts — sincronizar con el original.
/**
 * Escenario de una pregunta tipo "Red consola" + generación de escenarios
 * templados + (de)serialización de la respuesta del alumno. PURO (sin DOM),
 * testeable con vitest.
 *
 * El escenario vive en `question.options.network`; la respuesta del alumno es
 * la topología final (mutada por sus comandos) + su historial, serializada a
 * JSON. La calificación es determinista: `gradeNetwork(answer, assertions)`.
 */
import { type Device, type Link, type Topology } from "./topology.ts";
import { type Assertion } from "./grading.ts";

export interface NetworkScenario {
  devices: Device[];
  links: Link[];
  /** Device.id que el estudiante configura desde la consola. */
  targetDeviceId: string;
  /** Aserciones de calificación (rúbrica). */
  assertions: Assertion[];
}

export interface NetworkAnswer {
  topology: Topology;
  /** Historial de comandos por Device.id. */
  histories: Record<string, string[]>;
}

/** Clona en profundidad una topología (para no mutar el escenario original). */
export function cloneTopology(topo: { devices: Device[]; links: Link[] }): Topology {
  return {
    devices: topo.devices.map((d) => ({
      ...d,
      interfaces: d.interfaces.map((i) => ({ ...i })),
    })),
    links: topo.links.map((l) => ({ a: { ...l.a }, b: { ...l.b } })),
  };
}

/**
 * Escenario por defecto para el editor manual: R1 (router, Gi0/0 abajo, sin
 * IP) — PC1 (192.168.1.10/24). El alumno debe direccionar y activar Gi0/0 de
 * R1 y lograr conectividad con la PC. Runnable de inmediato.
 */
export function defaultScenario(): NetworkScenario {
  return buildAddressingScenario(1, 5);
}

/**
 * Escenario paramétrico de "direccionamiento + conectividad" en la subred
 * 192.168.<octet>.0/24. R1 sin configurar + PC1 (host .10, up). El alumno
 * asigna .1/24 a Gi0/0 de R1, la activa y logra ping a la PC.
 */
export function buildAddressingScenario(octet: number, points: number): NetworkScenario {
  const routerIp = `192.168.${octet}.1`;
  const pcIp = `192.168.${octet}.10`;
  const devices: Device[] = [
    {
      id: "R1",
      name: "Router",
      kind: "router",
      interfaces: [{ name: "GigabitEthernet0/0", ip: null, mask: null, up: false }],
    },
    {
      id: "PC1",
      name: "PC1",
      kind: "pc",
      interfaces: [{ name: "GigabitEthernet0/0", ip: pcIp, mask: "255.255.255.0", up: true }],
    },
  ];
  const links: Link[] = [
    { a: { device: "R1", iface: "GigabitEthernet0/0" }, b: { device: "PC1", iface: "GigabitEthernet0/0" } },
  ];
  const pts = Math.max(1, points);
  // Reparto de puntos: hostname 20% · IP 40% · activa 20% · conectividad 20%.
  const assertions: Assertion[] = [
    { kind: "hostname", device: "R1", equals: "R1", points: round(pts * 0.2), label: "hostname R1" },
    {
      kind: "interface_ip",
      device: "R1",
      iface: "GigabitEthernet0/0",
      ip: routerIp,
      mask: "255.255.255.0",
      points: round(pts * 0.4),
      label: `IP ${routerIp}/24 en Gi0/0`,
    },
    { kind: "interface_up", device: "R1", iface: "GigabitEthernet0/0", points: round(pts * 0.2), label: "Gi0/0 activa (no shutdown)" },
    { kind: "connectivity", from: "R1", toIp: pcIp, points: round(pts * 0.2), label: `conectividad R1 → PC1 (${pcIp})` },
  ];
  return { devices, links, targetDeviceId: "R1", assertions };
}

function round(n: number): number {
  return Math.max(1, Math.round(n));
}

/**
 * Genera `count` preguntas `red_consola` templadas y DETERMINISTAS (sin IA,
 * sin `Math.random`/`Date` — varían por índice). Cada una es un ejercicio de
 * direccionamiento + conectividad en una subred distinta. Devuelve la forma
 * lista para insertar en `workshop_questions` / `questions`.
 */
export function generateNetworkQuestions(
  topics: string,
  count: number,
  pointsEach = 5,
): Array<{ content: string; expected_rubric: string; options: { network: NetworkScenario }; points: number }> {
  const n = Math.max(1, Math.min(20, Math.floor(count) || 1));
  const topic = topics.trim();
  const out: Array<{
    content: string;
    expected_rubric: string;
    options: { network: NetworkScenario };
    points: number;
  }> = [];
  for (let i = 0; i < n; i++) {
    const octet = (i % 254) + 1;
    const scenario = buildAddressingScenario(octet, pointsEach);
    const routerIp = `192.168.${octet}.1`;
    const pcIp = `192.168.${octet}.10`;
    const content =
      `${topic ? `Tema: ${topic}.\n\n` : ""}` +
      `Configura el router **R1** desde la consola para dar servicio a **PC1** (${pcIp}/24):\n` +
      `1. Asigna el hostname \`R1\`.\n` +
      `2. Asigna la IP \`${routerIp}\` con máscara \`255.255.255.0\` a la interfaz \`GigabitEthernet0/0\`.\n` +
      `3. Activa la interfaz (\`no shutdown\`).\n` +
      `4. Verifica conectividad con \`ping ${pcIp}\`.`;
    const expected_rubric =
      `hostname=R1; ${routerIp}/24 en Gi0/0; interfaz activa; ping exitoso a ${pcIp}.`;
    out.push({ content, expected_rubric, options: { network: scenario }, points: pointsEach });
  }
  return out;
}

// ── (de)serialización de la respuesta del alumno ──────────────────────────

export function serializeNetworkAnswer(topology: Topology, histories: Record<string, string[]>): string {
  const answer: NetworkAnswer = { topology, histories };
  return JSON.stringify(answer);
}

export function parseNetworkAnswer(raw: unknown): NetworkAnswer | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const topo = o.topology as Topology | undefined;
  if (!topo || !Array.isArray(topo.devices) || !Array.isArray(topo.links)) return null;
  const histories = (o.histories as Record<string, string[]>) ?? {};
  return { topology: topo, histories };
}

/** Extrae el escenario desde `question.options` (tolerante a formatos). */
export function parseScenario(options: unknown): NetworkScenario | null {
  if (typeof options !== "object" || options === null) return null;
  const net = (options as Record<string, unknown>).network;
  if (typeof net !== "object" || net === null) return null;
  const s = net as Record<string, unknown>;
  if (!Array.isArray(s.devices) || !Array.isArray(s.links) || !Array.isArray(s.assertions)) return null;
  if (typeof s.targetDeviceId !== "string") return null;
  return {
    devices: s.devices as Device[],
    links: s.links as Link[],
    targetDeviceId: s.targetDeviceId,
    assertions: s.assertions as Assertion[],
  };
}
