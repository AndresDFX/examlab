#!/usr/bin/env node
/**
 * Auditoría de las reglas de UI del proyecto: P1-P9, design system y las cuatro
 * reglas responsive de 375px.
 *
 * ── Por qué existe este script ─────────────────────────────────────────
 * CLAUDE.md documenta cada principio con su **check**, y ahí mismo explica por
 * qué eso no alcanzó: "el repo ya sabía detectar estos bugs —el fix del doble
 * padding y su justificación están escritos hace meses— y aun así nunca se
 * propagó al resto de las rutas". El motivo es que los checks son greps de una
 * línea que producen MUCHO ruido, y un reporte con ruido no se usa:
 *
 *   · el de P1 (`grep 'p-[0-9]' src/routes`) matchea cualquier `<div>` anidado
 *     dentro de un Card o un diálogo. Sobre este repo devuelve ~40 líneas y
 *     NINGUNA es una violación;
 *   · el de P7 suma las columnas de TODAS las tablas de un archivo, así que un
 *     grid de 8 columnas con otra tabla dentro de un diálogo reporta 9;
 *   · el de "toda fecha por los helpers" (`\.toLocaleString\(`) matchea sobre
 *     todo NÚMEROS —conteos, moneda, porcentajes— que la regla no gobierna.
 *
 * Este script implementa los mismos principios con las exclusiones que hacen
 * falta para que su salida sea accionable. Cada exclusión está comentada con el
 * caso real que la motivó, porque una exclusión sin justificación es la forma en
 * que un check se vuelve decorativo.
 *
 * Uso:  node scripts/audit-ui.mjs        → lista los hallazgos, exit 1 si hay
 *       node scripts/audit-ui.mjs --json → salida JSON (para el test)
 */
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();

/**
 * Rutas que SÍ deben poner su propio padding: viven fuera del shell (`/app/*`),
 * así que no hay `AppLayout` que se lo provea. Es la excepción que CLAUDE.md
 * declara explícitamente, más las vistas a pantalla completa.
 */
const FUERA_DEL_SHELL =
  /(^|\/)(index|privacy|asistencia|acuerdo\.|documento\.|encuesta\.|reto\.|verify\.|auth\.|__root|dev-preview)|kahoot\.\$gameId|\.take\.\$examId/;

/**
 * Matrices, no grids de listado: columna sticky y/o columnas dinámicas (una por
 * actividad, una por sesión). P7 no aplica — lo dice CLAUDE.md.
 */
const NO_ES_GRID_DE_LISTADO = /gradebook|attendance|monitor\./;

function archivos(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", ".git"].includes(e.name)) continue;
      out.push(...archivos(f, exts));
    } else if (exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith("routeTree.gen.ts")) {
      out.push(f.replace(/\\/g, "/"));
    }
  }
  return out;
}

/**
 * Se normalizan los fines de línea al LEER.
 *
 * No es cosmético: en este checkout de Windows los archivos están en CRLF, así
 * que al partir por `"\n"` cada línea queda con un `\r` al final y CUALQUIER
 * regex anclada con `$` deja de matchear. El check de P1 —que resuelve la raíz
 * de la ruta buscando `/^ {2}return \($/`— no funcionaba en NINGÚN archivo del
 * repo por esto: reportaba "limpio" siempre. Lo encontré al romper el código a
 * propósito y ver que el guardrail no avisaba.
 */
const leer = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const hallazgos = [];
const add = (regla, archivo, linea, detalle) =>
  hallazgos.push({
    regla,
    archivo: path.relative(RAIZ, archivo).replace(/\\/g, "/"),
    linea,
    detalle,
  });

const rutas = archivos(path.join(RAIZ, "src/routes"), [".tsx"]);
const todo = archivos(path.join(RAIZ, "src"), [".ts", ".tsx"]);
/** Un comentario que DOCUMENTA un antipatrón no es el antipatrón. */
const esComentario = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
/** Un elemento oculto bajo su breakpoint NUNCA se ve a 375px. */
const ocultoEnMobile = (cls) => /(^| )hidden( |$)/.test(cls) || /(^| )hidden\b/.test(cls);

// ── P1 · el padding de página lo provee el shell ───────────────────────
// Solo la raíz del componente QUE ES LA RUTA. Resolverlo por
// `createFileRoute(...)({ component: X })` es lo que evita reportar los
// sub-componentes del mismo archivo (`EmptyChart`, `EmptyChat`, `AgendaItem`),
// que fue el ruido que hacía inservible al grep documentado.
const PROHIBIDO_EN_RAIZ = /\b(p|px|py)-\d|(^| )container( |$)|mx-auto|max-w-screen/;
/** Cobertura de P1: se reporta al final. Un check que se saltea archivos en
 *  silencio también dice "limpio", y entonces no sirve para nada. */
const p1 = { candidatas: 0, revisadas: 0, saltadas: [] };
/**
 * Resuelve el especificador de un import a un archivo real.
 *
 * Cubre el alias `@/` y las rutas relativas: `app.teacher.courses.tsx` reusa el
 * componente con `from "./app.admin.courses"` (dos rutas comparten pantalla a
 * propósito, para que Admin y Docente no divergan), y sin el caso relativo esa
 * pantalla quedaba sin revisar.
 */
function resolverImport(spec, desde) {
  const base = spec.startsWith("@/")
    ? path.join(RAIZ, "src", spec.slice(2))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(desde), spec)
      : null;
  if (!base) return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
  }
  return null;
}
for (const ruta of rutas) {
  if (FUERA_DEL_SHELL.test(ruta)) continue;
  p1.candidatas++;
  let txt = leer(ruta);
  const mc = /component:\s*([A-Za-z0-9_]+)/.exec(txt);
  if (!mc) {
    // `app.tsx` es el layout y otras usan un componente inline: no hay una raíz
    // de PÁGINA que P1 gobierne.
    p1.saltadas.push([ruta, "sin `component:` nombrado"]);
    continue;
  }
  let mf = new RegExp(`^(?:export\\s+)?function\\s+${mc[1]}\\b`, "m").exec(txt);
  let archivoRaiz = ruta;
  if (!mf) {
    /**
     * El componente de la ruta puede vivir en `src/modules/` y la ruta solo
     * importarlo (`app.assistant.tsx` → `PlatformAssistantChat`,
     * `app.teacher.courses.tsx` → `AdminCourses`). Ahí la raíz de la pantalla
     * está en el módulo: sin seguir el import, esas pantallas quedaban sin
     * revisar y el check decía "limpio" sobre ellas.
     */
    const mi = new RegExp(`import\\s*\\{[^}]*\\b${mc[1]}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`).exec(
      txt,
    );
    const destino = mi ? resolverImport(mi[1], ruta) : null;
    if (destino) {
      const txtMod = leer(destino);
      const mfMod = new RegExp(`^(?:export\\s+)?function\\s+${mc[1]}\\b`, "m").exec(txtMod);
      if (mfMod) {
        txt = txtMod;
        mf = mfMod;
        archivoRaiz = destino;
      }
    }
  }
  if (!mf) {
    p1.saltadas.push([ruta, `no se encontró el cuerpo de ${mc[1]}`]);
    continue;
  }
  const p = archivoRaiz; // el archivo donde vive la raíz (la ruta o su módulo)
  const antes = txt.slice(0, mf.index).split("\n").length;
  /**
   * Se recorre TODO el cuerpo del componente hasta el próximo `function` de
   * nivel superior (para no entrar a los sub-componentes del mismo archivo).
   *
   * Antes había un tope de 400 líneas y eso volvía el check INÚTIL justo donde
   * importa: en `app.trash.tsx` el `return` raíz está en la línea 409 del
   * componente, así que el archivo se reportaba limpio con un `p-6` puesto a
   * mano en la raíz. Lo encontré rompiendo el código a propósito para ver si el
   * guardrail avisaba, y no avisó. Los archivos grandes son los de más riesgo:
   * un tope por rendimiento apagaba el check exactamente ahí.
   */
  const resto = txt.slice(mf.index);
  const finComp = resto.slice(1).search(/\n(?:export\s+)?function\s/);
  const lineas = (finComp < 0 ? resto : resto.slice(0, finComp + 1)).split("\n");
  /**
   * Cuál de los `return (` es la RAÍZ de la pantalla.
   *
   * La indentación del propio `return` no alcanza: en `app.videos.tsx` hay un
   * `return (` con dos espacios cuyo JSX arranca 24 espacios adentro (está
   * dentro de un callback anidado). Tomar "el último con dos espacios" elegía
   * ESE y el check no veía la raíz real.
   *
   * Lo que identifica la raíz es la indentación del HIJO: el JSX que devuelve el
   * componente arranca a 4 espacios. Entre los candidatos que cumplen eso se
   * toma el ÚLTIMO, porque los anteriores son los early return de carga y de
   * error y el layout de la pantalla cargada lo gobierna el final.
   */
  let idxReturn = -1;
  for (let i = 0; i < lineas.length; i++) {
    if (!/^ {2}return \($/.test(lineas[i])) continue;
    const hijo = lineas[i + 1] ?? "";
    if (/^ {4}\S/.test(hijo)) idxReturn = i;
  }
  if (idxReturn < 0) {
    // Una ruta que devuelve `<Navigate/>` o un componente directo no tiene una
    // raíz con className: no hay nada que P1 gobierne.
    p1.saltadas.push([ruta, "la raíz no es un <div> con className"]);
  } else {
    p1.revisadas++;
    for (let j = idxReturn + 1; j < Math.min(idxReturn + 5, lineas.length); j++) {
      const m = /<div className="([^"]*)"/.exec(lineas[j]);
      if (m) {
        if (PROHIBIDO_EN_RAIZ.test(m[1])) add("P1", p, antes + j, m[1].slice(0, 110));
        break;
      }
      if (/<(div|main|section)\b/.test(lineas[j])) break;
    }
  }
}

// ── P2 · tres tamaños bajo text-sm, todos con nombre ──────────────────
for (const p of todo) {
  leer(p)
    .split("\n")
    .forEach((l, i) => {
      if (!esComentario(l) && /text-\[\d+px\]/.test(l)) add("P2", p, i + 1, l.trim().slice(0, 110));
    });
}

// ── P3 · el acento es de la institución, no de la pantalla ────────────
const HUE_CRUDO = /text-(cyan|indigo|violet|pink|amber|sky|rose|emerald|teal|fuchsia|lime)-\d/;
for (const p of rutas) {
  const txt = leer(p);
  for (const m of txt.matchAll(/icon=\{<([^>]*?)\/?>\}/gs)) {
    if (HUE_CRUDO.test(m[1])) {
      add("P3", p, txt.slice(0, m.index).split("\n").length, m[1].trim().slice(0, 110));
    }
  }
}

// ── P7 · una columna existe si sirve para decidir sobre la fila ───────
// Se mide la PRIMERA tabla del archivo (el grid de listado). Sumar todas
// mezclaba el grid con las tablas de los diálogos y daba 9 donde había 8.
for (const p of rutas) {
  if (NO_ES_GRID_DE_LISTADO.test(p)) continue;
  const txt = leer(p);
  const iHeader = txt.indexOf("<TableHeader>");
  if (iHeader < 0) continue;
  const iFin = txt.indexOf("</TableHeader>", iHeader);
  const bloque = txt.slice(iHeader, iFin < 0 ? undefined : iFin);
  const heads = [...bloque.matchAll(/<(?:SortableHead|TableHead)\b([^>]*)>/g)].map((m) => m[1]);
  const visibles = heads.filter((h) => !/hidden/.test(h));
  if (!visibles.length) continue;
  const anchos = visibles.reduce((a, h) => {
    const m = /\bw-(\d+)\b/.exec(h);
    return a + (m ? Number(m[1]) * 4 : 0);
  }, 0);
  if (visibles.length > 8) add("P7", p, 0, `${visibles.length} columnas visibles en lg (tope 8)`);
  if (anchos > 900) add("P7", p, 0, `anchos declarados suman ${anchos}px (tope 900)`);
}

// ── Design system · primitivos que no se escriben a mano ──────────────
const DS = [
  [/(<Loader2\b[^>]*animate-spin)/, "DS-loader", "usar <Spinner>"],
  [/\bwindow\.confirm\(/, "DS-confirm", "usar useConfirm()"],
  [/(max-h|h)-\[\d+vh\]/, "DS-vh", "usar dvh: en iOS Safari `vh` usa el viewport máximo"],
  // Solo cuando el receptor ES una fecha. Un conteo con `toLocaleString("es-CO")`
  // no lo gobierna esta regla, y tratarlo como violación produjo 15 de 16 falsos
  // positivos en la primera versión.
  [
    /(new Date\([^)]*\)|[A-Za-z_]*(?:date|Date|fecha|Fecha|_at)\b)\s*\.toLocaleString\(|\.toLocaleDateString\(|\.toLocaleTimeString\(/,
    "DS-fecha",
    "usar los helpers de shared/lib/format (locale es-CO fijo)",
  ],
];
const EXENTO_DS = /shared\/lib\/format\.ts|\.test\./;
for (const p of todo) {
  if (EXENTO_DS.test(p)) continue;
  leer(p)
    .split("\n")
    .forEach((l, i) => {
      if (esComentario(l)) return;
      for (const [rx, regla, det] of DS) {
        if (rx.test(l)) add(regla, p, i + 1, `${det} → ${l.trim()}`.slice(0, 130));
      }
    });
}

// ── Responsive · las cuatro reglas de 375px ───────────────────────────
for (const p of todo) {
  const txt = leer(p);
  const lineas = txt.split("\n");

  // R1 · un modal con cap de ancho necesita el escape de mobile.
  for (const m of txt.matchAll(/<DialogContent[^>]*className="([^"]*)"/gs)) {
    const cls = m[1];
    const cap = /(^| )max-w-(xs|sm|md|lg|xl|\dxl|\[\d+px\])/.test(cls);
    const escape = cls.includes("calc(100vw") || cls.includes("sm:max-w");
    if (cap && !escape) {
      add("R1-modal", p, txt.slice(0, m.index).split("\n").length, cls.slice(0, 110));
    }
  }

  lineas.forEach((l, i) => {
    if (esComentario(l)) return;
    for (const m of l.matchAll(/className="([^"]*)"/g)) {
      const cls = m[1];
      // Nada de lo de abajo puede verse a 375px si el elemento está oculto ahí.
      if (ocultoEnMobile(cls)) continue;

      // R2 · un grid de CONTENIDO arranca en 1 columna.
      // Se excluyen: `TabsList` (2-3 pestañas a 375px se leen bien y apilarlas
      // es peor), `grid-cols-7` (es una semana de calendario, no puede ser 1) y
      // el teclado de respuestas de Kahoot (2×2 es el diseño: en 1 columna hay
      // que scrollear durante una pregunta con cronómetro).
      const esTabs = /TabsList/.test(l) || /TabsList/.test(lineas[i - 1] ?? "");
      const esSemana = /(^| )grid-cols-7( |$)/.test(cls);
      const esKahoot = /kahoot|reto\./.test(p);
      if (
        /(^| )grid-cols-([2-9]|1[0-2])( |$)/.test(cls) &&
        !/(sm|md|lg|xl):grid-cols-/.test(cls) &&
        !esTabs &&
        !esSemana &&
        !esKahoot
      ) {
        add("R2-grid", p, i + 1, cls.slice(0, 110));
      }
      // R3 · un piso de ancho grande en un flex necesita variante de mobile.
      if (/(^| )min-w-(4[89]|5\d|6\d|7\d)( |$)/.test(cls) && !cls.includes("sm:min-w")) {
        add("R3-minw", p, i + 1, cls.slice(0, 110));
      }
      // R4 · padding decorativo grande necesita variante de mobile.
      if (/(^| )p-(8|10|12)( |$)/.test(cls) && !/sm:p-/.test(cls)) {
        add("R4-padding", p, i + 1, cls.slice(0, 110));
      }
      // R5 · zona táctil de un botón icon-only ≥ 32px (h-8 w-8).
      // Se exige que el className esté EN la etiqueta del botón: un
      // `<Icon className="h-5 w-5"/>` DENTRO de un botón es el tamaño del
      // ícono, no la zona táctil — fueron 6 de 6 falsos positivos.
      const enEtiquetaDeBoton = /<(button|Button|RowAction)\b[^>]*$/.test(l.slice(0, m.index));
      if (enEtiquetaDeBoton && /(^| )h-(5|6|7)( |$)/.test(cls) && /(^| )w-(5|6|7)( |$)/.test(cls)) {
        add("R5-touch", p, i + 1, cls.slice(0, 110));
      }
    }
  });
}

/**
 * Excepciones REVISADAS UNA POR UNA, con su motivo.
 *
 * Existe esta lista y no un `continue` escondido en el check porque un auditor
 * que siempre reporta tres cosas conocidas es un auditor que nadie corre — y
 * entonces tampoco avisa de la cuarta, que sí importa. Cada entrada dice por qué
 * se aceptó; sin el motivo, mañana nadie sabe si sigue siendo válida.
 *
 * Al agregar una entrada acá: el criterio NO es "molesta", es "el principio no
 * aplica a este caso, y acá está la razón".
 */
const ACEPTADOS = [
  {
    regla: "DS-fecha",
    archivo: "src/components/ui/calendar.tsx",
    contiene: "data-day",
    porque:
      "Es un atributo de DATOS, invisible, y nadie más en el repo lo lee (cero menciones fuera " +
      "de este archivo). Lo que la regla protege —que la app no se vea distinta según el sistema " +
      "operativo— ya está cubierto: el locale quedó fijado en es-CO. Cambiarle además el FORMATO " +
      "podría romper un selector de CSS o de test sin ningún beneficio.",
  },
  {
    regla: "R2-grid",
    archivo: "src/modules/tenants/TenantBrandPreview.tsx",
    contiene: "grid-cols-3",
    porque:
      "Es una MAQUETA en miniatura del panel (de ahí el text-3xs/text-2xs), no un grid de " +
      "contenido. En una columna dejaría de parecerse a lo que previsualiza, que es su único fin.",
  },
  {
    regla: "R2-grid",
    archivo: "src/modules/whiteboard/WhiteboardEditor.tsx",
    contiene: "grid-cols-2",
    porque:
      "Son miniaturas de figuras en el selector de la biblioteca: dos cuadrados chicos lado a " +
      "lado ES el diseño de un picker. No hay texto que se vuelva ilegible.",
  },
];

const esAceptado = (h) =>
  ACEPTADOS.some(
    (a) => a.regla === h.regla && h.archivo === a.archivo && h.detalle.includes(a.contiene),
  );
const restantes = hallazgos.filter((h) => !esAceptado(h));

/**
 * Cobertura de P1, reportada SIEMPRE.
 *
 * Es la regla de "sin topes silenciosos" de CLAUDE.md aplicada al propio
 * auditor: un check que se saltea la mitad de las pantallas devuelve cero
 * hallazgos igual que uno que las revisó todas, y desde afuera se leen idéntico.
 * Este script ya tuvo ese defecto dos veces (un tope de 400 líneas y el `\r` de
 * CRLF), y las dos veces decía "limpio".
 */
const cobertura = {
  candidatas: p1.candidatas,
  revisadas: p1.revisadas,
  pct: p1.candidatas ? Math.round((100 * p1.revisadas) / p1.candidatas) : 0,
  saltadas: p1.saltadas.map(([a, por]) => `${path.relative(RAIZ, a).replace(/\\/g, "/")}: ${por}`),
};

if (process.argv.includes("--cobertura")) {
  console.log(JSON.stringify(cobertura, null, 1));
  process.exit(0);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(restantes, null, 1));
} else {
  const porRegla = restantes.reduce((a, h) => ((a[h.regla] = (a[h.regla] ?? 0) + 1), a), {});
  for (const h of restantes) {
    console.log(`${h.regla.padEnd(11)} ${h.archivo}:${h.linea}\n            ${h.detalle}`);
  }
  const resumenP1 =
    `P1 revisó la raíz de ${cobertura.revisadas}/${cobertura.candidatas} pantallas ` +
    `(${cobertura.pct}%); el resto no tiene una raíz que la regla gobierne ` +
    `(--cobertura para el detalle).`;
  console.log(
    restantes.length === 0
      ? `Sin hallazgos: la UI cumple las reglas de CLAUDE.md.\n` +
          `(${ACEPTADOS.length} excepciones revisadas — ver ACEPTADOS en este archivo.)\n` +
          resumenP1
      : `\n${Object.entries(porRegla)
          .map(([k, v]) => `${k}=${v}`)
          .join("  ")}  ·  TOTAL ${restantes.length}\n${resumenP1}`,
  );
}
process.exit(restantes.length === 0 ? 0 : 1);
