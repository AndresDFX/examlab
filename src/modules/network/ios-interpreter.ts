/**
 * Intérprete de consola tipo Cisco IOS — PURO (sin DOM), para la pregunta
 * "Red consola". Un intérprete opera sobre UN dispositivo (que vive dentro de
 * una `Topology` compartida) y mantiene su modo (user/priv/config/if), la
 * interfaz seleccionada y el historial de comandos (para la calificación por
 * secuencia). Ver [docs/research/network-question-integrations.md].
 *
 * NO es IOS real: implementa un subconjunto acotado de comandos suficiente
 * para exámenes de competencias básicas (hostname, direccionamiento, activar
 * interfaces, verificación con show/ping). Un comando no reconocido responde
 * `% Invalid input detected` como IOS.
 */
import {
  type Device,
  type NetInterface,
  type Topology,
  canReach,
  canonicalIface,
  findInterface,
  ipToInt,
  maskToPrefix,
  parseIp,
} from "./topology";

// Re-export por compatibilidad: `canonicalIface` vive ahora en topology.ts
// (la comparten intérprete y grading), pero se sigue pudiendo importar de acá.
export { canonicalIface } from "./topology";

export type IosMode = "user" | "priv" | "config" | "if";

/** Prefijo → máscara dotted ("24" → "255.255.255.0"). */
function prefixToDotted(prefix: number): string {
  const octets = [0, 0, 0, 0];
  let bits = prefix;
  for (let i = 0; i < 4; i++) {
    const take = Math.min(8, Math.max(0, bits));
    octets[i] = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    bits -= take;
  }
  return octets.join(".");
}

/** Normaliza una máscara (dotted o prefijo) a dotted; null si inválida. */
function normalizeMask(mask: string): string | null {
  const prefix = maskToPrefix(mask);
  return prefix == null ? null : prefixToDotted(prefix);
}

export interface IosInterpreterOptions {
  /** Dispositivo que se está configurando. Se MUTA in place. */
  device: Device;
  /** Topología compartida (necesaria para `ping`). */
  topology?: Topology;
}

const INVALID = "% Invalid input detected at '^' marker.";
const INCOMPLETE = "% Incomplete command.";

export class IosInterpreter {
  readonly device: Device;
  private readonly topology?: Topology;
  private mode: IosMode = "user";
  private currentIface: NetInterface | null = null;
  /** Historial de líneas ejecutadas (no vacías), para calificación por secuencia. */
  readonly history: string[] = [];

  constructor(opts: IosInterpreterOptions) {
    this.device = opts.device;
    this.topology = opts.topology;
  }

  /** Prompt IOS según el modo actual (usa el hostname vigente). */
  prompt(): string {
    const h = this.device.name || "Router";
    switch (this.mode) {
      case "user":
        return `${h}>`;
      case "priv":
        return `${h}#`;
      case "config":
        return `${h}(config)#`;
      case "if":
        return `${h}(config-if)#`;
    }
  }

  /** Ejecuta UNA línea; devuelve las líneas de salida (sin el prompt). */
  execute(rawLine: string): string[] {
    const line = rawLine.trim();
    if (!line) return [];
    this.history.push(line);
    const tokens = line.split(/\s+/);
    const t0 = tokens[0].toLowerCase();

    // Comandos comunes a varios modos.
    if (t0 === "end") {
      this.mode = this.mode === "user" ? "user" : "priv";
      this.currentIface = null;
      return [];
    }
    if (t0 === "?" ) return this.help();

    switch (this.mode) {
      case "user":
        return this.execUser(tokens, t0);
      case "priv":
        return this.execPriv(tokens, t0);
      case "config":
        return this.execConfig(tokens, t0, line);
      case "if":
        return this.execIf(tokens, t0, line);
    }
  }

  // ── modo USER (>) ──────────────────────────────────────────────────────
  private execUser(tokens: string[], t0: string): string[] {
    if (this.isCmd(t0, "enable", "en")) {
      this.mode = "priv";
      return [];
    }
    if (this.isCmd(t0, "ping")) return this.ping(tokens[1]);
    if (this.isCmd(t0, "exit") || this.isCmd(t0, "logout")) return [];
    if (this.isCmd(t0, "show", "sh")) return this.show(tokens);
    return [INVALID];
  }

  // ── modo PRIV (#) ──────────────────────────────────────────────────────
  private execPriv(tokens: string[], t0: string): string[] {
    if (this.isCmd(t0, "disable")) {
      this.mode = "user";
      return [];
    }
    if (this.isCmd(t0, "configure", "conf", "config")) {
      // "configure terminal" / "conf t"
      const arg = (tokens[1] ?? "terminal").toLowerCase();
      if ("terminal".startsWith(arg)) {
        this.mode = "config";
        return ["Enter configuration commands, one per line.  End with CNTL/Z."];
      }
      return [INVALID];
    }
    if (this.isCmd(t0, "show", "sh")) return this.show(tokens);
    if (this.isCmd(t0, "ping")) return this.ping(tokens[1]);
    if (this.isCmd(t0, "exit")) {
      this.mode = "user";
      return [];
    }
    return [INVALID];
  }

  // ── modo CONFIG ((config)#) ──────────────────────────────────────────────
  private execConfig(tokens: string[], t0: string, _line: string): string[] {
    if (this.isCmd(t0, "hostname")) {
      if (!tokens[1]) return [INCOMPLETE];
      this.device.name = tokens[1];
      return [];
    }
    if (this.isCmd(t0, "interface", "int")) {
      if (!tokens[1]) return [INCOMPLETE];
      const name = canonicalIface(tokens.slice(1).join(""));
      this.currentIface = this.findOrCreateIface(name);
      this.mode = "if";
      return [];
    }
    if (this.isCmd(t0, "exit")) {
      this.mode = "priv";
      return [];
    }
    return [INVALID];
  }

  // ── modo IF ((config-if)#) ───────────────────────────────────────────────
  private execIf(tokens: string[], t0: string, _line: string): string[] {
    const iface = this.currentIface;
    if (t0 === "no") {
      const sub = (tokens[1] ?? "").toLowerCase();
      if (this.isCmd(sub, "shutdown", "shut")) {
        if (iface) iface.up = true;
        return [];
      }
      if (this.isCmd(sub, "ip") && (tokens[2] ?? "").toLowerCase().startsWith("add")) {
        if (iface) {
          iface.ip = null;
          iface.mask = null;
        }
        return [];
      }
      return [INVALID];
    }
    if (this.isCmd(t0, "ip")) {
      // ip address IP MASK
      const sub = (tokens[1] ?? "").toLowerCase();
      if ("address".startsWith(sub) && sub.length >= 3) {
        const ip = tokens[2];
        const mask = tokens[3];
        if (!ip || !mask) return [INCOMPLETE];
        if (!parseIp(ip)) return ["% Invalid IP address"];
        const dotted = normalizeMask(mask);
        if (!dotted) return ["% Invalid mask"];
        if (iface) {
          iface.ip = ip;
          iface.mask = dotted;
        }
        return [];
      }
      return [INVALID];
    }
    if (this.isCmd(t0, "shutdown", "shut")) {
      if (iface) iface.up = false;
      return [];
    }
    if (this.isCmd(t0, "interface", "int")) {
      // Saltar a otra interfaz sin salir de config.
      if (!tokens[1]) return [INCOMPLETE];
      this.currentIface = this.findOrCreateIface(canonicalIface(tokens.slice(1).join("")));
      return [];
    }
    if (this.isCmd(t0, "exit")) {
      this.mode = "config";
      this.currentIface = null;
      return [];
    }
    return [INVALID];
  }

  // ── show ────────────────────────────────────────────────────────────────
  private show(tokens: string[]): string[] {
    const rest = tokens.slice(1).map((t) => t.toLowerCase());
    const joined = rest.join(" ");
    // show running-config / show run
    if (rest[0] && "running-config".startsWith(rest[0]) && rest[0].length >= 3) {
      return this.runningConfig().split("\n");
    }
    // show ip interface brief / show ip int brief
    if (rest[0] === "ip" && rest[1] && "interface".startsWith(rest[1])) {
      if (rest[2] && "brief".startsWith(rest[2])) return this.showIpIntBrief();
    }
    if (joined === "" ) return [INCOMPLETE];
    return [INVALID];
  }

  private showIpIntBrief(): string[] {
    const header =
      "Interface                  IP-Address      OK? Method Status                Protocol";
    const rows = this.device.interfaces.map((i) => {
      const ip = ipToInt(i.ip) != null ? (i.ip as string) : "unassigned";
      const status = i.up ? "up" : "administratively down";
      const proto = i.up && ipToInt(i.ip) != null ? "up" : "down";
      const method = ipToInt(i.ip) != null ? "manual" : "unset";
      return `${pad(i.name, 26)} ${pad(ip, 15)} YES ${pad(method, 6)} ${pad(status, 21)} ${proto}`;
    });
    return [header, ...rows];
  }

  /** Config actual en formato IOS (simplificado). */
  runningConfig(): string {
    const lines: string[] = ["!", `hostname ${this.device.name || "Router"}`, "!"];
    for (const i of this.device.interfaces) {
      lines.push(`interface ${i.name}`);
      if (ipToInt(i.ip) != null && i.mask) {
        lines.push(` ip address ${i.ip} ${i.mask}`);
      } else {
        lines.push(" no ip address");
      }
      if (!i.up) lines.push(" shutdown");
      lines.push("!");
    }
    lines.push("end");
    return lines.join("\n");
  }

  // ── ping ──────────────────────────────────────────────────────────────
  private ping(target: string | undefined): string[] {
    if (!target) return [INCOMPLETE];
    if (!parseIp(target)) return ["% Invalid IP address"];
    if (!this.topology) {
      return ["% Ping no disponible (sin topología)"];
    }
    const ok = canReach(this.topology, this.device.id, target);
    if (ok) {
      return [
        `Type escape sequence to abort.`,
        `Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
        `!!!!!`,
        `Success rate is 100 percent (5/5)`,
      ];
    }
    return [
      `Type escape sequence to abort.`,
      `Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
      `.....`,
      `Success rate is 0 percent (0/5)`,
    ];
  }

  private help(): string[] {
    switch (this.mode) {
      case "user":
        return ["enable  ping  show  exit"];
      case "priv":
        return ["configure  show  ping  disable  exit"];
      case "config":
        return ["hostname  interface  exit  end"];
      case "if":
        return ["ip address  shutdown  no shutdown  exit  end"];
    }
  }

  // ── utilidades ──────────────────────────────────────────────────────────
  private findOrCreateIface(name: string): NetInterface {
    const existing = findInterface(this.device, name);
    if (existing) return existing;
    // Lenient: si la interfaz no fue declarada en el escenario, la creamos
    // (abajo por defecto). Una interfaz sin enlace no logra conectividad, así
    // que no habilita "trampas" en el grading.
    const created: NetInterface = { name, ip: null, mask: null, up: false };
    this.device.interfaces.push(created);
    return created;
  }

  /** ¿`token` coincide con `full` o alguna abreviatura permitida (prefijo)? */
  private isCmd(token: string, full: string, ...aliases: string[]): boolean {
    const t = token.toLowerCase();
    if (t === full) return true;
    for (const a of aliases) if (t === a) return true;
    // Prefijo de la palabra completa (mín. 2 chars) — IOS acepta abreviaturas.
    if (t.length >= 2 && full.startsWith(t)) return true;
    return false;
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
