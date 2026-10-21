// Anexo «instrumento de evaluación diagnóstica»: las preguntas tal como se aplicaron
// en ExamLab, SIN respuestas ni rúbricas. Solo lectura. Correr desde la raíz del repo.
const { chromium } = require("C:/Projects/Personal/examlab/node_modules/playwright");
const fs = require("fs");
const env = fs.readFileSync(".env.local", "utf8") + "\n" + fs.readFileSync(".env", "utf8");
const key = env.match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\r\n]+)"?/m)[1];
const url = env.match(/^VITE_SUPABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)[1];
const get = async (p) => (await fetch(`${url}/rest/v1/${p}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })).json();

const OUT = process.argv[2];
const D = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const ASIG = {
  "Arquitectura 6303C": ["Arquitectura de Sistemas Computacionales", "6303C"],
  "Bases de Datos II 641A-2": ["Bases de Datos II", "641A"],
  "Introduccion LB141F": ["Introducción a la Ingeniería", "LB141F"],
  "Introduccion SB141B": ["Introducción a la Ingeniería", "SB141B"],
  "Introduccion SB141C": ["Introducción a la Ingeniería", "SB141C"],
  "Programacion II 341C": ["Programación II", "341C"],
  "Seminario de Sistemas 341C": ["Seminario de Sistemas", "341C"],
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function md(s) {
  const partes = String(s).split(/```[a-z]*\n?/);
  return partes.map((p, i) => {
    if (i % 2) return `<pre>${esc(p.trim())}</pre>`;
    return esc(p)
      .replace(/^#{1,6}\s*(.*)$/gm, "<b>$1</b>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/^---$/gm, "")
      .replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  }).join("");
}
const TIPO = { cerrada: "Selección única", cerrada_multi: "Selección múltiple", abierta: "Respuesta abierta", bd_sql: "Consulta SQL ejecutada en la base de datos del navegador", codigo: "Código" };

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  for (const [nombre, c] of Object.entries(D)) {
    const [asig, grupo] = ASIG[nombre];
    const ex = (await get(`exams?select=title,time_limit_minutes,start_time&id=eq.${c.diagnostica.id}`))[0];
    const qs = await get(`questions?select=type,content,options,points,position&exam_id=eq.${c.diagnostica.id}&order=position`);
    const items = qs.map((q, i) => {
      const op = q.options?.choices ? `<ol type="a">${q.options.choices.map((o) => `<li>${esc(o)}</li>`).join("")}</ol>` : "";
      const db = q.type === "bd_sql" && q.options?.db?.setupSql ? `<div class="sub">Esquema de partida cargado en la base de datos:</div><pre>${esc(q.options.db.setupSql.trim())}</pre>` : "";
      return `<div class="q"><div class="h">Pregunta ${i + 1} · ${TIPO[q.type] ?? q.type} · ${String(q.points).replace(".", ",")} pts</div><div>${md(q.content)}</div>${op}${db}</div>`;
    }).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page{size:A4;margin:16mm} body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#111;line-height:1.35}
      h1{font-size:13pt;margin:0 0 4px} .m{color:#444;font-size:9.5pt;margin-bottom:10px}
      .q{border-top:1px solid #999;padding:6px 0 8px;break-inside:avoid} .h{font-weight:bold;font-size:9.5pt;color:#333;margin-bottom:3px}
      pre{background:#f3f3f3;padding:6px;font-size:8.5pt;white-space:pre-wrap} code{background:#f3f3f3;padding:0 2px} ol{margin:4px 0 0 18px;padding:0} .sub{font-size:9pt;color:#444;margin-top:4px}
    </style></head><body>
      <h1>Anexo — Instrumento de evaluación diagnóstica</h1>
      <div class="m">${esc(asig)} · Grupo ${esc(grupo)} · Periodo 2026-2 · Docente: Julian Andres Castaño Espinosa<br>
      «${esc(ex.title)}», aplicada en la plataforma ExamLab${ex.time_limit_minutes ? ` (${ex.time_limit_minutes} minutos)` : ""}. ${qs.length} preguntas. No suma a la nota del curso. Se transcriben las preguntas tal como las vieron los estudiantes, sin las respuestas.</div>
      ${items}</body></html>`;
    await page.setContent(html, { waitUntil: "load" });
    const f = `${OUT}/ANEXO - ${nombre}.pdf`;
    await page.pdf({ path: f, format: "A4", printBackground: true });
    console.log(f, qs.length);
  }
  await b.close();
})();
