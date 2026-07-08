/**
 * Modelo de topología de red + conectividad — para las preguntas tipo "Red"
 * (consola IOS y, más adelante, GUI tipo Cisco). Ver
 * [docs/research/network-question-integrations.md].
 *
 * TODO es PURO (sin DOM, sin red real): la conectividad se simula con un BFS
 * determinista sobre el grafo de dispositivos/enlaces. Así el módulo se testea
 * con vitest sin jsdom y la calificación es reproducible y auto-verificable.
 *
 * Simplificaciones deliberadas (MVP, documentadas para que el docente arme
 * escenarios acotados — NO es un simulador IOS real):
 *  - Reenvío "directamente conectado": un router reenvía entre las subredes de
 *    sus interfaces activas; un switch hace passthrough L2; los endpoints
 *    (pc/server) no reenvían. No hay tablas de rutas estáticas/dinámicas ni
 *    gateways por defecto en el MVP.
 *  - La máscara acepta forma dotted ("255.255.255.0") o prefijo ("/24" o "24").
 */

export type DeviceKind = "router" | "switch" | "pc" | "server";

export interface NetInterface {
  /** Nombre IOS, p. ej. "GigabitEthernet0/0", "Fa0/1". */
  name: string;
  ip?: string | null;
  /** Máscara dotted o prefijo. Null = sin IP configurada. */
  mask?: string | null;
  /** `no shutdown` la sube; `shutdown` la baja. Default: abajo (como IOS). */
  up: boolean;
}

export interface Device {
  id: string;
  /** hostname IOS. */
  name: string;
  kind: DeviceKind;
  interfaces: NetInterface[];
}

export interface LinkEnd {
  device: string; // Device.id
  iface: string; // NetInterface.name
}

export interface Link {
  a: LinkEnd;
  b: LinkEnd;
}

export interface Topology {
  devices: Device[];
  links: Link[];
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers de IP (puros, sin dependencias — evitamos netmask/ip-address)
// ─────────────────────────────────────────────────────────────────────────

/** "192.168.1.1" → [192,168,1,1] o null si es inválida. */
export function parseIp(ip: string | null | undefined): number[] | null {
  if (!ip) return null;
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/** Máscara dotted ("255.255.255.0"), "/24" o "24" → prefijo 0..32, o null. */
export function maskToPrefix(mask: string | null | undefined): number | null {
  if (mask == null) return null;
  const m = String(mask).trim().replace(/^\//, "");
  // Prefijo numérico directo.
  if (/^\d{1,2}$/.test(m)) {
    const n = Number(m);
    return n >= 0 && n <= 32 ? n : null;
  }
  // Dotted → contar bits contiguos en 1 (y validar que sean contiguos).
  const octets = parseIp(m);
  if (!octets) return null;
  let bits = "";
  for (const o of octets) bits += o.toString(2).padStart(8, "0");
  const match = /^(1*)(0*)$/.exec(bits);
  if (!match) return null; // bits no contiguos → máscara inválida
  return match[1].length;
}

/** Número entero de 32 bits de una IP (o null). */
export function ipToInt(ip: string | null | undefined): number | null {
  const o = parseIp(ip);
  if (!o) return null;
  // >>> 0 para tratar como unsigned de 32 bits.
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/** Dirección de red (int) de ip/prefijo, o null. */
export function networkAddress(ip: string | null | undefined, prefix: number | null): number | null {
  const int = ipToInt(ip);
  if (int == null || prefix == null || prefix < 0 || prefix > 32) return null;
  if (prefix === 0) return 0;
  const maskInt = (0xffffffff << (32 - prefix)) >>> 0;
  return (int & maskInt) >>> 0;
}

/** ¿ip1 e ip2 están en la misma subred dada una máscara/prefijo? */
export function sameSubnet(
  ip1: string | null | undefined,
  ip2: string | null | undefined,
  mask: string | null | undefined,
): boolean {
  const prefix = maskToPrefix(mask);
  if (prefix == null) return false;
  const n1 = networkAddress(ip1, prefix);
  const n2 = networkAddress(ip2, prefix);
  return n1 != null && n2 != null && n1 === n2;
}

// ─────────────────────────────────────────────────────────────────────────
// Consultas sobre la topología
// ─────────────────────────────────────────────────────────────────────────

export function findDevice(topo: Topology, deviceId: string): Device | undefined {
  return topo.devices.find((d) => d.id === deviceId);
}

export function findDeviceByName(topo: Topology, name: string): Device | undefined {
  const lower = name.trim().toLowerCase();
  return topo.devices.find((d) => d.name.trim().toLowerCase() === lower);
}

/** Interfaz (activa o no) que posee exactamente esta IP, en cualquier dispositivo. */
export function deviceOwningIp(topo: Topology, ip: string): Device | undefined {
  const target = ipToInt(ip);
  if (target == null) return undefined;
  return topo.devices.find((d) => d.interfaces.some((i) => ipToInt(i.ip) === target));
}

/** ¿El dispositivo reenvía tráfico que no es propio? Endpoints no; router/switch sí. */
function forwards(kind: DeviceKind): boolean {
  return kind === "router" || kind === "switch";
}

/**
 * Canonicaliza un nombre de interfaz: "g0/0" / "gi0/0" / "GigabitEthernet0/0"
 * → "GigabitEthernet0/0". Vive acá (nivel topología) porque tanto el intérprete
 * IOS como la calificación necesitan que "int g0/0" y "GigabitEthernet0/0"
 * apunten a la MISMA interfaz — clave para que el grading sea tolerante.
 */
export function canonicalIface(name: string): string {
  const m = /^([a-zA-Z]+)\s*(.*)$/.exec(name.trim());
  if (!m) return name.trim();
  const letters = m[1].toLowerCase();
  const rest = m[2].trim();
  const map: Array<[RegExp, string]> = [
    [/^(g|gi|gig|gigabitethernet)$/, "GigabitEthernet"],
    [/^(te|tengig|tengigabitethernet)$/, "TenGigabitEthernet"],
    [/^(f|fa|fast|fastethernet)$/, "FastEthernet"],
    [/^(e|eth|et|ethernet)$/, "Ethernet"],
    [/^(s|se|ser|serial)$/, "Serial"],
    [/^(lo|loop|loopback)$/, "Loopback"],
    [/^(vl|vlan)$/, "Vlan"],
  ];
  for (const [re, full] of map) {
    if (re.test(letters)) return `${full}${rest}`;
  }
  return `${m[1]}${rest}`;
}

/**
 * Interfaz de un dispositivo por nombre — CANÓNICO-aware: "gi0/0" encuentra
 * "GigabitEthernet0/0". Así tanto los enlaces del escenario como las aserciones
 * de calificación pueden usar abreviaturas sin fallar.
 */
export function findInterface(device: Device, ifaceName: string): NetInterface | undefined {
  const target = canonicalIface(ifaceName).toLowerCase();
  return device.interfaces.find((i) => canonicalIface(i.name).toLowerCase() === target);
}

/**
 * ¿`srcDeviceId` puede alcanzar la IP `dstIp`? BFS sobre enlaces cuyos DOS
 * extremos estén `up`. Reenvían routers y switches; los endpoints solo
 * originan. El origen debe tener al menos una interfaz activa con IP (no se
 * puede hacer ping sin dirección).
 *
 * Devuelve false si la IP destino no existe en ninguna interfaz activa.
 */
export function canReach(topo: Topology, srcDeviceId: string, dstIp: string): boolean {
  const src = findDevice(topo, srcDeviceId);
  if (!src) return false;

  // El origen necesita una interfaz activa con IP.
  const srcHasActiveIp = src.interfaces.some((i) => i.up && ipToInt(i.ip) != null);
  if (!srcHasActiveIp) return false;

  const dstInt = ipToInt(dstIp);
  if (dstInt == null) return false;

  // El destino debe existir en una interfaz ACTIVA de algún dispositivo.
  const target = topo.devices.find((d) =>
    d.interfaces.some((i) => i.up && ipToInt(i.ip) === dstInt),
  );
  if (!target) return false;
  if (target.id === src.id) return true; // ping a sí mismo (loopback lógico)

  // Adyacencia por enlaces con ambos extremos up.
  const upIface = (deviceId: string, ifaceName: string): boolean => {
    const d = findDevice(topo, deviceId);
    const i = d && findInterface(d, ifaceName);
    return !!i && i.up;
  };
  const neighbors = (deviceId: string): string[] => {
    const out: string[] = [];
    for (const l of topo.links) {
      if (l.a.device === deviceId && upIface(l.a.device, l.a.iface) && upIface(l.b.device, l.b.iface)) {
        out.push(l.b.device);
      } else if (
        l.b.device === deviceId &&
        upIface(l.a.device, l.a.iface) &&
        upIface(l.b.device, l.b.iface)
      ) {
        out.push(l.a.device);
      }
    }
    return out;
  };

  const visited = new Set<string>([src.id]);
  const queue: string[] = [src.id];
  while (queue.length) {
    const cur = queue.shift() as string;
    if (cur === target.id) return true;
    const curDev = findDevice(topo, cur);
    if (!curDev) continue;
    // Solo reenviamos si el nodo actual es el origen o un dispositivo de reenvío.
    if (cur !== src.id && !forwards(curDev.kind)) continue;
    for (const nb of neighbors(cur)) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }
  return false;
}
