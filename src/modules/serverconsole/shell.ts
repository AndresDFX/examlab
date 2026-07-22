/**
 * Intérprete de shell (bash-like) PURO sobre un `System` virtual — análogo de
 * `network/ios-interpreter.ts`. Ejecuta UNA línea y devuelve las líneas de
 * salida; muta el sistema in place y guarda el historial para calificación.
 *
 * Subconjunto acotado para los talleres de Administración de Servidor:
 * navegación (pwd/cd/ls), archivos (mkdir/touch/echo>/cat/cp/mv/rm), permisos
 * (chmod/chown/chgrp), usuarios/grupos (useradd/groupadd/usermod/id),
 * software/servicios (apt/systemctl), almacenamiento (df/du), procesos
 * (ps/top/kill), cron (crontab), red/logs/respaldos (ip/ss/journalctl/tar).
 * Comandos privilegiados exigen root (vía `sudo`), como en un servidor real.
 */
import {
  type System,
  type DirNode,
  type FsNode,
  applyChmod,
  getNode,
  getDir,
  modeToOctalStr,
  modeToRwx,
  resolvePath,
  splitPath,
} from "./system";

const PRIVILEGED = new Set(["useradd", "groupadd", "usermod", "userdel", "groupdel"]);

/** Comandos conocidos — para el autocompletado con Tab (1er token). */
const COMMANDS = [
  "pwd", "whoami", "hostname", "echo", "cd", "ls", "mkdir", "touch", "cat",
  "cp", "mv", "rm", "chmod", "chown", "chgrp", "groupadd", "useradd", "adduser",
  "usermod", "id", "apt", "apt-get", "systemctl", "df", "du", "ps", "top",
  "kill", "crontab", "ip", "ss", "netstat", "journalctl", "tar", "clear",
  "sudo", "nano", "vi", "vim", "python3", "python", "pip3", "pip",
  // Comandos frecuentes del curso de Administración de SO de servidor.
  "grep", "find", "head", "tail", "wc", "stat", "which", "file",
  "free", "uname", "uptime", "date", "env", "export", "history",
  "groups", "passwd", "su", "getent", "dpkg", "service", "man",
];

/** Prefijo común más largo de una lista de strings (para el autocompletado). */
function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let p = items[0];
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}

/** Tokeniza respetando comillas simples/dobles. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export interface ShellResult {
  out: string[];
}

export class ShellInterpreter {
  readonly sys: System;
  /** Historial de líneas ejecutadas (no vacías) — para command_used. */
  readonly history: string[] = [];
  /**
   * Solicitud de editor de texto pendiente (nano/vi/vim). Como la consola es
   * simulada (no hay PTY), un `nano <archivo>` NO edita inline: el comando
   * setea esto y la UI (ServerConsole) abre un editor overlay. Al guardar la UI
   * llama `saveEditor(content)`; al salir sin guardar, `cancelEditor()`.
   */
  editorRequest: { path: string; display: string; content: string } | null = null;

  constructor(sys: System) {
    this.sys = sys;
  }

  prompt(): string {
    const u = this.sys.user;
    const host = this.hostname();
    const cwd = this.displayCwd();
    return `${u}@${host}:${cwd}${u === "root" ? "#" : "$"} `;
  }

  private hostname(): string {
    const f = getNode(this.sys, "/etc/hostname");
    return f && f.type === "file" ? f.content.trim() || "server" : "server";
  }

  private displayCwd(): string {
    const home = this.sys.env.HOME;
    if (home && this.sys.cwd === home) return "~";
    if (home && this.sys.cwd.startsWith(home + "/")) return "~" + this.sys.cwd.slice(home.length);
    return this.sys.cwd;
  }

  /** Ejecuta UNA línea. Soporta `sudo`, redirección `>`/`>>` y `... | crontab -`. */
  execute(rawLine: string): string[] {
    const line = rawLine.trim();
    if (!line) return [];
    this.history.push(line);
    if (line.startsWith("#")) return [];

    // Pipe soportado SOLO para `<algo> | crontab -` (agregar cron).
    const pipeIdx = line.indexOf("| crontab -");
    if (pipeIdx >= 0) {
      const left = line.slice(0, pipeIdx).trim();
      const lt = tokenize(left);
      if (lt[0] === "echo") {
        const text = lt.slice(1).join(" ");
        this.sys.cron.push(text);
        return [];
      }
      return ["crontab: entrada no reconocida"];
    }

    // Redirección de salida a archivo.
    let redirect: { path: string; append: boolean } | null = null;
    let work = line;
    const rd = /\s(>>|>)\s*(\S+)\s*$/.exec(line);
    if (rd) {
      redirect = { path: rd[2], append: rd[1] === ">>" };
      work = line.slice(0, rd.index).trim();
    }

    const tokens = tokenize(work);
    let asRoot = false;
    if (tokens[0] === "sudo") {
      asRoot = true;
      tokens.shift();
    }
    if (tokens.length === 0) return [];

    const cmd = tokens[0];
    const args = tokens.slice(1);
    const prevUser = this.sys.user;
    if (asRoot) this.sys.user = "root";
    try {
      const result = this.dispatch(cmd, args);
      if (redirect) {
        this.writeFile(redirect.path, result.out.join("\n") + (result.out.length ? "\n" : ""), redirect.append);
        return [];
      }
      return result.out;
    } finally {
      this.sys.user = prevUser;
    }
  }

  private isRoot(): boolean {
    return this.sys.user === "root";
  }

  private dispatch(cmd: string, args: string[]): ShellResult {
    if (PRIVILEGED.has(cmd) && !this.isRoot()) {
      return { out: [`${cmd}: Permission denied (ejecuta con sudo)`] };
    }
    switch (cmd) {
      case "pwd": return { out: [this.sys.cwd] };
      case "whoami": return { out: [this.sys.user] };
      case "hostname": return { out: [this.hostname()] };
      case "echo": return { out: [args.join(" ")] };
      case "cd": return this.cd(args);
      case "ls": return this.ls(args);
      case "mkdir": return this.mkdir(args);
      case "touch": return this.touch(args);
      case "cat": return this.cat(args);
      case "cp": return this.cpmv(args, false);
      case "mv": return this.cpmv(args, true);
      case "rm": return this.rm(args);
      case "chmod": return this.chmod(args);
      case "chown": return this.chown(args);
      case "chgrp": return this.chgrp(args);
      case "groupadd": return this.groupadd(args);
      case "useradd": case "adduser": return this.useradd(args);
      case "usermod": return this.usermod(args);
      case "id": return this.id(args);
      case "apt": case "apt-get": return this.apt(args);
      case "systemctl": return this.systemctl(args);
      case "df": return this.df(args);
      case "du": return this.du(args);
      case "ps": return this.ps(args);
      case "top": return this.top();
      case "kill": return { out: [] };
      case "crontab": return this.crontab(args);
      case "ip": return this.ip(args);
      case "ss": case "netstat": return { out: ["State  Recv-Q Send-Q Local Address:Port", "LISTEN 0      128    0.0.0.0:22", "LISTEN 0      128    0.0.0.0:80"] };
      case "journalctl": return this.journalctl();
      case "tar": return this.tar(args);
      case "clear": return { out: [] };
      case "nano": case "vi": case "vim": return this.nano(cmd, args);
      case "python3": case "python": return this.python(cmd, args);
      case "pip3": case "pip": return this.pip(cmd, args);
      case "grep": return this.grep(args);
      case "find": return this.find(args);
      case "head": return this.headTail(args, true);
      case "tail": return this.headTail(args, false);
      case "wc": return this.wc(args);
      case "stat": return this.stat(args);
      case "file": return this.fileCmd(args);
      case "which": return this.which(args);
      case "free": return this.free(args);
      case "uname": return this.uname(args);
      case "uptime": return { out: ["00:00:01 up 1 day,  1:23,  1 user,  load average: 0,15, 0,10, 0,05"] };
      case "date": return { out: ["lun ene  1 00:00:01 -05 2026"] };
      case "env": return { out: Object.entries(this.sys.env).map(([k, v]) => `${k}=${v}`) };
      case "export": return this.exportCmd(args);
      case "history": return { out: this.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`) };
      case "groups": return this.groupsCmd(args);
      case "passwd": return { out: ["(passwd requiere entrada interactiva, no disponible en la consola simulada)"] };
      case "su": return { out: ["(su requiere contraseña interactiva; usá `sudo <comando>` para tareas privilegiadas)"] };
      case "getent": return this.getent(args);
      case "dpkg": return this.dpkg(args);
      case "service": return this.serviceCmd(args);
      case "man": return this.man(args);
      default:
        return { out: [`${cmd}: command not found`] };
    }
  }

  // ── comandos ──────────────────────────────────────────────────────────────

  private cd(args: string[]): ShellResult {
    const target = args[0] ?? this.sys.env.HOME ?? "/";
    const abs = resolvePath(this.sys, target);
    const node = getNode(this.sys, abs);
    if (!node) return { out: [`cd: ${target}: No existe el fichero o el directorio`] };
    if (node.type !== "dir") return { out: [`cd: ${target}: No es un directorio`] };
    this.sys.cwd = abs;
    return { out: [] };
  }

  private ls(args: string[]): ShellResult {
    const long = args.some((a) => /^-\w*l/.test(a));
    const all = args.some((a) => /^-\w*a/.test(a));
    const pathArg = args.find((a) => !a.startsWith("-"));
    const abs = resolvePath(this.sys, pathArg ?? ".");
    const node = getNode(this.sys, abs);
    if (!node) return { out: [`ls: no se puede acceder a '${pathArg}': No existe el fichero o el directorio`] };
    const entries: FsNode[] = node.type === "dir" ? Object.values(node.children) : [node];
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    if (!long) {
      const names = sorted.map((n) => n.name);
      return { out: [names.join("  ")].filter(Boolean) };
    }
    const rows = sorted.map((n) => {
      const t = n.type === "dir" ? "d" : "-";
      return `${t}${modeToRwx(n.mode)} 1 ${n.owner} ${n.group} 4096 ene  1 00:00 ${n.name}`;
    });
    return { out: [`total ${sorted.length}`, ...rows] };
  }

  private mkdir(args: string[]): ShellResult {
    const parents = args.includes("-p");
    const targets = args.filter((a) => !a.startsWith("-"));
    for (const t of targets) {
      const abs = resolvePath(this.sys, t);
      if (parents) {
        const parts = abs.split("/").filter(Boolean);
        let cur: DirNode = this.sys.root;
        let path = "";
        for (const part of parts) {
          path += "/" + part;
          const existing = cur.children[part];
          if (existing) {
            if (existing.type !== "dir") return { out: [`mkdir: no se puede crear el directorio '${t}': No es un directorio`] };
            cur = existing;
          } else {
            const nd: DirNode = { type: "dir", name: part, owner: this.sys.user, group: this.sys.user, mode: 0o755, children: {} };
            cur.children[part] = nd;
            cur = nd;
          }
        }
      } else {
        const { parent, base } = splitPath(abs);
        const pdir = getDir(this.sys, parent);
        if (!pdir) return { out: [`mkdir: no se puede crear el directorio '${t}': No existe el fichero o el directorio`] };
        if (pdir.children[base]) return { out: [`mkdir: no se puede crear el directorio '${t}': El fichero ya existe`] };
        pdir.children[base] = { type: "dir", name: base, owner: this.sys.user, group: this.sys.user, mode: 0o755, children: {} };
      }
    }
    return { out: [] };
  }

  private touch(args: string[]): ShellResult {
    for (const t of args.filter((a) => !a.startsWith("-"))) {
      const abs = resolvePath(this.sys, t);
      const existing = getNode(this.sys, abs);
      if (existing) continue;
      const { parent, base } = splitPath(abs);
      const pdir = getDir(this.sys, parent);
      if (!pdir) return { out: [`touch: no se puede efectuar 'touch' sobre '${t}': No existe el fichero o el directorio`] };
      pdir.children[base] = { type: "file", name: base, owner: this.sys.user, group: this.sys.user, mode: 0o644, content: "" };
    }
    return { out: [] };
  }

  private cat(args: string[]): ShellResult {
    const out: string[] = [];
    for (const t of args.filter((a) => !a.startsWith("-"))) {
      const node = getNode(this.sys, resolvePath(this.sys, t));
      if (!node) { out.push(`cat: ${t}: No existe el fichero o el directorio`); continue; }
      if (node.type !== "file") { out.push(`cat: ${t}: Es un directorio`); continue; }
      out.push(...node.content.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")));
    }
    return { out };
  }

  private writeFile(pathArg: string, content: string, append: boolean): void {
    const abs = resolvePath(this.sys, pathArg);
    const { parent, base } = splitPath(abs);
    const pdir = getDir(this.sys, parent);
    if (!pdir) return;
    const existing = pdir.children[base];
    if (existing && existing.type === "file") {
      existing.content = append ? existing.content + content : content;
    } else if (!existing) {
      pdir.children[base] = { type: "file", name: base, owner: this.sys.user, group: this.sys.user, mode: 0o644, content };
    }
  }

  /**
   * nano/vi/vim — abre un editor de texto sobre un archivo. Como no hay PTY,
   * NO edita inline: setea `editorRequest` y devuelve sin salida; la UI abre el
   * editor overlay. Sin argumento abre un buffer nuevo sin nombre (se pedirá al
   * guardar); con un directorio como destino, error como el nano real.
   */
  private nano(cmd: string, args: string[]): ShellResult {
    const target = args.find((a) => !a.startsWith("-"));
    if (!target) {
      // Buffer nuevo sin nombre: se guarda con "touch"-like al escribir el nombre.
      this.editorRequest = { path: "", display: cmd, content: "" };
      return { out: [] };
    }
    const abs = resolvePath(this.sys, target);
    const node = getNode(this.sys, abs);
    if (node && node.type === "dir") return { out: [`${cmd}: ${target}: Es un directorio`] };
    const { parent } = splitPath(abs);
    if (!node && !getDir(this.sys, parent)) {
      return { out: [`${cmd}: no se puede crear ${target}: No existe el directorio`] };
    }
    this.editorRequest = {
      path: abs,
      display: target,
      content: node && node.type === "file" ? node.content : "",
    };
    return { out: [] };
  }

  /** Guarda el contenido del editor en el archivo (creándolo si es nuevo). */
  saveEditor(content: string): string[] {
    const req = this.editorRequest;
    this.editorRequest = null;
    if (!req || !req.path) return [];
    const { parent, base } = splitPath(req.path);
    const pdir = getDir(this.sys, parent);
    if (!pdir) return [`nano: no se pudo guardar ${req.display}: No existe el directorio`];
    const existing = pdir.children[base];
    if (existing && existing.type === "dir") return [`nano: ${req.display}: Es un directorio`];
    if (existing && existing.type === "file") {
      existing.content = content;
    } else {
      pdir.children[base] = {
        type: "file",
        name: base,
        owner: this.sys.user,
        group: this.sys.user,
        mode: 0o644,
        content,
      };
    }
    return [];
  }

  /** Cierra el editor sin guardar. */
  cancelEditor(): void {
    this.editorRequest = null;
  }

  /**
   * Autocompletado con Tab. Completa el ÚLTIMO token: si es el 1er token (o
   * viene tras `sudo`) → nombres de comando; si es un argumento → archivos/
   * directorios (respeta prefijos de ruta como `/etc/pas` o `sub/fi`).
   * Devuelve la línea (posiblemente completada al prefijo común) y, cuando hay
   * varias opciones, la lista para mostrarla como en bash.
   */
  complete(rawLine: string): { line: string; candidates: string[] } {
    const line = rawLine;
    const endsWithSpace = /\s$/.test(line);
    let head = "";
    let token = "";
    if (endsWithSpace) {
      head = line;
      token = "";
    } else {
      const idx = line.lastIndexOf(" ");
      head = idx < 0 ? "" : line.slice(0, idx + 1);
      token = idx < 0 ? line : line.slice(idx + 1);
    }
    const before = tokenize(head.trim());
    const eff = before[0] === "sudo" ? before.slice(1) : before;
    const completingCommand = eff.length === 0;

    if (completingCommand) {
      const cands = COMMANDS.filter((c) => c.startsWith(token)).sort();
      if (cands.length === 0) return { line, candidates: [] };
      if (cands.length === 1) return { line: head + cands[0] + " ", candidates: [] };
      const common = longestCommonPrefix(cands);
      return { line: head + common, candidates: cands };
    }

    // Argumento → completar ruta.
    const slash = token.lastIndexOf("/");
    const dirPart = slash < 0 ? "" : token.slice(0, slash + 1);
    const base = slash < 0 ? token : token.slice(slash + 1);
    const dirAbs = resolvePath(this.sys, dirPart === "" ? "." : dirPart);
    const dirNode = getDir(this.sys, dirAbs);
    if (!dirNode) return { line, candidates: [] };
    const entries = Object.values(dirNode.children)
      .filter((n) => n.name.startsWith(base))
      .map((n) => ({ name: n.name, isDir: n.type === "dir" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) return { line, candidates: [] };
    if (entries.length === 1) {
      const e = entries[0];
      return { line: head + dirPart + e.name + (e.isDir ? "/" : " "), candidates: [] };
    }
    const common = longestCommonPrefix(entries.map((e) => e.name));
    return {
      line: head + dirPart + common,
      candidates: entries.map((e) => (e.isDir ? e.name + "/" : e.name)),
    };
  }

  private cpmv(args: string[], move: boolean): ShellResult {
    const paths = args.filter((a) => !a.startsWith("-"));
    if (paths.length < 2) return { out: [`${move ? "mv" : "cp"}: faltan operandos`] };
    const srcAbs = resolvePath(this.sys, paths[0]);
    const src = getNode(this.sys, srcAbs);
    if (!src) return { out: [`${move ? "mv" : "cp"}: no se puede efectuar la operación sobre '${paths[0]}': No existe el fichero o el directorio`] };
    let dstAbs = resolvePath(this.sys, paths[1]);
    const dstNode = getNode(this.sys, dstAbs);
    // Si el destino es un directorio existente, copiar DENTRO con el mismo nombre.
    if (dstNode && dstNode.type === "dir") dstAbs = (dstAbs === "/" ? "" : dstAbs) + "/" + src.name;
    const { parent, base } = splitPath(dstAbs);
    const pdir = getDir(this.sys, parent);
    if (!pdir) return { out: [`destino '${paths[1]}': No existe el directorio`] };
    const copy: FsNode = JSON.parse(JSON.stringify(src));
    copy.name = base;
    pdir.children[base] = copy;
    if (move) {
      const { parent: sp, base: sb } = splitPath(srcAbs);
      const sdir = getDir(this.sys, sp);
      if (sdir) delete sdir.children[sb];
    }
    return { out: [] };
  }

  private rm(args: string[]): ShellResult {
    const recursive = args.some((a) => /^-\w*r/.test(a));
    for (const t of args.filter((a) => !a.startsWith("-"))) {
      const abs = resolvePath(this.sys, t);
      const node = getNode(this.sys, abs);
      if (!node) return { out: [`rm: no se puede borrar '${t}': No existe el fichero o el directorio`] };
      if (node.type === "dir" && !recursive) return { out: [`rm: no se puede borrar '${t}': Es un directorio`] };
      const { parent, base } = splitPath(abs);
      const pdir = getDir(this.sys, parent);
      if (pdir) delete pdir.children[base];
    }
    return { out: [] };
  }

  private eachTarget(paths: string[], fn: (n: FsNode) => void, notFound: (t: string) => string): ShellResult {
    for (const t of paths) {
      const node = getNode(this.sys, resolvePath(this.sys, t));
      if (!node) return { out: [notFound(t)] };
      fn(node);
    }
    return { out: [] };
  }

  private chmod(args: string[]): ShellResult {
    const rest = args.filter((a) => !/^-\w+$/.test(a) || /^[0-7]+$/.test(a.replace(/^-/, "")));
    const spec = rest[0];
    const targets = rest.slice(1);
    if (!spec || targets.length === 0) return { out: ["chmod: faltan operandos"] };
    let bad = "";
    const res = this.eachTarget(targets, (n) => {
      const nm = applyChmod(n.mode, spec);
      if (nm == null) bad = spec;
      else n.mode = nm;
    }, (t) => `chmod: no se puede acceder a '${t}': No existe el fichero o el directorio`);
    if (bad) return { out: [`chmod: modo incorrecto: '${bad}'`] };
    return res;
  }

  private chown(args: string[]): ShellResult {
    const rest = args.filter((a) => !a.startsWith("-"));
    const spec = rest[0];
    const targets = rest.slice(1);
    if (!spec || targets.length === 0) return { out: ["chown: faltan operandos"] };
    const [owner, group] = spec.split(":");
    return this.eachTarget(targets, (n) => {
      if (owner) n.owner = owner;
      if (group) n.group = group;
    }, (t) => `chown: no se puede acceder a '${t}': No existe el fichero o el directorio`);
  }

  private chgrp(args: string[]): ShellResult {
    const rest = args.filter((a) => !a.startsWith("-"));
    const group = rest[0];
    const targets = rest.slice(1);
    if (!group || targets.length === 0) return { out: ["chgrp: faltan operandos"] };
    return this.eachTarget(targets, (n) => { n.group = group; },
      (t) => `chgrp: no se puede acceder a '${t}': No existe el fichero o el directorio`);
  }

  private groupadd(args: string[]): ShellResult {
    const name = args.filter((a) => !a.startsWith("-"))[0];
    if (!name) return { out: ["groupadd: falta el nombre del grupo"] };
    if (this.sys.groups[name]) return { out: [`groupadd: el grupo '${name}' ya existe`] };
    this.sys.groups[name] = [];
    return { out: [] };
  }

  private useradd(args: string[]): ShellResult {
    let groups: string[] = [];
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-G") { groups = (args[++i] || "").split(",").filter(Boolean); }
      else if (args[i] === "-m" || args[i] === "-s" || args[i] === "-d") { if (args[i] !== "-m") i++; }
      else if (!args[i].startsWith("-")) positional.push(args[i]);
    }
    const name = positional[0];
    if (!name) return { out: ["useradd: falta el nombre de usuario"] };
    if (this.sys.users.includes(name)) return { out: [`useradd: el usuario '${name}' ya existe`] };
    this.sys.users.push(name);
    this.sys.groups[name] = this.sys.groups[name] || [name]; // grupo primario homónimo
    for (const g of groups) {
      this.sys.groups[g] = this.sys.groups[g] || [];
      if (!this.sys.groups[g].includes(name)) this.sys.groups[g].push(name);
    }
    // home
    const home = getDir(this.sys, "/home");
    if (home && !home.children[name]) home.children[name] = { type: "dir", name, owner: name, group: name, mode: 0o755, children: {} };
    return { out: [] };
  }

  private usermod(args: string[]): ShellResult {
    let append = false, groups: string[] = [];
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-aG" || args[i] === "-G") { append = args[i] === "-aG"; groups = (args[++i] || "").split(",").filter(Boolean); }
      else if (!args[i].startsWith("-")) positional.push(args[i]);
    }
    const user = positional[0];
    if (!user) return { out: ["usermod: falta el usuario"] };
    if (!this.sys.users.includes(user)) return { out: [`usermod: el usuario '${user}' no existe`] };
    if (!append) {
      // -G reemplaza los grupos secundarios: quitar user de todos salvo su primario.
      for (const g of Object.keys(this.sys.groups)) if (g !== user) this.sys.groups[g] = this.sys.groups[g].filter((m) => m !== user);
    }
    for (const g of groups) {
      this.sys.groups[g] = this.sys.groups[g] || [];
      if (!this.sys.groups[g].includes(user)) this.sys.groups[g].push(user);
    }
    return { out: [] };
  }

  private id(args: string[]): ShellResult {
    const user = args.filter((a) => !a.startsWith("-"))[0] || this.sys.user;
    if (!this.sys.users.includes(user)) return { out: [`id: '${user}': no existe ese usuario`] };
    const memberOf = Object.entries(this.sys.groups).filter(([, m]) => m.includes(user)).map(([g]) => g);
    return { out: [`uid=1000(${user}) gid=1000(${user}) grupos=${memberOf.join(",") || user}`] };
  }

  private apt(args: string[]): ShellResult {
    const sub = args[0];
    if (sub === "update") return { out: ["Leyendo lista de paquetes... Hecho"] };
    if (sub === "install") {
      if (!this.isRoot()) return { out: ["E: No se pudo abrir el bloqueo /var/lib/dpkg/lock — ¿es root? (usa sudo)"] };
      const pkgs = args.slice(1).filter((a) => !a.startsWith("-"));
      for (const p of pkgs) if (!this.sys.packages.includes(p)) this.sys.packages.push(p);
      return { out: pkgs.map((p) => `Configurando ${p} ...`).concat(["Hecho"]) };
    }
    return { out: [`apt: subcomando '${sub ?? ""}' no soportado en la simulación`] };
  }

  private systemctl(args: string[]): ShellResult {
    const action = args[0];
    const svc = (args[1] || "").replace(/\.service$/, "");
    if (!action) return { out: ["systemctl: falta la acción"] };
    if (action === "status") {
      const s = this.sys.services[svc];
      if (!s) return { out: [`Unit ${svc}.service could not be found.`] };
      return { out: [
        `● ${svc}.service`,
        `   Loaded: loaded (/lib/systemd/system/${svc}.service; ${s.enabled ? "enabled" : "disabled"})`,
        `   Active: ${s.active ? "active (running)" : "inactive (dead)"}`,
      ] };
    }
    const priv = ["start", "stop", "enable", "disable", "restart"];
    if (priv.includes(action) && !this.isRoot()) return { out: [`Failed to ${action} ${svc}.service: Access denied (usa sudo)`] };
    const s = (this.sys.services[svc] = this.sys.services[svc] || { active: false, enabled: false });
    if (action === "start" || action === "restart") s.active = true;
    else if (action === "stop") s.active = false;
    else if (action === "enable") s.enabled = true;
    else if (action === "disable") s.enabled = false;
    else return { out: [`systemctl: acción '${action}' no soportada`] };
    return { out: [] };
  }

  private df(_args: string[]): ShellResult {
    return { out: [
      "S.ficheros     Tamaño Usados Disp Uso% Montado en",
      "/dev/sda1         40G    12G  26G  32% /",
      "tmpfs            2,0G      0 2,0G   0% /dev/shm",
    ] };
  }

  private du(args: string[]): ShellResult {
    const target = args.filter((a) => !a.startsWith("-"))[0] ?? ".";
    return { out: [`128M\t${target}`] };
  }

  private ps(args: string[]): ShellResult {
    const aux = args.join("").includes("aux") || args.includes("-ef");
    if (aux) return { out: [
      "USER       PID %CPU %MEM COMMAND",
      "root         1  0.0  0.4 /sbin/init",
      "root       412  0.0  0.6 /usr/sbin/sshd",
      "www-data   980 12.3  3.1 /usr/sbin/apache2",
      `${this.sys.user}  1520  0.1  0.2 bash`,
    ] };
    return { out: ["    PID TTY          TIME CMD", "   1520 pts/0    00:00:00 bash", "   1600 pts/0    00:00:00 ps"] };
  }

  private top(): ShellResult {
    return { out: [
      "top - 00:00:01 up 1 day,  load average: 0,15",
      "  PID USER      %CPU %MEM   COMMAND",
      "  980 www-data  12,3  3,1   apache2",
      "    1 root       0,0  0,4   systemd",
    ] };
  }

  private crontab(args: string[]): ShellResult {
    if (args[0] === "-l") {
      return { out: this.sys.cron.length ? [...this.sys.cron] : ["no crontab for " + this.sys.user] };
    }
    if (args[0] === "-e") {
      return { out: ["(editor no disponible en la simulación) Usa:  echo \"0 2 * * * /ruta\" | crontab -"] };
    }
    if (args[0] === "-r") { this.sys.cron = []; return { out: [] }; }
    return { out: ["crontab: usa -l para listar o `echo \"<linea>\" | crontab -` para agregar"] };
  }

  private ip(args: string[]): ShellResult {
    if (args[0] === "a" || args[0] === "addr" || args.length === 0) {
      return { out: [
        "1: lo: <LOOPBACK,UP> mtu 65536",
        "    inet 127.0.0.1/8 scope host lo",
        "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500",
        "    inet 192.168.1.50/24 brd 192.168.1.255 scope global eth0",
      ] };
    }
    return { out: [`ip: opción '${args[0]}' no soportada en la simulación`] };
  }

  private journalctl(): ShellResult {
    const syslog = getNode(this.sys, "/var/log/syslog");
    const base = syslog && syslog.type === "file" ? syslog.content.trim() : "";
    return { out: [
      ...(base ? base.split("\n") : []),
      "ene 01 00:00:05 server sshd[412]: Server listening on 0.0.0.0 port 22.",
      "ene 01 00:00:06 server systemd[1]: Reached target Multi-User System.",
    ] };
  }

  private tar(args: string[]): ShellResult {
    // tar -czvf <archivo> <ruta...>
    const flagIdx = args.findIndex((a) => a.startsWith("-") && a.includes("f"));
    if (flagIdx < 0) return { out: ["tar: falta el flag -f con el nombre del archivo"] };
    const archive = args[flagIdx + 1];
    const sources = args.slice(flagIdx + 2).filter((a) => !a.startsWith("-"));
    if (!archive) return { out: ["tar: falta el nombre del archivo destino"] };
    // Crear el archivo destino (para que file_exists lo detecte).
    this.writeFile(archive, `# tar gzip de: ${sources.join(" ")}\n`, false);
    return { out: sources.map((s) => resolvePath(this.sys, s).replace(/^\//, "")) };
  }

  /**
   * python3 / python — el binario solo "existe" tras `apt install python3`
   * (antes: command not found, como en un servidor real). Aceptamos `python`
   * como alias de `python3` cuando python3 está instalado (equivalente a
   * `python-is-python3`) para no frenar al alumno que teclea `python`.
   * La consola es un simulador DETERMINISTA: no hay intérprete real. Soporta
   * `--version`/`-V`, `-c "<código>"` y `python3 archivo.py`, evaluando un
   * subconjunto MÍNIMO (llamadas `print(...)` con un literal).
   */
  private python(cmd: string, args: string[]): ShellResult {
    if (!this.sys.packages.includes("python3") && !this.sys.packages.includes("python")) {
      return { out: [`${cmd}: command not found`] };
    }
    const VERSION = "Python 3.11.2";
    if (args.some((a) => a === "--version" || a === "-V")) return { out: [VERSION] };
    const cIdx = args.indexOf("-c");
    if (cIdx >= 0) return { out: this.simulatePython(args[cIdx + 1] ?? "") };
    const script = args.find((a) => !a.startsWith("-"));
    if (script) {
      const node = getNode(this.sys, resolvePath(this.sys, script));
      if (!node) return { out: [`${cmd}: can't open file '${script}': [Errno 2] No such file or directory`] };
      if (node.type !== "file") return { out: [`${cmd}: can't open file '${script}': [Errno 21] Is a directory`] };
      return { out: this.simulatePython(node.content) };
    }
    // Sin argumentos: el REPL interactivo no es viable en la consola simulada.
    return { out: [
      VERSION,
      "Intérprete interactivo no disponible en la consola simulada.",
      "Usá  python3 -c \"print('hola')\"  o  python3 archivo.py",
    ] };
  }

  /** Evalúa un subconjunto MÍNIMO de Python: `print(...)` con UN literal
   *  (cadena entre comillas o número). Alcanza para demostrar que el intérprete
   *  corre tras instalarlo; NO es un intérprete real. */
  private simulatePython(code: string): string[] {
    const out: string[] = [];
    let matched = false;
    for (const line of code.split(/\r?\n/)) {
      const re = /print\s*\(\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        out.push(m[1] ?? m[2] ?? m[3] ?? "");
        matched = true;
      }
    }
    if (!matched && code.trim()) {
      out.push("(la consola simulada solo evalúa print(\"...\") sencillos)");
    }
    return out;
  }

  /** pip3 / pip — disponible cuando python3 está instalado. Simulación acotada:
   *  `--version`, `list` e `install <pkg>` (registra el paquete). */
  private pip(cmd: string, args: string[]): ShellResult {
    if (!this.sys.packages.includes("python3") && !this.sys.packages.includes("python")) {
      return { out: [`${cmd}: command not found`] };
    }
    if (args.some((a) => a === "--version" || a === "-V")) return { out: ["pip 23.0.1 (python 3.11)"] };
    const sub = args[0];
    if (sub === "list") return { out: ["Package    Version", "---------- -------", "pip        23.0.1"] };
    if (sub === "install") {
      const pkgs = args.slice(1).filter((a) => !a.startsWith("-"));
      for (const p of pkgs) if (!this.sys.packages.includes(p)) this.sys.packages.push(p);
      return { out: pkgs.map((p) => `Successfully installed ${p}`) };
    }
    return { out: [`${cmd}: subcomando '${sub ?? ""}' no soportado en la simulación`] };
  }

  // ── Comandos del curso de Administración de SO (texto/búsqueda/sistema) ──────

  private grep(args: string[]): ShellResult {
    const ci = args.includes("-i");
    const nn = args.includes("-n");
    const rest = args.filter((a) => !a.startsWith("-"));
    const pattern = rest[0];
    const files = rest.slice(1);
    if (!pattern || files.length === 0) return { out: ["Uso: grep [-i] [-n] <patrón> <archivo...>"] };
    const needle = ci ? pattern.toLowerCase() : pattern;
    const out: string[] = [];
    for (const f of files) {
      const node = getNode(this.sys, resolvePath(this.sys, f));
      if (!node || node.type !== "file") { out.push(`grep: ${f}: No existe el fichero o el directorio`); continue; }
      node.content.split("\n").forEach((ln, i) => {
        if ((ci ? ln.toLowerCase() : ln).includes(needle)) {
          out.push((files.length > 1 ? `${f}:` : "") + (nn ? `${i + 1}:` : "") + ln);
        }
      });
    }
    return { out };
  }

  private find(args: string[]): ShellResult {
    const start = args.find((a) => !a.startsWith("-")) ?? ".";
    const nameIdx = args.indexOf("-name");
    const namePat = nameIdx >= 0 ? args[nameIdx + 1] : null;
    const typeIdx = args.indexOf("-type");
    const typeFilter = typeIdx >= 0 ? args[typeIdx + 1] : null; // f | d
    const startNode = getNode(this.sys, resolvePath(this.sys, start));
    if (!startNode) return { out: [`find: '${start}': No existe el fichero o el directorio`] };
    const nameRe = namePat
      ? new RegExp("^" + namePat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
      : null;
    const out: string[] = [];
    const walk = (node: FsNode, disp: string) => {
      const okType = !typeFilter || (typeFilter === "d" ? node.type === "dir" : node.type === "file");
      if ((!nameRe || nameRe.test(node.name)) && okType) out.push(disp);
      if (node.type === "dir") {
        for (const child of Object.values(node.children)) walk(child, (disp === "/" ? "" : disp) + "/" + child.name);
      }
    };
    walk(startNode, start);
    return { out };
  }

  private headTail(args: string[], head: boolean): ShellResult {
    let n = 10;
    const nIdx = args.indexOf("-n");
    if (nIdx >= 0) n = parseInt(args[nIdx + 1] || "10", 10) || 10;
    const dashN = args.find((a) => /^-\d+$/.test(a));
    if (dashN) n = parseInt(dashN.slice(1), 10);
    const files = args.filter((a, i) => !a.startsWith("-") && !(nIdx >= 0 && i === nIdx + 1));
    const out: string[] = [];
    for (const f of files) {
      const node = getNode(this.sys, resolvePath(this.sys, f));
      if (!node || node.type !== "file") { out.push(`${head ? "head" : "tail"}: no se puede abrir '${f}' para lectura`); continue; }
      const lines = node.content.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
      out.push(...(head ? lines.slice(0, n) : lines.slice(-n)));
    }
    return { out };
  }

  private wc(args: string[]): ShellResult {
    const wl = args.includes("-l"), ww = args.includes("-w"), wc = args.includes("-c");
    const all = !wl && !ww && !wc;
    const out: string[] = [];
    for (const f of args.filter((a) => !a.startsWith("-"))) {
      const node = getNode(this.sys, resolvePath(this.sys, f));
      if (!node || node.type !== "file") { out.push(`wc: ${f}: No existe el fichero o el directorio`); continue; }
      const c = node.content;
      const lines = c.split("\n").length - (c.endsWith("\n") ? 1 : 0);
      const parts: string[] = [];
      if (wl || all) parts.push(String(lines));
      if (ww || all) parts.push(String(c.split(/\s+/).filter(Boolean).length));
      if (wc || all) parts.push(String(c.length));
      out.push(parts.join(" ") + " " + f);
    }
    return { out };
  }

  private stat(args: string[]): ShellResult {
    const f = args.filter((a) => !a.startsWith("-"))[0];
    if (!f) return { out: ["stat: falta el operando"] };
    const node = getNode(this.sys, resolvePath(this.sys, f));
    if (!node) return { out: [`stat: no se puede efectuar «stat» sobre '${f}': No existe el fichero o el directorio`] };
    return { out: [
      `  Fichero: ${f}`,
      `    Tipo: ${node.type === "dir" ? "directorio" : "fichero regular"}`,
      `  Acceso: (0${modeToOctalStr(node.mode)}/${node.type === "dir" ? "d" : "-"}${modeToRwx(node.mode)})  Uid: ( ${node.owner} )   Gid: ( ${node.group} )`,
    ] };
  }

  private fileCmd(args: string[]): ShellResult {
    const f = args.filter((a) => !a.startsWith("-"))[0];
    if (!f) return { out: ["file: falta el operando"] };
    const node = getNode(this.sys, resolvePath(this.sys, f));
    if (!node) return { out: [`${f}: cannot open (No existe el fichero o el directorio)`] };
    return { out: [`${f}: ${node.type === "dir" ? "directory" : "ASCII text"}`] };
  }

  private which(args: string[]): ShellResult {
    const out: string[] = [];
    for (const c of args.filter((a) => !a.startsWith("-"))) {
      if (COMMANDS.includes(c) || this.sys.packages.includes(c)) out.push(`/usr/bin/${c}`);
    }
    return { out };
  }

  private free(args: string[]): ShellResult {
    return { out: args.includes("-h")
      ? ["               total        usado       libre", "Mem:            3,8Gi       1,2Gi       2,6Gi", "Swap:           2,0Gi          0B       2,0Gi"]
      : ["               total        used        free", "Mem:         4014080     1258291     2755789", "Swap:        2097152           0     2097152"] };
  }

  private uname(args: string[]): ShellResult {
    if (args.includes("-a")) return { out: ["Linux server 6.1.0-13-amd64 #1 SMP Debian x86_64 GNU/Linux"] };
    if (args.includes("-r")) return { out: ["6.1.0-13-amd64"] };
    return { out: ["Linux"] };
  }

  private exportCmd(args: string[]): ShellResult {
    for (const a of args) {
      const eq = a.indexOf("=");
      if (eq > 0) this.sys.env[a.slice(0, eq)] = a.slice(eq + 1).replace(/^["']|["']$/g, "");
    }
    return { out: [] };
  }

  private groupsCmd(args: string[]): ShellResult {
    const user = args.filter((a) => !a.startsWith("-"))[0] || this.sys.user;
    if (!this.sys.users.includes(user)) return { out: [`groups: '${user}': no existe ese usuario`] };
    const memberOf = Object.entries(this.sys.groups).filter(([, m]) => m.includes(user)).map(([g]) => g);
    return { out: [memberOf.join(" ") || user] };
  }

  private getent(args: string[]): ShellResult {
    const db = args[0], key = args[1];
    if (db === "passwd") {
      const users = key ? (this.sys.users.includes(key) ? [key] : []) : this.sys.users;
      return { out: users.map((u, i) => `${u}:x:${1000 + i}:${1000 + i}::/home/${u}:/bin/bash`) };
    }
    if (db === "group") {
      const groups = key ? (this.sys.groups[key] ? [key] : []) : Object.keys(this.sys.groups);
      return { out: groups.map((g, i) => `${g}:x:${1000 + i}:${(this.sys.groups[g] || []).join(",")}`) };
    }
    return { out: [`getent: base de datos '${db ?? ""}' no soportada`] };
  }

  private dpkg(args: string[]): ShellResult {
    if (args[0] === "-l" || args[0] === "--list") {
      return { out: ["ii  Nombre            Versión", ...this.sys.packages.map((p) => `ii  ${p.padEnd(16)}  1.0`)] };
    }
    if (args[0] === "-s" || args[0] === "--status") {
      const p = args[1];
      if (!p || !this.sys.packages.includes(p)) return { out: [`dpkg-query: no se encontró el paquete '${p ?? ""}'`] };
      return { out: [`Package: ${p}`, "Status: install ok installed", "Version: 1.0"] };
    }
    return { out: [`dpkg: opción '${args[0] ?? ""}' no soportada en la simulación`] };
  }

  private serviceCmd(args: string[]): ShellResult {
    // `service <svc> <acción>` ≡ `systemctl <acción> <svc>`.
    const svc = args[0], action = args[1];
    if (!svc || !action) return { out: ["Uso: service <servicio> {start|stop|restart|status}"] };
    return this.systemctl([action, svc]);
  }

  private man(args: string[]): ShellResult {
    const c = args[0];
    if (!c) return { out: ["¿Qué página de manual desea?"] };
    return { out: [`(man simulado) Para '${c}', probá  ${c} --help. El manual completo no está en la consola simulada.`] };
  }
}
