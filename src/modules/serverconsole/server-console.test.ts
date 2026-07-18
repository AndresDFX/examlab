import { describe, expect, it } from "vitest";
import { baseSystem, applyChmod, modeToOctalStr, resolvePath, getNode } from "./system";
import { ShellInterpreter } from "./shell";
import { gradeServer } from "./grading";
import { scenarioS1, scenarioS2, scenarioS3, scenarioS4, scenarioS5, scenarioS6, initialSystemFor, serializeServerAnswer, parseServerAnswer } from "./scenario";

const solve = (scenario: ReturnType<typeof scenarioS1>, cmds: string[]) => {
  const sys = initialSystemFor(scenario);
  const sh = new ShellInterpreter(sys);
  for (const c of cmds) sh.execute(c);
  return gradeServer({ system: sys, history: sh.history }, scenario.assertions);
};

describe("system helpers", () => {
  it("applyChmod octal + simbólico", () => {
    expect(applyChmod(0o644, "640")).toBe(0o640);
    expect(modeToOctalStr(applyChmod(0o644, "640")!)).toBe("640");
    expect(applyChmod(0o644, "u+x")).toBe(0o744);
    expect(applyChmod(0o777, "o-rwx")).toBe(0o770);
    expect(applyChmod(0o644, "g=r,o=")).toBe(0o640);
    expect(applyChmod(0o644, "zzz")).toBeNull();
  });
  it("resolvePath expande ~, relativo y ..", () => {
    const sys = baseSystem("alumno");
    expect(resolvePath(sys, "~/x")).toBe("/home/alumno/x");
    expect(resolvePath(sys, "x")).toBe("/home/alumno/x");
    expect(resolvePath(sys, "../x")).toBe("/home/x");
    expect(resolvePath(sys, "/etc/../var/log")).toBe("/var/log");
  });
});

describe("shell interpreter — comandos con estado", () => {
  it("mkdir -p crea la cadena de directorios", () => {
    const sys = baseSystem("alumno");
    const sh = new ShellInterpreter(sys);
    sh.execute("mkdir -p ~/a/b/c");
    expect(getNode(sys, "/home/alumno/a/b/c")?.type).toBe("dir");
  });
  it("touch + chmod fija permisos octales", () => {
    const sys = baseSystem("alumno");
    const sh = new ShellInterpreter(sys);
    sh.execute("touch ~/f.txt");
    sh.execute("chmod 600 ~/f.txt");
    expect(modeToOctalStr(getNode(sys, "/home/alumno/f.txt")!.mode)).toBe("600");
  });
  it("comandos privilegiados exigen sudo", () => {
    const sys = baseSystem("alumno");
    const sh = new ShellInterpreter(sys);
    const out = sh.execute("useradd ana");
    expect(out.join(" ")).toMatch(/sudo/i);
    expect(sys.users).not.toContain("ana");
    sh.execute("sudo useradd ana");
    expect(sys.users).toContain("ana");
  });
  it("echo > archivo y >> appendea", () => {
    const sys = baseSystem("alumno");
    const sh = new ShellInterpreter(sys);
    sh.execute('echo "hola" > ~/n.txt');
    sh.execute('echo "mundo" >> ~/n.txt');
    const f = getNode(sys, "/home/alumno/n.txt");
    expect(f?.type === "file" && f.content).toContain("hola");
    expect(f?.type === "file" && f.content).toContain("mundo");
  });
});

describe("gradeServer — resolver cada taller da ratio 1", () => {
  it("S1 recorrido", () => {
    const r = solve(scenarioS1(), ["pwd", "ls -l", "mkdir -p ~/practica/dia1", "cp notas.txt ~/practica/dia1/copia.txt"]);
    expect(r.ratio).toBe(1);
  });
  it("S2 permisos 640", () => {
    const r = solve(scenarioS2(), ["sudo groupadd proyecto", "sudo useradd -G proyecto ana", "touch ~/informe.txt", "chmod 640 ~/informe.txt"]);
    expect(r.ratio).toBe(1);
  });
  it("S3 servicios", () => {
    const r = solve(scenarioS3(), ["sudo apt update", "sudo apt install tree nano", "sudo systemctl start apache2", "sudo systemctl enable apache2"]);
    expect(r.ratio).toBe(1);
  });
  it("S4 almacenamiento", () => {
    const r = solve(scenarioS4(), ["df -h", "du -sh /var/*", "ls -l /var/log"]);
    expect(r.ratio).toBe(1);
  });
  it("S5 procesos + cron", () => {
    const r = solve(scenarioS5(), ["ps aux", "kill 980", 'echo "0 2 * * * /ruta/script.sh" | crontab -']);
    expect(r.ratio).toBe(1);
  });
  it("S6 detective + respaldo", () => {
    const r = solve(scenarioS6(), ["ip a", "journalctl -xe", "sudo tar -czvf ~/etc-backup.tar.gz /etc"]);
    expect(r.ratio).toBe(1);
  });
});

describe("gradeServer — soluciones parciales/erróneas bajan el ratio", () => {
  it("S2 sin chmod → no full", () => {
    const r = solve(scenarioS2(), ["sudo groupadd proyecto", "sudo useradd -G proyecto ana", "touch ~/informe.txt"]);
    expect(r.ratio).toBeLessThan(1);
    expect(r.items.find((i) => i.label.includes("640"))?.passed).toBe(false);
  });
  it("S3 sin enable → parcial", () => {
    const r = solve(scenarioS3(), ["sudo apt install tree nano", "sudo systemctl start apache2"]);
    expect(r.ratio).toBeLessThan(1);
    expect(r.items.find((i) => i.label.includes("enable"))?.passed).toBe(false);
  });
  it("permiso denegado sin sudo → estado no cambia", () => {
    const r = solve(scenarioS2(), ["groupadd proyecto", "useradd -G proyecto ana", "touch ~/informe.txt", "chmod 640 ~/informe.txt"]);
    // grupo/usuario NO se crean sin sudo; solo pasa file + mode.
    expect(r.items.find((i) => i.label.includes("grupo"))?.passed).toBe(false);
    expect(r.items.find((i) => i.label.includes("usuario"))?.passed).toBe(false);
  });
});

describe("(de)serialización de la respuesta", () => {
  it("round-trip system + history", () => {
    const sys = baseSystem("alumno");
    const sh = new ShellInterpreter(sys);
    sh.execute("mkdir -p ~/x");
    const raw = serializeServerAnswer(sys, sh.history);
    const parsed = parseServerAnswer(raw);
    expect(parsed).not.toBeNull();
    expect(getNode(parsed!.system, "/home/alumno/x")?.type).toBe("dir");
    expect(parsed!.history).toContain("mkdir -p ~/x");
  });
  it("respuesta basura → null", () => {
    expect(parseServerAnswer("no-json")).toBeNull();
    expect(parseServerAnswer({ nope: 1 })).toBeNull();
  });
});

describe("nano (editor) + autocompletado (Tab)", () => {
  it("nano abre editorRequest y saveEditor escribe el archivo (queda en historial)", () => {
    const sys = baseSystem("alumno");
    const sh = new ShellInterpreter(sys);
    const out = sh.execute("nano notas.txt");
    expect(out).toEqual([]);
    expect(sh.editorRequest).not.toBeNull();
    expect(sh.editorRequest?.content).toBe("");
    sh.saveEditor("hola mundo\n");
    expect(sh.editorRequest).toBeNull();
    const n = getNode(sys, "/home/alumno/notas.txt");
    expect(n?.type).toBe("file");
    expect((n as { content: string }).content).toBe("hola mundo\n");
    expect(sh.history).toContain("nano notas.txt");
  });
  it("nano sobre archivo existente carga su contenido; cancelEditor no lo cambia", () => {
    const sys = baseSystem("alumno");
    const sh = new ShellInterpreter(sys);
    sh.execute("echo hola > f.txt");
    sh.execute("nano f.txt");
    expect(sh.editorRequest?.content).toBe("hola\n");
    sh.cancelEditor();
    expect((getNode(sys, "/home/alumno/f.txt") as { content: string }).content).toBe("hola\n");
  });
  it("nano sobre un directorio da error y no abre editor", () => {
    const sys = baseSystem("alumno");
    const sh = new ShellInterpreter(sys);
    const out = sh.execute("nano /etc");
    expect(out[0]).toContain("Es un directorio");
    expect(sh.editorRequest).toBeNull();
  });
  it("complete: comando único vs prefijo común", () => {
    const sh = new ShellInterpreter(baseSystem("alumno"));
    expect(sh.complete("who").line).toBe("whoami ");
    const r = sh.complete("ch");
    expect(r.candidates).toEqual(expect.arrayContaining(["chmod", "chown", "chgrp"]));
    expect(r.line).toBe("ch");
    expect(sh.complete("sudo userm").line).toBe("sudo usermod ");
  });
  it("complete: ruta de archivo (único) y directorio (con /)", () => {
    const sh = new ShellInterpreter(baseSystem("alumno"));
    expect(sh.complete("cat /etc/host").line).toBe("cat /etc/hostname ");
    expect(sh.complete("cd /ho").line).toBe("cd /home/");
  });
});
