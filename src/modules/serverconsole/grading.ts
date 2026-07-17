/**
 * Calificación DETERMINISTA de la pregunta "Consola de servidor" (`so_consola`)
 * — PURA. Compara el estado FINAL del sistema virtual (y el historial de
 * comandos) contra aserciones del docente. Mismo contrato que
 * `network/grading.ts` (earned/total/ratio/items) para reusar el pipeline de
 * calificación del taker.
 */
import {
  type System,
  getNode,
  modeToOctalStr,
  resolvePath,
} from "./system";

export type ServerAssertion =
  | { kind: "file_exists"; path: string; points: number; label?: string }
  | { kind: "dir_exists"; path: string; points: number; label?: string }
  | { kind: "file_mode"; path: string; mode: string; points: number; label?: string }
  | { kind: "file_owner"; path: string; owner: string; points: number; label?: string }
  | { kind: "file_group"; path: string; group: string; points: number; label?: string }
  | { kind: "file_contains"; path: string; text: string; points: number; label?: string }
  | { kind: "user_exists"; user: string; points: number; label?: string }
  | { kind: "group_exists"; group: string; points: number; label?: string }
  | { kind: "user_in_group"; user: string; group: string; points: number; label?: string }
  | { kind: "service_active"; service: string; points: number; label?: string }
  | { kind: "service_enabled"; service: string; points: number; label?: string }
  | { kind: "package_installed"; package: string; points: number; label?: string }
  | { kind: "cron_matches"; pattern: string; points: number; label?: string }
  | { kind: "command_used"; pattern: string; points: number; label?: string };

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
  ratio: number;
  items: GradeItem[];
}

export interface ServerSubmissionState {
  system: System;
  history?: string[];
}

function defaultLabel(a: ServerAssertion): string {
  switch (a.kind) {
    case "file_exists": return `existe el archivo ${a.path}`;
    case "dir_exists": return `existe el directorio ${a.path}`;
    case "file_mode": return `${a.path} con permisos ${a.mode}`;
    case "file_owner": return `${a.path} pertenece a ${a.owner}`;
    case "file_group": return `${a.path} tiene grupo ${a.group}`;
    case "file_contains": return `${a.path} contiene "${a.text}"`;
    case "user_exists": return `existe el usuario ${a.user}`;
    case "group_exists": return `existe el grupo ${a.group}`;
    case "user_in_group": return `${a.user} pertenece al grupo ${a.group}`;
    case "service_active": return `servicio ${a.service} activo (running)`;
    case "service_enabled": return `servicio ${a.service} habilitado (enabled)`;
    case "package_installed": return `paquete ${a.package} instalado`;
    case "cron_matches": return `crontab con una línea que coincide con "${a.pattern}"`;
    case "command_used": return `usó un comando que coincide con "${a.pattern}"`;
  }
}

function matchPattern(pattern: string, lines: string[]): boolean {
  const re = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2].includes("i") ? re[2] : re[2] + "i");
      return lines.some((l) => rx.test(l));
    } catch { /* cae a substring */ }
  }
  const needle = pattern.toLowerCase();
  return lines.some((l) => l.toLowerCase().includes(needle));
}

function evalAssertion(a: ServerAssertion, st: ServerSubmissionState): { passed: boolean; detail?: string } {
  const { system } = st;
  const nodeAt = (p: string) => getNode(system, resolvePath(system, p));
  switch (a.kind) {
    case "file_exists": {
      const n = nodeAt(a.path);
      return { passed: !!n && n.type === "file", detail: n ? (n.type === "dir" ? "es un directorio, no un archivo" : undefined) : "no existe" };
    }
    case "dir_exists": {
      const n = nodeAt(a.path);
      return { passed: !!n && n.type === "dir", detail: n ? undefined : "no existe" };
    }
    case "file_mode": {
      const n = nodeAt(a.path);
      if (!n) return { passed: false, detail: "no existe" };
      const want = a.mode.replace(/^0/, "").padStart(3, "0");
      const got = modeToOctalStr(n.mode);
      return { passed: got === want, detail: got === want ? undefined : `permisos actuales: ${got}` };
    }
    case "file_owner": {
      const n = nodeAt(a.path);
      if (!n) return { passed: false, detail: "no existe" };
      return { passed: n.owner === a.owner, detail: n.owner === a.owner ? undefined : `dueño actual: ${n.owner}` };
    }
    case "file_group": {
      const n = nodeAt(a.path);
      if (!n) return { passed: false, detail: "no existe" };
      return { passed: n.group === a.group, detail: n.group === a.group ? undefined : `grupo actual: ${n.group}` };
    }
    case "file_contains": {
      const n = nodeAt(a.path);
      if (!n || n.type !== "file") return { passed: false, detail: "no existe o no es archivo" };
      return { passed: n.content.includes(a.text), detail: n.content.includes(a.text) ? undefined : "el contenido no incluye el texto" };
    }
    case "user_exists":
      return { passed: system.users.includes(a.user), detail: system.users.includes(a.user) ? undefined : "usuario no creado" };
    case "group_exists":
      return { passed: !!system.groups[a.group], detail: system.groups[a.group] ? undefined : "grupo no creado" };
    case "user_in_group": {
      const members = system.groups[a.group] || [];
      const ok = members.includes(a.user);
      return { passed: ok, detail: ok ? undefined : (system.groups[a.group] ? `${a.user} no está en ${a.group}` : `grupo ${a.group} no existe`) };
    }
    case "service_active": {
      const s = system.services[a.service];
      return { passed: !!s && s.active, detail: s ? (s.active ? undefined : "inactivo") : "servicio no existe" };
    }
    case "service_enabled": {
      const s = system.services[a.service];
      return { passed: !!s && s.enabled, detail: s ? (s.enabled ? undefined : "no habilitado (disabled)") : "servicio no existe" };
    }
    case "package_installed":
      return { passed: system.packages.includes(a.package), detail: system.packages.includes(a.package) ? undefined : "paquete no instalado" };
    case "cron_matches":
      return { passed: matchPattern(a.pattern, system.cron), detail: matchPattern(a.pattern, system.cron) ? undefined : "sin línea de cron que coincida" };
    case "command_used":
      return { passed: matchPattern(a.pattern, st.history ?? []), detail: matchPattern(a.pattern, st.history ?? []) ? undefined : "comando no usado" };
  }
}

/** Califica la entrega contra las aserciones. Devuelve ratio 0..1 + desglose. */
export function gradeServer(st: ServerSubmissionState, assertions: ServerAssertion[]): GradeResult {
  const items: GradeItem[] = [];
  let earned = 0, total = 0;
  for (const a of assertions) {
    const points = Math.max(0, a.points || 0);
    total += points;
    const { passed, detail } = evalAssertion(a, st);
    const gained = passed ? points : 0;
    earned += gained;
    items.push({ label: a.label?.trim() || defaultLabel(a), passed, points, earned: gained, detail });
  }
  return { earned, total, ratio: total > 0 ? earned / total : 0, items };
}
