// Pasa la nota de un corte de ExamLab al portal de la UNIAJC (Campus TI → Academusoft →
// «Ingresar Calificaciones»). Por defecto corre EN SECO: entra a cada grupo, cruza por
// documento y muestra qué escribiría, sin tocar nada. Con --registrar escribe, pulsa
// «Registrar» y después vuelve a abrir el grupo en una sesión nueva para comprobar lo
// que quedó guardado.
//
//   node .claude/skills/notas-a-uniajc/pasar-notas.cjs <carpeta-csv> [--registrar]
//        [--solo=LB141F] [--corte=1] [--evaluacion="EVALUACIÓN FORMATIVA I"]
//
// Credenciales en .env.uniajc (raíz del repo, ignorado por git): UNIAJC_USUARIO y
// UNIAJC_CLAVE. Los CSV los arma leer-libro.cjs (uno por curso):
//   Estudiante;Documento;Correo;Corte N;Aporte
// Una nota 0 se registra como NP (No Presentó): el portal pone 0.0 y bloquea la caja.
const path = require("path");
const fs = require("fs");
const RAIZ = path.resolve(__dirname, "../../..");
const { chromium } = require(path.join(RAIZ, "node_modules/playwright"));

const args = process.argv.slice(2);
const opcion = (k, def) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${def}`).slice(k.length + 3);
const CARPETA = args.find((a) => !a.startsWith("--"));
const REGISTRAR = args.includes("--registrar");
const SOLO = opcion("solo", "");
const CORTE = opcion("corte", "1");
const EVALUACION = opcion("evaluacion", ["", "EVALUACIÓN FORMATIVA I", "EVALUACIÓN FORMATIVA II", "EVALUACIÓN FORMATIVA III"][Number(CORTE)] || "");
if (!CARPETA) {
  console.error("Uso: pasar-notas.cjs <carpeta-csv> [--registrar] [--solo=GRUPO] [--corte=N]");
  process.exit(1);
}

const env = fs.readFileSync(path.join(RAIZ, ".env.uniajc"), "utf8");
const leerEnv = (k) => (new RegExp(`${k}="([^"]+)"`).exec(env) || [])[1];
const USU = leerEnv("UNIAJC_USUARIO");
const CLA = leerEnv("UNIAJC_CLAVE");

// Archivo CSV → (materia y grupo en el portal). El grupo del portal es el código sin el
// sufijo que ExamLab le agrega al nombre («641A-2» en ExamLab es «641A…» en el portal).
const CURSOS = [
  { archivo: "Arquitectura 6303C", materia: "ARQUITECTURA DE SISTEMAS COMPUTACIONALES", grupo: "6303C" },
  { archivo: "Bases de Datos II 641A-2", materia: "BASES DE DATOS II", grupo: "641A" },
  { archivo: "Introduccion LB141F", materia: "INTRODUCCION A LA INGENIERIA", grupo: "LB141F" },
  { archivo: "Introduccion SB141B", materia: "INTRODUCCION A LA INGENIERIA", grupo: "SB141B" },
  { archivo: "Introduccion SB141C", materia: "INTRODUCCION A LA INGENIERIA", grupo: "SB141C" },
  { archivo: "Programacion II 341C", materia: "PROGRAMACION II", grupo: "341C" },
  { archivo: "Seminario de Sistemas 341C", materia: "SEMINARIO DE SISTEMAS", grupo: "341C" },
];

const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
const paso = (m) => console.log(new Date().toISOString().slice(11, 19), m);
// El portal acepta UNA cifra decimal con punto («4.5»: la caja tiene maxlength 3).
// Redondeo con la mitad hacia arriba, el mismo criterio que el libro de notas.
const aPortal = (nota) => (Math.round(nota * 10 + 1e-9) / 10).toFixed(1);
const NP = "NO PRESENTO"; // valor del selector de estado; su texto visible es «NP»

function leerCsv(nombre) {
  const t = fs.readFileSync(path.join(CARPETA, `Corte${CORTE} - ${nombre}.csv`), "utf8").replace(/^﻿/, "");
  return t
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [estudiante, documento, correo, nota] = l.split(";");
      return { estudiante, documento: String(documento).trim(), correo, nota: Number(String(nota).replace(",", ".")) };
    });
}

async function entrar() {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 1500, height: 950 }, locale: "es-CO" });
  // El portal confirma y avisa con alert/confirm: se aceptan y se guardan para el informe.
  const dialogos = [];
  const atender = async (d) => {
    dialogos.push(d.message());
    await d.accept();
  };
  c.on("page", (pg) => pg.on("dialog", atender));
  const p = await c.newPage();
  p.on("dialog", atender);
  await p.goto("https://aplicaciones.uniajc.edu.co/uniajc/hermesoft/vortal/iniciarSesion.jsp", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await p.waitForTimeout(2500);
  const login = p.frame({ name: "mainFrame" });
  await login.fill("#loginUsuario", USU);
  await login.fill("#password", CLA);
  await login.click("#btn-login");
  let inicio = null;
  for (let i = 0; i < 40 && !inicio; i++) {
    inicio = p.frames().find((f) => /miVortal\/index\.jsp/.test(f.url()));
    if (!inicio) await p.waitForTimeout(500);
  }
  if (!inicio) throw new Error("No se pudo iniciar sesión en Campus TI");
  await p.waitForTimeout(1500);
  // «Académico Docente» es una imagen sin texto: se abre por su manejador.
  await inicio.click(`[onclick*="abrirPopAplicacion('3'"]`);
  let pg = null;
  for (let i = 0; i < 60 && !pg; i++) {
    pg = c.pages().find((x) => /academicoDocente/.test(x.url()));
    if (!pg) await p.waitForTimeout(500);
  }
  if (!pg) throw new Error("No se abrió Académico Docente");
  await pg.setViewportSize({ width: 1500, height: 950 });
  pg.setDefaultTimeout(25000);
  for (let i = 0; i < 40 && !pg.frames().some((f) => /tree\.jsp/.test(f.url())); i++) await pg.waitForTimeout(500);
  await pg.waitForTimeout(2500);
  return { b, pg, dialogos };
}

const marco = (pg) => pg.frames().find((f) => /IfrFormTab01$/.test(f.name()));

async function abrirGrupo(pg, curso) {
  const arbol = pg.frames().find((f) => /tree\.jsp/.test(f.url()));
  await arbol.click("#join_24625");
  await pg.waitForTimeout(2500);
  await arbol.click("#dFunctionalities_24625 >> text=Ingresar Calificaciones");
  await pg.waitForTimeout(5000);
  const itMateria = await marco(pg).evaluate((m) => {
    const n = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
    const r = [...document.querySelectorAll('input[name="it"]')].find((x) => n(x.closest("tr").innerText).includes(m));
    return r ? r.value : null;
  }, curso.materia);
  if (itMateria == null) throw new Error(`No encontré la materia ${curso.materia}`);
  await marco(pg).click(`input[name="it"][value="${itMateria}"]`, { noWaitAfter: true });
  await pg.waitForTimeout(4000);
  const grupos = await marco(pg).evaluate(() =>
    [...document.querySelectorAll('input[name="itGrupo"]')].map((x) => ({ v: x.value, t: x.closest("tr").innerText.trim().split(/\s+/)[0] })),
  );
  const g = grupos.find((x) => x.t.toUpperCase().startsWith(curso.grupo));
  if (!g) throw new Error(`No encontré el grupo ${curso.grupo} en ${curso.materia}: ${grupos.map((x) => x.t).join(", ")}`);
  await marco(pg).click(`input[name="itGrupo"][value="${g.v}"]`, { noWaitAfter: true });
  await pg.waitForTimeout(1500);
  await marco(pg).click("#btCon", { noWaitAfter: true });
  for (let i = 0; i < 30 && /cal_doc_gru\.jsp$/.test(marco(pg)?.url() || ""); i++) await pg.waitForTimeout(1000);
  await pg.waitForTimeout(2500);
  return g.t;
}

// Evaluación y nota del corte: sin las dos elegidas el portal no muestra la lista.
async function elegirEvaluacion(pg) {
  const f = marco(pg);
  const evals = await f.evaluate(() => [...document.querySelectorAll("#evaluacion option")].map((o) => ({ v: o.value, t: o.text.trim() })));
  const ev = evals.find((o) => norm(o.t) === norm(EVALUACION));
  if (!ev) throw new Error(`No existe la evaluación «${EVALUACION}»: ${evals.map((o) => o.t).join(" | ")}`);
  await f.selectOption("#evaluacion", ev.v);
  await pg.waitForTimeout(3500);
  const notas = await f.evaluate(() => [...document.querySelectorAll("#nota option")].map((o) => ({ v: o.value, t: o.text.trim() })));
  const nt = notas.find((o) => o.v !== "" && norm(o.t) === norm(EVALUACION)) || notas.find((o) => o.v !== "");
  if (!nt) throw new Error("La evaluación no tiene notas para elegir");
  await f.selectOption("#nota", nt.v);
  await pg.waitForTimeout(5000);
}

async function leerFilas(pg) {
  return marco(pg).evaluate(() =>
    [...document.querySelectorAll('#listaEstudiantesGrupoCalificacion input[name^="valorNota_"]')].map((inp) => {
      const td = inp.closest("tr").querySelectorAll("td");
      const i = inp.name.slice("valorNota_".length);
      const est = document.querySelector(`select[name="estado_${i}"]`);
      const ident = td[0].innerText.trim();
      return {
        i,
        ident,
        numero: (ident.match(/(\d{5,})/) || [])[1] || "",
        nombre: td[1].innerText.trim(),
        valor: inp.value.trim(),
        bloqueada: inp.disabled,
        estado: est ? est.value : "",
      };
    }),
  );
}

// Lo que debe quedar en el portal para una fila: «NP» o la nota con un decimal.
function esperado(notas, fila) {
  const n = notas.porDoc.get(fila.numero) || notas.porNombre.get(norm(fila.nombre));
  return { n, valor: !n || n.nota <= 0 ? "NP" : aPortal(n.nota) };
}
const yaEsta = (fila, valor) => (valor === "NP" ? fila.estado === NP : !fila.estado && Number(fila.valor) === Number(valor) && fila.valor !== "");

(async () => {
  const resumen = [];
  for (const curso of CURSOS) {
    if (SOLO && !curso.archivo.includes(SOLO)) continue;
    const lista = leerCsv(curso.archivo);
    const notas = {
      porDoc: new Map(lista.map((n) => [n.documento, n])),
      porNombre: new Map(lista.map((n) => [norm(n.estudiante), n])),
    };
    const r = { curso: curso.archivo };
    resumen.push(r);
    const s = await entrar();
    try {
      await abrirGrupo(s.pg, curso);
      await elegirEvaluacion(s.pg);
      const filas = await leerFilas(s.pg);
      const usados = new Set();
      const plan = filas.map((f) => {
        const { n, valor } = esperado(notas, f);
        if (n) usados.add(n.correo);
        return { ...f, n, poner: valor, cruce: !n ? "sin nota en ExamLab" : notas.porDoc.get(f.numero) ? "documento" : "nombre" };
      });
      const sobran = lista.filter((n) => !usados.has(n.correo));
      const cambios = plan.filter((x) => !yaEsta(x, x.poner));
      paso(`${curso.archivo} (grupo ${curso.grupo}): ${filas.length} en el portal, ${lista.length} en ExamLab, ${cambios.length} por escribir`);
      for (const x of plan) {
        const actual = x.estado ? `${x.estado === NP ? "NP" : x.estado}` : x.valor || "·";
        console.log(`   ${x.ident.padEnd(18)} ${x.nombre.slice(0, 40).padEnd(40)} ${actual.padStart(4)} → ${x.poner.padEnd(3)} ${yaEsta(x, x.poner) ? "(igual)" : ""} [${x.cruce}${x.n ? `, ExamLab ${x.n.nota.toFixed(2)}` : ""}]`);
      }
      for (const n of sobran) console.log(`   ⚠ En ExamLab y NO en el portal: ${n.estudiante} (${n.documento}), nota ${n.nota.toFixed(2)}`);
      Object.assign(r, { portal: filas.length, examlab: lista.length, np: plan.filter((x) => x.poner === "NP").length, sinExamlab: plan.filter((x) => !x.n).length, sobranExamlab: sobran.length, porEscribir: cambios.length });

      if (REGISTRAR && cambios.length) {
        // Un grupo ya registrado trae las cajas bloqueadas: «Modificar» las habilita.
        if (plan.some((x) => x.bloqueada && x.estado !== NP)) {
          await marco(s.pg).click("#btMod", { noWaitAfter: true });
          await s.pg.waitForTimeout(1500);
        }
        for (const x of plan) {
          const f = marco(s.pg);
          if (x.poner === "NP") {
            // El portal pone 0.0 y bloquea la caja al elegir NP (bloquearNota).
            await f.selectOption(`select[name="estado_${x.i}"]`, NP);
          } else {
            if (x.estado) await f.selectOption(`select[name="estado_${x.i}"]`, "");
            await f.fill(`input[name="valorNota_${x.i}"]`, x.poner);
          }
        }
        const antes = s.dialogos.length;
        await marco(s.pg).click("#btReg", { noWaitAfter: true });
        let ok = false;
        for (let i = 0; i < 45 && !ok; i++) {
          await s.pg.waitForTimeout(1000);
          const txt = await marco(s.pg)
            .evaluate(() => document.body.innerText)
            .catch(() => "");
          ok = /realiz[oó] satisfactoriamente/i.test(txt);
        }
        const avisos = s.dialogos.slice(antes).filter((m) => !/seguro que desea registrar/i.test(m));
        if (!ok) throw new Error(`«Registrar» no confirmó. Avisos del portal: ${avisos.join(" / ") || "(ninguno)"}`);
        paso("   el portal confirmó el registro");
        r.registrado = true;
        await marco(s.pg)
          .click("text=Continuar", { noWaitAfter: true })
          .catch(() => {});
      }
    } catch (e) {
      r.error = e.message;
      console.log(`   ✗ ${e.message}`);
    } finally {
      await s.b.close();
    }

    // Verificación: se vuelve a abrir el grupo en una sesión nueva y se compara contra
    // lo esperado. Es lo único que prueba que el registro quedó; la confirmación del
    // portal solo dice que el envío no falló.
    if (REGISTRAR && !r.error) {
      const v = await entrar();
      try {
          await abrirGrupo(v.pg, curso);
        await elegirEvaluacion(v.pg);
        const filas = await leerFilas(v.pg);
        const mal = filas.filter((f) => !yaEsta(f, esperado(notas, f).valor));
        r.verificadas = `${filas.length - mal.length}/${filas.length}`;
        paso(`   verificación: ${r.verificadas} filas con el valor esperado`);
        for (const f of mal) console.log(`   ✗ ${f.ident} ${f.nombre}: quedó «${f.valor}» estado «${f.estado}», se esperaba ${esperado(notas, f).valor}`);
      } catch (e) {
        r.errorVerificacion = e.message;
        console.log(`   ✗ verificación: ${e.message}`);
      } finally {
        await v.b.close();
      }
    }
  }
  console.log("\nRESUMEN");
  for (const r of resumen) console.log(JSON.stringify(r));
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
