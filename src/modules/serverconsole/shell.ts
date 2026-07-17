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
}
