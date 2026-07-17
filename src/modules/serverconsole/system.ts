/**
 * Sistema Linux VIRTUAL — modelo PURO (sin DOM), base de la pregunta
 * "Consola de servidor" (`so_consola`). Es el análogo de `network/topology.ts`
 * pero para administración de un servidor: un árbol de archivos con
 * dueño/grupo/permisos octales, usuarios, grupos, servicios (systemd),
 * paquetes instalados y tareas cron. El intérprete de shell lo MUTA in place y
 * la calificación determinista compara su estado final contra aserciones.
 *
 * NO es un Linux real: implementa un subconjunto acotado suficiente para los
 * talleres de "Administración de Sistemas Operativos de Servidor" (recorrido de
 * archivos, permisos, usuarios/grupos, servicios, almacenamiento, procesos,
 * cron, respaldos). Un comando no soportado responde "command not found" o un
 * mensaje claro, sin romper el estado.
 */

export interface BaseNode {
  name: string;
  owner: string;
  group: string;
  /** Permisos como número octal (p.ej. 0o644). */
  mode: number;
}
export interface FileNode extends BaseNode {
  type: "file";
  content: string;
}
export interface DirNode extends BaseNode {
  type: "dir";
  children: Record<string, FsNode>;
}
export type FsNode = FileNode | DirNode;

export interface ServiceState {
  active: boolean;
  enabled: boolean;
}

export interface System {
  /** Directorio actual (ruta absoluta, sin "/" final salvo raíz). */
  cwd: string;
  /** Usuario efectivo actual ("root" tras sudo, o el usuario del escenario). */
  user: string;
  /** Raíz "/" del árbol de archivos. */
  root: DirNode;
  /** Usuarios existentes. */
  users: string[];
  /** grupo → miembros. */
  groups: Record<string, string[]>;
  /** servicio → estado. */
  services: Record<string, ServiceState>;
  /** Paquetes instalados. */
  packages: string[];
  /** Líneas de crontab del usuario. */
  cron: string[];
  /** Variables de entorno (HOME, etc.). */
  env: Record<string, string>;
}

// ── Permisos ──────────────────────────────────────────────────────────────

/** "rwxr-xr-x" desde un modo octal. */
export function modeToRwx(mode: number): string {
  const bit = (m: number, r: number, w: number, x: number) =>
    `${m & r ? "r" : "-"}${m & w ? "w" : "-"}${m & x ? "x" : "-"}`;
  return (
    bit(mode, 0o400, 0o200, 0o100) +
    bit(mode, 0o040, 0o020, 0o010) +
    bit(mode, 0o004, 0o002, 0o001)
  );
}

/** Modo octal → string de 3-4 dígitos ("644", "0640"→"640"). */
export function modeToOctalStr(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/** Parsea un modo de `chmod`: octal ("640","0640") o simbólico básico
 *  ("u+x","g-w","a+r","u=rw,g=r,o="). Devuelve el nuevo modo o null si inválido. */
export function applyChmod(current: number, spec: string): number | null {
  const s = spec.trim();
  if (/^[0-7]{3,4}$/.test(s)) return parseInt(s, 8) & 0o7777;
  // Simbólico: lista separada por comas de <who><op><perms>.
  let mode = current;
  const WHO: Record<string, number[]> = {
    u: [0o400, 0o200, 0o100],
    g: [0o040, 0o020, 0o010],
    o: [0o004, 0o002, 0o001],
  };
  const permBits = (who: string[], perms: string): number => {
    let bits = 0;
    for (const w of who) {
      const [r, wr, x] = WHO[w];
      if (perms.includes("r")) bits |= r;
      if (perms.includes("w")) bits |= wr;
      if (perms.includes("x")) bits |= x;
    }
    return bits;
  };
  for (const clause of s.split(",")) {
    const m = /^([ugoa]*)([+\-=])([rwx]*)$/.exec(clause.trim());
    if (!m) return null;
    const whoLetters = (m[1] || "a").replace("a", "ugo").split("");
    const who = Array.from(new Set(whoLetters)).filter((w) => WHO[w]);
    const op = m[2];
    const bits = permBits(who, m[3]);
    if (op === "+") mode |= bits;
    else if (op === "-") mode &= ~bits;
    else {
      // "=" limpia los bits de ese "who" y setea los indicados.
      let clearMask = 0;
      for (const w of who) clearMask |= WHO[w].reduce((a, b) => a | b, 0);
      mode = (mode & ~clearMask) | bits;
    }
  }
  return mode & 0o7777;
}

// ── Rutas ───────────────────────────────────────────────────────────────────

/** Normaliza una ruta ABSOLUTA (colapsa ".", "..", "//"). */
export function normalizeAbs(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0 && p !== ".");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return "/" + stack.join("/");
}

/** Resuelve una ruta (relativa a cwd, con ~, ., ..) a absoluta normalizada. */
export function resolvePath(sys: System, path: string): string {
  let p = path.trim();
  if (p === "" ) return sys.cwd;
  if (p === "~" || p.startsWith("~/")) {
    const home = sys.env.HOME || `/home/${sys.user}`;
    p = home + p.slice(1);
  }
  if (!p.startsWith("/")) p = (sys.cwd === "/" ? "" : sys.cwd) + "/" + p;
  return normalizeAbs(p);
}

/** Devuelve el nodo en una ruta absoluta normalizada, o null. */
export function getNode(sys: System, absPath: string): FsNode | null {
  if (absPath === "/") return sys.root;
  const parts = absPath.split("/").filter(Boolean);
  let cur: FsNode = sys.root;
  for (const part of parts) {
    if (cur.type !== "dir") return null;
    // Anotación explícita: rompe una inferencia circular espuria de tsc (TS7022)
    // sobre `next` y documenta el tipo del acceso indexado.
    const next: FsNode | undefined = cur.children[part];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** {parent, base} de una ruta absoluta ("/a/b" → parent="/a", base="b"). */
export function splitPath(absPath: string): { parent: string; base: string } {
  if (absPath === "/") return { parent: "/", base: "" };
  const idx = absPath.lastIndexOf("/");
  const parent = idx === 0 ? "/" : absPath.slice(0, idx);
  return { parent, base: absPath.slice(idx + 1) };
}

export function getDir(sys: System, absPath: string): DirNode | null {
  const n = getNode(sys, absPath);
  return n && n.type === "dir" ? n : null;
}

// ── Fábrica de sistema base ──────────────────────────────────────────────────

function dir(name: string, owner = "root", group = "root", mode = 0o755): DirNode {
  return { type: "dir", name, owner, group, mode, children: {} };
}
function file(name: string, content = "", owner = "root", group = "root", mode = 0o644): FileNode {
  return { type: "file", name, owner, group, mode, content };
}

/**
 * Sistema Linux base mínimo pero realista para los talleres: FHS con
 * /etc, /var/log, /home/<user>, /tmp, /bin; un usuario normal + root; un par de
 * servicios y paquetes típicos. El escenario del taller lo puede extender.
 */
export function baseSystem(username = "alumno"): System {
  const root = dir("/");
  const add = (parent: DirNode, node: FsNode) => (parent.children[node.name] = node);
  for (const d of ["etc", "var", "home", "tmp", "bin", "root", "opt"]) add(root, dir(d));
  const varDir = root.children["var"] as DirNode;
  add(varDir, dir("log"));
  const logDir = varDir.children["log"] as DirNode;
  add(logDir, file("syslog", "Jan  1 00:00:00 server systemd[1]: Started.\n"));
  const etc = root.children["etc"] as DirNode;
  add(etc, file("hostname", "server\n"));
  add(etc, file("passwd", `root:x:0:0:root:/root:/bin/bash\n${username}:x:1000:1000::/home/${username}:/bin/bash\n`));
  const home = root.children["home"] as DirNode;
  const userHome = dir(username, username, username, 0o755);
  add(home, userHome);
  return {
    cwd: `/home/${username}`,
    user: username,
    root,
    users: ["root", username],
    groups: { root: ["root"], [username]: [username] },
    services: {
      ssh: { active: true, enabled: true },
      cron: { active: true, enabled: true },
    },
    packages: ["bash", "coreutils", "systemd"],
    cron: [],
    env: { HOME: `/home/${username}`, USER: username },
  };
}

/** Clon profundo del sistema (para reanudar/reiniciar sin aliasing). */
export function cloneSystem(sys: System): System {
  return JSON.parse(JSON.stringify(sys)) as System;
}
