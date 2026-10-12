// Sincroniza la nota de un corte de ExamLab con el portal de la UNIAJC (Campus TI →
// Académico Docente → Academusoft «Ingresar Calificaciones»).
//
// Sirve igual para el PRIMER registro de un corte y para volver a correrlo cuando algo
// cambió en ExamLab: compara lo que tiene el portal con el CSV del corte y escribe solo
// las filas que difieren. Por omisión corre EN SECO (no toca nada); con --registrar
// escribe, pulsa «Registrar» y después vuelve a abrir el grupo en una sesión nueva para
// comprobar lo que quedó guardado.
//
//   node .claude/skills/notas-a-uniajc/pasar-notas.cjs --corte=1 [--registrar]
//        [--solo=LB141F] [--carpeta=<dir>] [--detalle] [--evaluacion="EVALUACIÓN FORMATIVA I"]
//
// Lee los CSV de leer-libro.cjs (por omisión en privado/notas-<periodo>/corte<N>/) y la
// configuración de cursos.json. Credenciales del portal en .env.uniajc.
const path = require("path");
const fs = require("fs");
const { RAIZ, CONFIG, leerEnv, argumentos, carpetaDelCorte, archivoCsv, leerCsv, cursosElegidos, aPortal, norm, paso } = require("./comun.cjs");
const { chromium } = require(path.join(RAIZ, "node_modules/playwright"));

const { opciones } = argumentos();
const CORTE = String(opciones.corte || "1");
const REGISTRAR = opciones.registrar === true;
const DETALLE = opciones.detalle === true;
const CARPETA = carpetaDelCorte(CORTE, opciones.carpeta);
const EVALUACION = opciones.evaluacion || CONFIG.evaluaciones[CORTE];
if (!EVALUACION) {
  console.error(`cursos.json no dice qué evaluación del portal corresponde al Corte ${CORTE}`);
  process.exit(1);
}
if (!opciones.evaluacion && !(CONFIG.evaluacionesConfirmadas || []).includes(CORTE)) {
  console.log(`⚠ «${EVALUACION}» (Corte ${CORTE}) todavía no se vio en el portal: si no existe, el script se detiene y muestra las que hay.`);
}
const USU = leerEnv(".env.uniajc", "UNIAJC_USUARIO");
const CLA = leerEnv(".env.uniajc", "UNIAJC_CLAVE");
const NP = "NO PRESENTO"; // valor del selector de estado; su texto visible es «NP»

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
  await p.goto("https://aplicaciones.uniajc.edu.co/uniajc/hermesoft/vortal/iniciarSesion.jsp", { waitUntil: "domcontentloaded", timeout: 60000 });
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
}

// Evaluación y nota del corte: sin las dos elegidas el portal no muestra la lista.
async function elegirEvaluacion(pg) {
  const f = marco(pg);
  const evals = await f.evaluate(() => [...document.querySelectorAll("#evaluacion option")].map((o) => ({ v: o.value, t: o.text.trim() })));
  const ev = evals.find((o) => norm(o.t) === norm(EVALUACION));
  if (!ev) {
    const hay = evals.filter((o) => o.v !== "").map((o) => o.t);
    throw new Error(`El portal no ofrece «${EVALUACION}» todavía. Ofrece: ${hay.join(" | ") || "(ninguna)"}. Si el nombre es otro, ajustar cursos.json o pasar --evaluacion=.`);
  }
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
const yaEsta = (fila, valor) => (valor === "NP" ? fila.estado === NP : !fila.estado && fila.valor !== "" && Number(fila.valor) === Number(valor));
const actual = (fila) => (fila.estado === NP ? "NP" : fila.estado ? fila.estado : fila.valor || "·");

(async () => {
  const resumen = [];
  const cambiosRegistrados = [];
  console.log(`Corte ${CORTE} · ${EVALUACION} · ${REGISTRAR ? "REGISTRAR" : "en seco"} · CSV en ${path.relative(RAIZ, CARPETA)}`);
  for (const curso of cursosElegidos(opciones.solo)) {
    const ruta = archivoCsv(CARPETA, CORTE, curso);
    const r = { curso: curso.archivo };
    resumen.push(r);
    if (!fs.existsSync(ruta)) {
      r.error = "falta el CSV: correr primero leer-libro.cjs";
      console.log(`✗ ${curso.archivo}: ${r.error}`);
      continue;
    }
    const lista = leerCsv(ruta);
    const notas = {
      porDoc: new Map(lista.map((n) => [n.documento, n])),
      porNombre: new Map(lista.map((n) => [norm(n.estudiante), n])),
    };
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
      const registradoAntes = filas.some((x) => x.valor !== "" || x.estado);
      paso(`${curso.archivo} (grupo ${curso.grupo}): ${filas.length} en el portal, ${lista.length} en ExamLab, ${cambios.length} por escribir${registradoAntes ? " · el grupo ya tenía notas" : ""}`);
      for (const x of DETALLE ? plan : cambios) {
        console.log(`   ${x.ident.padEnd(18)} ${x.nombre.slice(0, 40).padEnd(40)} ${actual(x).padStart(4)} → ${x.poner.padEnd(3)} [${x.cruce}${x.n ? `, ExamLab ${x.n.nota.toFixed(2)}` : ""}]`);
      }
      for (const n of sobran) console.log(`   ⚠ En ExamLab y NO en el portal: ${n.estudiante} (${n.documento}), nota ${n.nota.toFixed(2)}`);
      for (const x of plan.filter((p) => !p.n)) console.log(`   ⚠ En el portal y sin nota en ExamLab (va NP): ${x.ident} ${x.nombre}`);
      Object.assign(r, { portal: filas.length, examlab: lista.length, np: plan.filter((x) => x.poner === "NP").length, sinExamlab: plan.filter((x) => !x.n).length, sobranExamlab: sobran.length, porEscribir: cambios.length });

      if (REGISTRAR && cambios.length) {
        // Un grupo ya registrado trae las cajas y el estado bloqueados: «Modificar»
        // habilita la caja de cada fila con nota y el estado de todas.
        if (filas.some((x) => x.bloqueada)) {
          await marco(s.pg).click("#btMod", { noWaitAfter: true });
          await s.pg.waitForTimeout(1500);
        }
        for (const x of cambios) {
          const f = marco(s.pg);
          if (x.poner === "NP") {
            // El portal pone 0.0 y bloquea la caja al elegir NP (bloquearNota).
            await f.selectOption(`select[name="estado_${x.i}"]`, NP);
          } else {
            // De NP (o PE/AN) a nota: estado en blanco libera la caja (bloquearNota).
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
        for (const x of cambios) cambiosRegistrados.push({ curso: curso.archivo, documento: x.numero, estudiante: x.nombre, antes: actual(x), despues: x.poner });
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

    // Verificación: se vuelve a abrir el grupo en una sesión nueva y se compara TODO el
    // grupo contra lo esperado. La confirmación del portal solo dice que el envío no
    // falló; lo que prueba el registro es esta relectura.
    if (REGISTRAR && r.registrado) {
      const v = await entrar();
      try {
        await abrirGrupo(v.pg, curso);
        await elegirEvaluacion(v.pg);
        const filas = await leerFilas(v.pg);
        const mal = filas.filter((f) => !yaEsta(f, esperado(notas, f).valor));
        r.verificadas = `${filas.length - mal.length}/${filas.length}`;
        paso(`   verificación: ${r.verificadas} filas con el valor esperado`);
        for (const f of mal) console.log(`   ✗ ${f.ident} ${f.nombre}: quedó «${actual(f)}», se esperaba ${esperado(notas, f).valor}`);
      } catch (e) {
        r.errorVerificacion = e.message;
        console.log(`   ✗ verificación: ${e.message}`);
      } finally {
        await v.b.close();
      }
    }
  }

  // Constancia de lo que se escribió, junto a los CSV del corte (carpeta privada).
  if (REGISTRAR && cambiosRegistrados.length) {
    const ruta = path.join(CARPETA, `registro-corte${CORTE}.jsonl`);
    const cuando = new Date().toISOString();
    fs.appendFileSync(ruta, cambiosRegistrados.map((c) => JSON.stringify({ cuando, evaluacion: EVALUACION, ...c })).join("\n") + "\n");
    console.log(`\nConstancia de ${cambiosRegistrados.length} cambios en ${path.relative(RAIZ, ruta)}`);
  }
  console.log("\nRESUMEN");
  for (const r of resumen) console.log(JSON.stringify(r));
  if (resumen.some((r) => r.error || r.errorVerificacion)) process.exitCode = 1;
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
