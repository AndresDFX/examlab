/**
 * Escenario de la pregunta "Consola de servidor" (`so_consola`): estado inicial
 * del sistema virtual + aserciones de calificación. Vive en
 * `question.options.server`. Incluye (de)serialización de la respuesta del
 * alumno ({system, history}) y fábricas templadas para los talleres de
 * "Administración de Sistemas Operativos de Servidor". Análogo de
 * `network/scenario.ts`.
 */
import { type System, baseSystem, cloneSystem, getDir } from "./system";
import { type ServerAssertion } from "./grading";

export interface ServerScenario {
  system: System;
  assertions: ServerAssertion[];
}

export interface ServerAnswer {
  system: System;
  history: string[];
}

const USER = "alumno";

export function serializeServerAnswer(system: System, history: string[]): string {
  return JSON.stringify({ system, history });
}

export function parseServerAnswer(raw: unknown): ServerAnswer | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  const o = obj as { system?: System; history?: unknown };
  if (!o || typeof o !== "object" || !o.system || !(o.system as System).root) return null;
  return { system: o.system as System, history: Array.isArray(o.history) ? (o.history as string[]) : [] };
}

export function parseScenario(options: unknown): ServerScenario | null {
  const o = options as { server?: { system?: System; assertions?: ServerAssertion[] } } | null;
  const s = o?.server;
  if (!s || !s.system || !(s.system as System).root || !Array.isArray(s.assertions)) return null;
  return { system: s.system, assertions: s.assertions };
}

/** Sistema base con un servicio extra (para talleres de servicios). */
function systemWith(opts: { disabledService?: string } = {}): System {
  const sys = baseSystem(USER);
  if (opts.disabledService) sys.services[opts.disabledService] = { active: false, enabled: false };
  return sys;
}

// ── Fábricas por taller (Administración de Servidor) ─────────────────────────

export function scenarioS1(): ServerScenario {
  // Estado inicial: hay un archivo de ejemplo en el home para copiar/renombrar.
  const sys = baseSystem(USER);
  const home = getDir(sys, `/home/${USER}`);
  if (home) home.children["notas.txt"] = { type: "file", name: "notas.txt", owner: USER, group: USER, mode: 0o644, content: "hola\n" };
  return {
    system: sys,
    assertions: [
      { kind: "command_used", pattern: "pwd", points: 1, label: "usó pwd" },
      { kind: "command_used", pattern: "/ls\\s+-l/", points: 1, label: "listó con ls -l" },
      { kind: "dir_exists", path: "~/practica/dia1", points: 2, label: "creó ~/practica/dia1" },
      { kind: "command_used", pattern: "/cp\\s|mv\\s/", points: 1, label: "copió o renombró un archivo" },
    ],
  };
}

export function scenarioS2(): ServerScenario {
  return {
    system: baseSystem(USER),
    assertions: [
      { kind: "group_exists", group: "proyecto", points: 1, label: "creó el grupo proyecto" },
      { kind: "user_exists", user: "ana", points: 1, label: "creó el usuario ana" },
      { kind: "file_exists", path: "~/informe.txt", points: 1, label: "creó ~/informe.txt" },
      { kind: "file_mode", path: "~/informe.txt", mode: "640", points: 2, label: "informe.txt con permisos 640" },
    ],
  };
}

export function scenarioS3(): ServerScenario {
  return {
    system: systemWith({ disabledService: "apache2" }),
    assertions: [
      { kind: "package_installed", package: "tree", points: 1, label: "instaló tree" },
      { kind: "package_installed", package: "nano", points: 1, label: "instaló nano" },
      { kind: "service_active", service: "apache2", points: 1, label: "inició apache2 (start)" },
      { kind: "service_enabled", service: "apache2", points: 2, label: "habilitó apache2 (enable)" },
    ],
  };
}

export function scenarioS4(): ServerScenario {
  // Tarea de INSPECCIÓN (df/du) — sin cambios de estado; se evalúa por comandos.
  const sys = baseSystem(USER);
  const varlog = getDir(sys, "/var/log");
  if (varlog) varlog.children["big.log"] = { type: "file", name: "big.log", owner: "root", group: "root", mode: 0o644, content: "x".repeat(2000) };
  return {
    system: sys,
    assertions: [
      { kind: "command_used", pattern: "/df\\s+-h/", points: 2, label: "inspeccionó espacio con df -h" },
      { kind: "command_used", pattern: "/du\\s.*\\/var/", points: 2, label: "midió /var con du" },
      { kind: "command_used", pattern: "/ls|cat/", points: 1, label: "exploró el sistema" },
    ],
  };
}

export function scenarioS5(): ServerScenario {
  return {
    system: baseSystem(USER),
    assertions: [
      { kind: "command_used", pattern: "/ps|top/", points: 1, label: "listó procesos (ps/top)" },
      { kind: "command_used", pattern: "kill", points: 1, label: "terminó un proceso con kill" },
      // línea de cron diaria: minuto hora * * * (hora fija, día/mes/semana *)
      { kind: "cron_matches", pattern: "/^\\s*\\d+\\s+\\d+\\s+\\*\\s+\\*\\s+\\*/", points: 3, label: "agregó una línea de cron diaria" },
    ],
  };
}

export function scenarioS6(): ServerScenario {
  return {
    system: baseSystem(USER),
    assertions: [
      { kind: "command_used", pattern: "/ip\\s+a/", points: 1, label: "revisó interfaces con ip a" },
      { kind: "command_used", pattern: "journalctl", points: 1, label: "leyó logs con journalctl" },
      { kind: "command_used", pattern: "/tar\\s/", points: 1, label: "usó tar para el respaldo" },
      { kind: "file_exists", path: "~/etc-backup.tar.gz", points: 2, label: "generó el respaldo ~/etc-backup.tar.gz" },
    ],
  };
}

/** Escenario + enunciado por sesión (para insertar como pregunta so_consola). */
export interface ServerTaller {
  content: string;
  expected_rubric: string;
  scenario: ServerScenario;
  points: number;
}

export const SERVER_TALLERES: Record<number, ServerTaller> = {
  1: {
    content:
`Desde la **consola** del servidor (estás como \`${USER}\` en tu home):
1. Muestra tu directorio actual con \`pwd\`.
2. Explora la raíz y listado con \`ls -l\`.
3. Crea la carpeta \`~/practica/dia1\` (con \`mkdir -p\`).
4. Copia \`notas.txt\` a esa carpeta y renómbrala (usa \`cp\` y/o \`mv\`).`,
    expected_rubric: "pwd + ls -l usados; ~/practica/dia1 creado; un archivo copiado/renombrado.",
    scenario: scenarioS1(),
    points: 5,
  },
  2: {
    content:
`Desde la consola (usa \`sudo\` para lo privilegiado):
1. Crea el grupo \`proyecto\` (\`sudo groupadd proyecto\`).
2. Crea el usuario \`ana\` (\`sudo useradd -G proyecto ana\`).
3. Crea el archivo \`~/informe.txt\` (\`touch\`) y asígnale permisos **640** (\`chmod 640\`).
4. Verifica con \`ls -l\`.`,
    expected_rubric: "grupo proyecto + usuario ana creados; ~/informe.txt con permisos 640.",
    scenario: scenarioS2(),
    points: 5,
  },
  3: {
    content:
`Desde la consola (usa \`sudo\`):
1. \`sudo apt update\` e instala \`tree\` y \`nano\` (\`sudo apt install tree nano\`).
2. Inicia y habilita el servicio \`apache2\`: \`sudo systemctl start apache2\` y \`sudo systemctl enable apache2\`.
3. Verifica con \`systemctl status apache2\` (¿ves active + enabled?).`,
    expected_rubric: "tree y nano instalados; apache2 active + enabled.",
    scenario: scenarioS3(),
    points: 5,
  },
  4: {
    content:
`Inspecciona el almacenamiento desde la consola:
1. Espacio por sistema de archivos: \`df -h\` (¿cuánto usa \`/\`?).
2. Qué ocupa más en \`/var\`: \`du -sh /var/*\`.
3. Explora los archivos grandes con \`ls -l\` / \`cat\` donde aplique.`,
    expected_rubric: "df -h y du sobre /var usados; exploración del sistema.",
    scenario: scenarioS4(),
    points: 5,
  },
  5: {
    content:
`Procesos y tareas programadas desde la consola:
1. Lista los procesos que más consumen con \`ps aux\` o \`top\`.
2. Termina un proceso con \`kill <PID>\`.
3. Agrega una tarea de cron que corra **todos los días a las 2:00 AM**:
   \`echo "0 2 * * * /ruta/script.sh" | crontab -\` y verifica con \`crontab -l\`.`,
    expected_rubric: "ps/top + kill usados; línea de cron diaria (min hora * * *) agregada.",
    scenario: scenarioS5(),
    points: 5,
  },
  6: {
    content:
`Diagnóstico y respaldo desde la consola:
1. Revisa interfaces y red: \`ip a\`, \`ss -tlnp\`.
2. Lee los logs del sistema: \`journalctl -xe\`.
3. Respalda \`/etc\` comprimido en tu home: \`sudo tar -czvf ~/etc-backup.tar.gz /etc\`.`,
    expected_rubric: "ip a + journalctl usados; ~/etc-backup.tar.gz generado con tar.",
    scenario: scenarioS6(),
    points: 5,
  },
};

/** Estado inicial listo para el taker (clon del escenario para no mutar la fuente). */
export function initialSystemFor(scenario: ServerScenario): System {
  return cloneSystem(scenario.system);
}
