#!/usr/bin/env node
/**
 * Prueba de carga de la TOMA DE EXAMEN contra la instancia REAL de Supabase.
 *
 * Reproduce, con SESIONES AUTENTICADAS reales (no `service_role`, para que la
 * RLS cueste lo que cuesta en producción), el patrón de peticiones que hace la
 * pantalla de examen: el arranque (crear la entrega), el régimen estable
 * (latido de `updated_at`, guardado de respuestas al navegar, sondeo del reloj,
 * sondeo de notificaciones) y el cierre (todos entregan). Sube por escalones
 * 25→50→100→150→200 y ABORTA al primer signo de que la instancia sufre.
 *
 * ── Seguridad (la instancia la comparten TODAS las instituciones) ───────
 *   · Solo escribe sobre datos SINTÉTICOS que crea en el tenant de prueba
 *     Demo Global Corp (nunca UNIAJ / FESNA / Univalle).
 *   · `status` es una compuerta que se lee de la BASE, no de un horario escrito a
 *     mano (que se desactualiza: Arquitectura pasó a los viernes): ninguna clase
 *     en curso ni por empezar en una institución real, ningún examen real con la
 *     ventana abierta y ninguna sesión de examen viva. `run` y `ramp` la
 *     re-verifican antes de CADA escalón; `smoke` (10 VUs) solo exige que no haya
 *     un examen en curso.
 *   · Ante el primer 5xx / PGRST003 / 57014 corta EN CALIENTE: todos los usuarios
 *     virtuales paran ya. Con error > 1 % o p95 > 3 s no sube al siguiente escalón.
 *   · `setup` y `ampliar` no crean nada si están encendidos los avisos de
 *     bienvenida o de examen (`email_settings`): matricular y asignar mandarían
 *     correos a cuentas `@examlab.test`, que rebotan.
 *   · Cada cuenta inicia sesión UNA vez por corrida: Auth limita los inicios de
 *     sesión por IP y una rampa que se loguea en cada escalón se cae por un 429
 *     que no dice nada de la base. Con `ampliar` se reparten los VUs en más
 *     exámenes y hacen falta menos cuentas (25 × 8 = 200 pares).
 *   · No manda NINGÚN correo: las cuentas se crean por la API admin de Auth
 *     (sin correo de confirmación) y `email_settings.enabled_kinds.course_welcome`
 *     está apagado, así que matricular no dispara el correo de bienvenida.
 *
 * ── Credenciales ───────────────────────────────────────────────────────
 * Lee de `.env.local` / `.env` (NO se commitea nada): `VITE_SUPABASE_URL`,
 * `VITE_SUPABASE_PUBLISHABLE_KEY` (o `ANON`), `SUPABASE_SERVICE_ROLE_KEY`.
 * El `service_role` se usa SOLO para preparar/limpiar los datos sintéticos; la
 * carga en sí va con los JWT de las cuentas de prueba (RLS activa).
 *
 * ── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/exam-load-test.mjs status
 *   node scripts/exam-load-test.mjs setup [--accounts 50] [--exams 4] [--questions 5]
 *   node scripts/exam-load-test.mjs ampliar --exams 8   # más exámenes, mismas cuentas
 *   node scripts/exam-load-test.mjs smoke            # 1 escalón, 10 VUs, ~30 s
 *   node scripts/exam-load-test.mjs run --vus 100 --seconds 60
 *   node scripts/exam-load-test.mjs ramp [--steps 25,50,100,150,200] [--seconds 60]
 *   node scripts/exam-load-test.mjs teardown
 *
 * Opciones de carga:
 *   --kb-respuestas 10  tamaño de `answers` (10 KB es el p90 medido en producción
 *                       el 2026-10-30; la mediana es 5,3)
 *   --guardado-s 20     cada cuánto escribe cada alumno su contenido (la pantalla
 *                       lo hace al cambiar de pregunta y a lo sumo una vez por
 *                       minuto, así que 20 s es pesimista)
 *   --latido-s 20       `MS_ENTRE_LATIDOS` (con 5 se reproduce el patrón anterior)
 *   --llegada-s 30      en cuántos segundos entra la clase (4 = peor caso)
 *   --con-notificaciones  suma el sondeo de notificaciones, que en el examen no corre
 *
 * Resultado del 2026-10-30 (latido de 5 s): 100 y 150 alumnos sanos, 200 colapsa
 * (latidos de 26 s, guardados de 42 s). Ver CHANGELOG.
 *
 * El manifiesto (cuentas + ids creados + clave temporal aleatoria) se guarda en
 * `.exam-load-test.local` (cubierto por `*.local` del .gitignore).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ── Tenant de prueba y marcadores de lo sintético ──────────────────────────
const TENANT_DEMO_GLOBAL_CORP = "f1dcfedc-3c98-4b5c-9d11-2a922c7eb018";
// Cuenta de Demo Global Corp (Admin+Docente) usada SOLO como `created_by` de los
// exámenes sintéticos (columna NOT NULL). No se toca ni se borra en teardown.
const CREATED_BY_DEMO = "c6bda09b-ce49-4fe0-b83b-722560ab9928";
// Instituciones de PRUEBA: sus clases y exámenes no frenan la carga. Todas las
// demás cuentan como reales (UNIAJ, FESNA, Univalle y las que se sumen).
const TENANTS_DE_PRUEBA = new Set([
  TENANT_DEMO_GLOBAL_CORP,
  "729b3114-bf5d-4433-ac0e-d1e3aedb1358", // ExamLab Demo
]);
// Una clase frena la carga desde un rato antes de empezar hasta un rato después.
const MARGEN_ANTES_DE_CLASE_MIN = 30;
const MARGEN_DESPUES_DE_CLASE_MIN = 15;
const MARCA = "ZZZ-carga-sintetica";
const MANIFEST = ".exam-load-test.local";

// ── Umbrales de aborto (protegen producción) ───────────────────────────────
const MAX_ERROR_RATE = 0.01; // 1 %
const MAX_P95_MS = 3000;

// ── Lectura de secretos (mismo patrón que scripts/db-query.mjs) ─────────────
function leerSecreto(nombre) {
  if (process.env[nombre]) return process.env[nombre];
  for (const archivo of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(archivo, "utf8");
      const m = txt.match(new RegExp(`^${nombre}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"));
      if (m) return m[1];
    } catch {
      /* puede no existir */
    }
  }
  return null;
}

const URL_BASE = (leerSecreto("VITE_SUPABASE_URL") ?? leerSecreto("SUPABASE_URL") ?? "").replace(/\/$/, "");
const ANON = leerSecreto("VITE_SUPABASE_PUBLISHABLE_KEY") ?? leerSecreto("ANON") ?? leerSecreto("VITE_SUPABASE_ANON_KEY");
const SERVICE = leerSecreto("SUPABASE_SERVICE_ROLE_KEY");

if (!URL_BASE || !ANON) {
  console.error("Falta VITE_SUPABASE_URL o la anon key (.env / .env.local).");
  process.exit(2);
}

// ── Utilidades ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, frac = 0.3) => base + Math.floor(Math.random() * base * frac);

function bogota(d = new Date()) {
  const f = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return f.format(d);
}

/** Fecha (AAAA-MM-DD) y minuto del día en Bogotá. */
function ahoraEnBogota(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const v = (t) => p.find((x) => x.type === t).value;
  return { fecha: `${v("year")}-${v("month")}-${v("day")}`, minuto: (Number(v("hour")) % 24) * 60 + Number(v("minute")) };
}

/**
 * Compuerta de seguridad, leída de la base. Devuelve los motivos por categoría:
 *   clases  → una sesión de clase de una institución real en curso o por empezar
 *   examenes→ un examen real publicado con la ventana abierta ahora
 *   vivas   → una entrega `en_progreso` con latido de menos de 2 minutos
 * Una clase sin examen igual frena la rampa: si la base sufre, sufre para todos.
 */
async function compuerta(m = null) {
  const sinteticos = new Set(m ? m.exams.map((e) => e.id) : []);
  const motivos = { clases: [], examenes: [], vivas: [] };
  const tenantDeCurso = async (ids) => {
    const unicos = [...new Set(ids)].filter(Boolean);
    if (!unicos.length) return {};
    const cursos = await svc(`courses?select=id,tenant_id&id=in.(${unicos.join(",")})`);
    return Object.fromEntries(cursos.map((c) => [c.id, c.tenant_id]));
  };

  const { fecha, minuto } = ahoraEnBogota();
  const sesiones = await svc(
    `attendance_sessions?select=title,course_id,start_time,duration_minutes&session_date=eq.${fecha}&deleted_at=is.null`,
  );
  const tenantSesion = await tenantDeCurso(sesiones.map((s) => s.course_id));
  for (const s of sesiones) {
    if (!s.start_time || TENANTS_DE_PRUEBA.has(tenantSesion[s.course_id])) continue;
    const [h, mi] = s.start_time.split(":").map(Number);
    const inicio = h * 60 + mi;
    const fin = inicio + (s.duration_minutes ?? 120);
    if (minuto >= inicio - MARGEN_ANTES_DE_CLASE_MIN && minuto <= fin + MARGEN_DESPUES_DE_CLASE_MIN) {
      motivos.clases.push(`${s.title} (${s.start_time.slice(0, 5)}, ${s.duration_minutes ?? "?"} min)`);
    }
  }

  const ahora = new Date().toISOString();
  const abiertos = await svc(
    `exams?select=id,title,course_id&status=eq.published&is_external=eq.false&start_time=lte.${ahora}&end_time=gte.${ahora}&deleted_at=is.null`,
  );
  const tenantExamen = await tenantDeCurso(abiertos.map((e) => e.course_id));
  for (const e of abiertos) {
    if (sinteticos.has(e.id) || TENANTS_DE_PRUEBA.has(tenantExamen[e.course_id])) continue;
    motivos.examenes.push(`${e.title} (${e.id})`);
  }

  const haceDosMin = new Date(Date.now() - 120000).toISOString();
  const vivas = await svc(
    `submissions?select=id,exam_id&status=eq.en_progreso&updated_at=gte.${haceDosMin}`,
  );
  for (const s of vivas) {
    if (!sinteticos.has(s.exam_id)) motivos.vivas.push(`entrega ${s.id} (examen ${s.exam_id})`);
  }

  const total = motivos.clases.length + motivos.examenes.length + motivos.vivas.length;
  return { seguro: total === 0, motivos };
}

function imprimirCompuerta({ seguro, motivos }) {
  const bloque = (titulo, lista) => {
    console.log(`${titulo}: ${lista.length}`);
    for (const x of lista) console.log(`    ⚠ ${x}`);
  };
  bloque("Clases en curso o por empezar (instituciones reales)", motivos.clases);
  bloque("Exámenes reales con la ventana abierta", motivos.examenes);
  bloque("Sesiones de examen vivas (latido < 2 min)", motivos.vivas);
  console.log(seguro ? "✅ Ventana segura." : "⛔ No es seguro correr carga ahora.");
}

/** REST con service_role (solo setup/teardown). */
async function svc(path, { method = "GET", body, prefer } = {}) {
  if (!SERVICE) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY en .env.local");
  const headers = {
    apikey: SERVICE,
    Authorization: `Bearer ${SERVICE}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json = null;
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch {
    json = txt;
  }
  if (!res.ok) {
    throw new Error(`svc ${method} ${path} → HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return json;
}

/** Crea un usuario por la API admin de Auth (NO manda correo). */
async function adminCreateUser(email, password) {
  const res = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`admin create user ${email} → HTTP ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

async function adminDeleteUser(userId) {
  const res = await fetch(`${URL_BASE}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  if (!res.ok && res.status !== 404) {
    const txt = await res.text();
    throw new Error(`admin delete user ${userId} → HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
}

/** Login por contraseña → access_token (sesión REAL de alumno). Ante un 429
 *  (Auth limita los inicios de sesión por IP) espera y reintenta. */
async function login(email, password) {
  for (let intento = 1; ; intento++) {
    const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const txt = await res.text();
    if (res.ok) {
      const j = JSON.parse(txt);
      return { token: j.access_token, venceEn: Date.now() + (j.expires_in ?? 3600) * 1000 };
    }
    if (res.status === 429 && intento <= 6) {
      console.log(`  (429 al iniciar sesión: Auth limita por IP; espero 60 s, intento ${intento}/6)`);
      await sleep(60000);
      continue;
    }
    throw new Error(`login ${email} → HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
}

// Un token por cuenta para TODA la corrida: re-loguear en cada escalón agota el
// límite de Auth y la rampa se cae por algo que no tiene que ver con la base.
const tokens = new Map();
async function tokenDe(cuenta, password) {
  const t = tokens.get(cuenta.userId);
  if (t && t.venceEn - Date.now() > 5 * 60 * 1000) return t.token;
  const nuevo = await login(cuenta.email, password);
  tokens.set(cuenta.userId, nuevo);
  return nuevo.token;
}

/**
 * Petición autenticada como alumno (RLS activa). Devuelve métrica + clasificación
 * de error SIN tirar: la carga no debe abortar por un error puntual, lo cuenta.
 */
async function userReq(token, path, { method = "GET", body, prefer } = {}) {
  const t0 = Date.now();
  const headers = {
    apikey: ANON,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  let status = 0;
  let code = null;
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    const txt = await res.text();
    let detalle = null;
    if (!res.ok) {
      try {
        const j = JSON.parse(txt);
        code = j?.code ?? null;
        detalle = j?.message ?? null;
      } catch {
        code = null;
      }
    }
    return { ms: Date.now() - t0, status, code, ok: res.ok, body: res.ok ? txt : null, detalle };
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, code: "network", ok: false, err: String(e) };
  }
}

// ── Manifiesto ──────────────────────────────────────────────────────────────
function leerManifiesto() {
  if (!existsSync(MANIFEST)) {
    console.error(`No hay manifiesto (${MANIFEST}). Corre primero:  node scripts/exam-load-test.mjs setup`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}
function guardarManifiesto(m) {
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

// ── Payload de respuestas realista ──────────────────────────────────────────
// Medido en producción el 2026-10-30 sobre 300 entregas: p50 5,3 KB, p90 10,4 KB,
// p99 13,7 KB. Por defecto se escribe el p90 (--kb-respuestas 10): la prueba
// tiene que ser más pesada que la realidad, no más liviana.
const KB_RESPUESTAS = argNum("--kb-respuestas", 10);
const FRASE =
  "Las sentencias condicionales permiten ejecutar bloques según una condición booleana; " +
  "en Java existen if, if-else, la escalera else-if y switch. ";
function respuestasRealistas(questionIds, sessionId, idx, warningEvents = []) {
  const bytesPorRespuesta = Math.max(64, Math.floor((KB_RESPUESTAS * 1024) / Math.max(1, questionIds.length)));
  const relleno = FRASE.repeat(Math.ceil(bytesPorRespuesta / FRASE.length)).slice(0, bytesPorRespuesta);
  const ans = { __session_id: sessionId, __current_idx: idx, __saved_at: Date.now(), __warning_events: warningEvents };
  for (const qid of questionIds) ans[qid] = relleno;
  return ans;
}

// ── Percentiles ─────────────────────────────────────────────────────────────
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}

function argNum(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function argStr(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// ════════════════════════════════════════════════════════════════════════════
// Comando: status (compuerta de seguridad)
// ════════════════════════════════════════════════════════════════════════════
async function cmdStatus() {
  console.log(`Hora Bogotá: ${bogota()}`);
  const m = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
  const c = await compuerta(m);
  imprimirCompuerta(c);
  return c.seguro;
}

/**
 * Matricular dispara la bienvenida al curso y asignar un examen publicado, el
 * aviso de examen. Con esas categorías encendidas saldrían correos a cuentas
 * `@examlab.test`, que rebotan y dañan la reputación del correo de la plataforma,
 * así que no se crea nada. `email_settings` es UNA fila global: el dueño la
 * enciende para uso real, por eso se mira cada vez. Una clave ausente cuenta como
 * encendida, igual que en el trigger que filtra los avisos.
 */
async function exigirAvisosApagados() {
  const [cfg] = await svc("email_settings?select=globally_enabled,enabled_kinds&limit=1");
  const k = cfg?.enabled_kinds ?? {};
  const encendidas = ["course_welcome", "welcome", "exam"].filter((x) => k[x] !== false);
  if (cfg?.globally_enabled !== false && encendidas.length) {
    console.error(
      `⛔ Avisos encendidos (${encendidas.join(", ")}): matricular o asignar mandaría correos a las cuentas de prueba. ` +
        "No se crea nada. Córrelo cuando esas categorías estén apagadas (Configuración → Correos).",
    );
    process.exit(3);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Comando: setup
// ════════════════════════════════════════════════════════════════════════════
async function cmdSetup() {
  if (!SERVICE) {
    console.error("setup necesita SUPABASE_SERVICE_ROLE_KEY en .env.local");
    process.exit(2);
  }
  await exigirAvisosApagados();
  const nAccounts = argNum("--accounts", 50);
  const nExams = argNum("--exams", 4);
  const nQuestions = argNum("--questions", 5);
  const pares = nAccounts * nExams;
  console.log(`Creando ${nAccounts} cuentas × ${nExams} exámenes = ${pares} pares (submissions distintas).`);
  const password = `Carga#${randomUUID().slice(0, 12)}`;

  // 1) Curso sintético
  const [curso] = await svc("courses", {
    method: "POST",
    prefer: "return=representation",
    body: [
      {
        name: `${MARCA} (borrar)`,
        description: "Curso sintético para prueba de carga. Se puede borrar.",
        tenant_id: TENANT_DEMO_GLOBAL_CORP,
        status: "en_curso",
        period: "carga",
        start_date: "2026-01-01",
        end_date: "2030-12-31",
        grade_scale_min: 0,
        grade_scale_max: 5,
        passing_grade: 3,
      },
    ],
  });
  console.log(`  curso: ${curso.id}`);

  // 2) Exámenes + preguntas
  const examRows = Array.from({ length: nExams }, (_, i) => ({
    course_id: curso.id,
    created_by: CREATED_BY_DEMO,
    title: `${MARCA} examen ${i + 1}`,
    description: "Examen sintético de carga.",
    start_time: "2026-01-01T00:00:00Z",
    end_time: "2030-12-31T23:59:00Z",
    time_limit_minutes: 120,
    navigation_type: "libre",
    shuffle_enabled: false,
    is_external: false,
    schedule_type: "normal",
    status: "published",
  }));
  const exams = await svc("exams", { method: "POST", prefer: "return=representation", body: examRows });
  console.log(`  exámenes: ${exams.length}`);

  const examQuestions = {};
  for (const ex of exams) {
    const qRows = Array.from({ length: nQuestions }, (_, j) => ({
      exam_id: ex.id,
      type: "abierta",
      content: `Pregunta ${j + 1} del examen de carga. Explique con detalle.`,
      expected_rubric: "Respuesta sintética.",
      points: 1,
      position: j + 1,
    }));
    const qs = await svc("questions", { method: "POST", prefer: "return=representation", body: qRows });
    examQuestions[ex.id] = qs.map((q) => q.id);
  }
  console.log(`  preguntas: ${nQuestions} por examen`);

  // 3) Cuentas + perfil + rol + matrícula + asignaciones
  const cuentas = [];
  for (let i = 0; i < nAccounts; i++) {
    const email = `loadtest-${randomUUID().slice(0, 8)}@examlab.test`;
    const u = await adminCreateUser(email, password);
    const userId = u.id;
    // El trigger handle_new_user ya creó el profile; lo anclamos al tenant.
    await svc(`profiles?id=eq.${userId}`, {
      method: "PATCH",
      body: { tenant_id: TENANT_DEMO_GLOBAL_CORP, is_active: true, full_name: `Carga ${i + 1}`, must_change_password: false },
    });
    await svc("user_roles", {
      method: "POST",
      prefer: "resolution=ignore-duplicates",
      body: [{ user_id: userId, role: "Estudiante" }],
    });
    await svc("course_enrollments", {
      method: "POST",
      prefer: "resolution=ignore-duplicates",
      body: [{ course_id: curso.id, user_id: userId }],
    });
    // La RLS de `exams` SELECT para un ESTUDIANTE exige estar ASIGNADO (ver el
    // examen por tenant no alcanza), y la de INSERT de `submissions` corre ese
    // mismo EXISTS bajo la RLS del alumno. Sin asignación → 403. No hay trigger
    // de auto-asignación al matricular (verificado), así que se crean acá. El
    // try/catch tolera un 23505 por si en algún entorno sí hubiera trigger.
    try {
      await svc("exam_assignments", {
        method: "POST",
        body: exams.map((ex) => ({ exam_id: ex.id, user_id: userId })),
      });
    } catch (e) {
      if (!String(e.message).includes("23505")) throw e;
    }
    cuentas.push({ email, userId });
    if ((i + 1) % 10 === 0) console.log(`  cuentas: ${i + 1}/${nAccounts}`);
  }

  const manifiesto = {
    creadoEn: new Date().toISOString(),
    tenant: TENANT_DEMO_GLOBAL_CORP,
    password,
    courseId: curso.id,
    exams: exams.map((e) => ({ id: e.id, questionIds: examQuestions[e.id] })),
    cuentas,
  };
  guardarManifiesto(manifiesto);
  console.log(`\nManifiesto → ${MANIFEST}`);

  // 4) Verificación end-to-end con UNA cuenta (RLS: login + insert + update + delete)
  console.log("\nVerificando RLS con una cuenta real…");
  const { token } = await login(cuentas[0].email, password);
  const ex0 = exams[0];
  const sid = randomUUID();
  const ins = await userReq(token, "submissions", {
    method: "POST",
    prefer: "return=representation",
    body: {
      exam_id: ex0.id,
      user_id: cuentas[0].userId,
      answers: { __session_id: sid },
      status: "en_progreso",
    },
  });
  if (!ins.ok) {
    console.error(`  ❌ INSERT submission falló: HTTP ${ins.status} code=${ins.code}. Revisa la RLS o el setup.`);
    process.exit(4);
  }
  const subId = JSON.parse(ins.body)[0].id;
  const upd = await userReq(token, `submissions?id=eq.${subId}`, {
    method: "PATCH",
    body: { answers: respuestasRealistas(examQuestions[ex0.id], sid, 0), focus_warnings: 0 },
  });
  await userReq(token, `submissions?id=eq.${subId}`, { method: "DELETE" });
  console.log(
    `  INSERT ${ins.ok ? "ok" : "FALLO"} (${ins.ms} ms) · UPDATE ${upd.ok ? "ok" : "FALLO"} (${upd.ms} ms) · DELETE ok`,
  );
  console.log(upd.ok ? "✅ setup verificado. Listo para smoke / ramp." : "❌ El UPDATE falló; revisa antes de seguir.");
}

// ════════════════════════════════════════════════════════════════════════════
// Carga: un VU (par cuenta×examen) corre el patrón real de la pantalla
// ════════════════════════════════════════════════════════════════════════════
async function correrVU(ctx, par, deadline, registros) {
  const { token, userId } = par.cuenta;
  // El manifiesto guarda cada examen como `{ id, questionIds }`.
  const { id: examId, questionIds } = par.examen;
  const sessionId = randomUUID();
  const rec = (tipo, r) => {
    registros.push({
      tipo, ms: r.ms, status: r.status, code: r.code, ok: r.ok, ruta: r.ruta, detalle: r.detalle,
      inicio: Date.now() - r.ms,
    });
    // Corte EN CALIENTE: ante el primer síntoma de que la base sufre, todos los
    // usuarios virtuales paran ya, sin esperar al final del escalón.
    if (r.status >= 500 || r.code === "PGRST003" || r.code === "57014") ctx.abortado = true;
  };
  const sigue = () => Date.now() < deadline && !ctx.abortado;

  // Arranque: las lecturas que hace la pantalla al abrir el examen (mismas tablas
  // y filtros que `TakeExamScreen`), y después crear la entrega. Es la ráfaga de
  // inicio: la clase entera abre el examen en el mismo minuto.
  const lecturas = [
    "app_settings?select=require_exam_fullscreen,max_open_answer_chars",
    `exams?select=*,course:courses(language,max_exam_attempts)&id=eq.${examId}&deleted_at=is.null`,
    "app_settings?select=exam_autosave_mode",
    "code_execution_settings?select=provider&is_active=eq.true",
    `exam_timer_controls?select=action,extra_seconds,target_user_id&exam_id=eq.${examId}&or=(target_user_id.is.null,target_user_id.eq.${userId})`,
    `exam_assignments?select=id&exam_id=eq.${examId}&user_id=eq.${userId}`,
    `questions?select=*&exam_id=eq.${examId}&order=position`,
    `submissions?select=*&exam_id=eq.${examId}&user_id=eq.${userId}&order=created_at.desc`,
  ];
  for (const ruta of lecturas) {
    if (ctx.abortado) return;
    const r = await userReq(token, ruta);
    // La tabla y las columnas pedidas: dos lecturas de `app_settings` distintas
    // tienen que poder distinguirse en el desglose.
    r.ruta = ruta.split("&")[0];
    rec("arranque_lectura", r);
  }
  const ins = await userReq(token, "submissions", {
    method: "POST",
    prefer: "return=representation",
    body: { exam_id: examId, user_id: userId, answers: { __session_id: sessionId }, status: "en_progreso" },
  });
  rec("arranque_insert", ins);
  if (!ins.ok) return; // sin entrega no hay loop
  const subId = JSON.parse(ins.body)[0].id;

  // Bucles independientes (como la pantalla): latido, sondeo reloj, sondeo
  // notificaciones y escritura de respuestas. Cada uno con jitter.
  let idx = 0;
  const loops = [
    // Latido (--latido-s, el `MS_ENTRE_LATIDOS` de la pantalla): solo updated_at.
    // Es la escritura más frecuente del examen.
    (async () => {
      await sleep(Math.floor(Math.random() * ctx.latidoMs)); // desfase inicial, como la pantalla
      while (sigue()) {
        await sleep(ctx.latidoMs);
        if (!sigue()) break;
        rec("latido", await userReq(token, `submissions?id=eq.${subId}`, {
          method: "PATCH",
          body: { updated_at: new Date().toISOString() },
        }));
      }
    })(),
    // Sondeo del reloj: cada ~10 s y cada ~4 s en el tramo final, como
    // `msEntreSondeos` en los dos últimos minutos del examen.
    (async () => {
      while (sigue()) {
        await sleep(jitter(deadline - Date.now() <= ctx.tramoFinalMs ? 4000 : 10000));
        if (!sigue()) break;
        rec("sondeo_reloj", await userReq(
          token,
          `exam_timer_controls?select=*&exam_id=eq.${examId}&or=(target_user_id.is.null,target_user_id.eq.${userId})&order=created_at.desc&limit=1`,
        ));
      }
    })(),
    // Sondeo de notificaciones cada ~60 s. Durante el examen NO existe: los tres
    // lugares que montan `useNotifications` (campanita, flotante de mensajes,
    // tablero) están ocultos o desmontados mientras se presenta. Solo con
    // --con-notificaciones, para medir el peor caso.
    (async () => {
      if (!ctx.conNotificaciones) return;
      while (sigue()) {
        await sleep(jitter(60000, 0.2));
        if (!sigue()) break;
        rec("sondeo_notif", await userReq(
          token,
          `notifications?select=*&user_id=eq.${userId}&order=created_at.desc&limit=50`,
        ));
      }
    })(),
    // Escritura de respuestas (--kb-respuestas) cada --guardado-s: modela al
    // alumno que responde y navega. Las navegaciones SIN cambio de contenido no
    // generan petición en la pantalla real, así que aquí no se modelan.
    (async () => {
      while (sigue()) {
        await sleep(jitter(ctx.guardadoMs));
        if (!sigue()) break;
        idx = (idx + 1) % questionIds.length;
        rec("guardado_contenido", await userReq(token, `submissions?id=eq.${subId}`, {
          method: "PATCH",
          body: { answers: respuestasRealistas(questionIds, sessionId, idx), focus_warnings: 0 },
        }));
      }
    })(),
  ];
  await Promise.all(loops);

  // Cierre: entrega con dispersión (igual que el cliente: MS_DISPERSION=8 s). Si el
  // escalón se cortó en caliente, no se escribe más: `limpiarSubmissions` borra.
  if (ctx.abortado) return;
  await sleep(Math.floor(Math.random() * ctx.closeStaggerMs));
  rec("cierre", await userReq(token, `submissions?id=eq.${subId}`, {
    method: "PATCH",
    body: {
      answers: respuestasRealistas(questionIds, sessionId, idx),
      status: "completado",
      submitted_at: new Date().toISOString(),
      focus_warnings: 0,
    },
  }));
}

/** Arma los pares cuenta×examen (hasta `vus`), con un token por cuenta que se
 *  reutiliza en todos los escalones. */
async function prepararPares(m, vus) {
  const nCuentasNecesarias = Math.min(m.cuentas.length, Math.ceil(vus / m.exams.length));
  const pares = [];
  outer: for (let ci = 0; ci < nCuentasNecesarias; ci++) {
    const cuenta = { ...m.cuentas[ci], token: await tokenDe(m.cuentas[ci], m.password) };
    for (const examen of m.exams) {
      pares.push({ cuenta, examen });
      if (pares.length >= vus) break outer;
    }
  }
  return pares;
}

/** Borra las submissions sintéticas (service_role) para arrancar limpio. */
async function limpiarSubmissions(m) {
  const ids = m.exams.map((e) => e.id);
  await svc(`submissions?exam_id=in.(${ids.join(",")})`, { method: "DELETE" });
}

function resumen(nombre, registros, vus) {
  const ms = registros.map((r) => r.ms);
  const errores = registros.filter((r) => !r.ok);
  const c5xx = registros.filter((r) => r.status >= 500).length;
  const cPool = registros.filter((r) => r.code === "PGRST003").length;
  const cTimeout = registros.filter((r) => r.code === "57014").length;
  const cRed = registros.filter((r) => r.code === "network").length;
  const errorRate = registros.length ? errores.length / registros.length : 0;
  const p50 = pct(ms, 50);
  const p95 = pct(ms, 95);
  const p99 = pct(ms, 99);
  console.log(
    `\n── ${nombre} · VUs=${vus} · ${registros.length} peticiones ──────────────`,
  );
  console.log(`   p50 ${p50} ms · p95 ${p95} ms · p99 ${p99} ms · máx ${Math.max(0, ...ms)} ms`);
  console.log(
    `   errores ${errores.length} (${(errorRate * 100).toFixed(2)} %) · 5xx ${c5xx} · PGRST003 ${cPool} · 57014 ${cTimeout} · red ${cRed}`,
  );
  // Desglose por tipo de petición.
  const tipos = [...new Set(registros.map((r) => r.tipo))];
  for (const t of tipos) {
    const sub = registros.filter((r) => r.tipo === t);
    const subMs = sub.map((r) => r.ms);
    const e = sub.filter((r) => !r.ok).length;
    console.log(
      `     · ${t.padEnd(18)} n=${String(sub.length).padStart(5)}  p50=${pct(subMs, 50)}  p95=${pct(subMs, 95)}  err=${e}`,
    );
    if (t === "arranque_lectura") {
      // Qué lectura del arranque pesa: es la que hay que aligerar primero.
      const rutas = [...new Set(sub.map((r) => r.ruta))];
      for (const ruta of rutas) {
        const ms = sub.filter((r) => r.ruta === ruta).map((r) => r.ms);
        console.log(`         ${String(ruta).slice(0, 70).padEnd(70)} p50=${pct(ms, 50)}  p95=${pct(ms, 95)}`);
      }
    }
    if (e) {
      // Qué falló, no solo cuánto: un 4xx es un error del script, un 5xx de la base.
      const porCodigo = {};
      for (const r of sub.filter((x) => !x.ok)) {
        const k = `HTTP ${r.status}${r.code ? ` ${r.code}` : ""}${r.ruta ? ` ${r.ruta}` : ""}${r.detalle ? ` — ${String(r.detalle).slice(0, 90)}` : ""}`;
        porCodigo[k] = (porCodigo[k] ?? 0) + 1;
      }
      for (const [k, n] of Object.entries(porCodigo)) console.log(`         ${n}× ${k}`);
    }
  }
  // Línea de tiempo por tramos de 10 s (según cuándo EMPEZÓ cada petición): dice
  // si la lentitud es pareja, se concentra en un momento (el arranque, el tramo
  // final del reloj, el cierre) o llega en atascos periódicos.
  if (registros.length) {
    const t0 = Math.min(...registros.map((r) => r.inicio));
    const tramos = new Map();
    for (const r of registros) {
      const k = Math.floor((r.inicio - t0) / 10000);
      if (!tramos.has(k)) tramos.set(k, []);
      tramos.get(k).push(r);
    }
    console.log("   línea de tiempo (tramos de 10 s): peticiones · p50 · p95 · tipo más lento");
    for (const k of [...tramos.keys()].sort((a, b) => a - b)) {
      const sub = tramos.get(k);
      const ms = sub.map((r) => r.ms);
      const lenta = sub.reduce((a, b) => (b.ms > a.ms ? b : a));
      console.log(
        `     ${String(k * 10).padStart(4)}s  n=${String(sub.length).padStart(4)}  p50=${String(pct(ms, 50)).padStart(5)}  p95=${String(pct(ms, 95)).padStart(5)}  ${lenta.tipo}`,
      );
    }
  }
  const motivos = [];
  if (c5xx) motivos.push(`${c5xx}×5xx`);
  if (cPool) motivos.push(`${cPool}×PGRST003`);
  if (cTimeout) motivos.push(`${cTimeout}×57014`);
  if (errorRate > MAX_ERROR_RATE) motivos.push(`error ${(errorRate * 100).toFixed(2)}%>1%`);
  if (p95 > MAX_P95_MS) motivos.push(`p95 ${p95}ms>${MAX_P95_MS}ms`);
  return { p50, p95, p99, errorRate, c5xx, cPool, cTimeout, abortar: motivos.length > 0, motivos };
}

async function correrEscalon(m, vus, seconds, ctx) {
  ctx.abortado = false;
  await limpiarSubmissions(m);
  const pares = await prepararPares(m, vus);
  if (pares.length < vus) {
    console.log(`  (solo hay ${pares.length} pares; el setup tiene ${m.cuentas.length}×${m.exams.length})`);
  }
  const registros = [];
  const deadline = Date.now() + seconds * 1000;
  // Llegada de la clase (--llegada-s, 30 por defecto). Con el examen cerrado la
  // pantalla manda al alumno a la lista, así que nadie espera DENTRO: cuando abre
  // la ventana, la clase entra desde la lista a lo largo de unos segundos. Con
  // --llegada-s 4 se mide el peor caso (todos en el mismo instante).
  const spread = ctx.llegadaMs;
  const vusP = pares.slice(0, vus).map(async (par, i) => {
    await sleep(Math.floor((i / vus) * spread));
    if (ctx.abortado) return; // cortado en caliente: los que no llegaron, no entran
    await correrVU(ctx, par, deadline, registros);
  });
  await Promise.all(vusP);
  return resumen(`escalón`, registros, vus);
}

/** Parámetros de la carga. El tramo final (sondeo del reloj cada 4 s) es el
 *  último cuarto del escalón, hasta 2 minutos como en la pantalla. */
function contexto(seconds) {
  return {
    closeStaggerMs: argNum("--close-stagger-ms", 8000),
    guardadoMs: argNum("--guardado-s", 20) * 1000,
    llegadaMs: argNum("--llegada-s", 30) * 1000,
    // `MS_ENTRE_LATIDOS` de la pantalla (20 s desde el 2026-10-30; antes, 5).
    latidoMs: argNum("--latido-s", 20) * 1000,
    conNotificaciones: process.argv.includes("--con-notificaciones"),
    tramoFinalMs: Math.min(120000, Math.floor(seconds * 1000 * 0.25)),
  };
}

async function cmdRun() {
  const m = leerManifiesto();
  const vus = argNum("--vus", 25);
  const seconds = argNum("--seconds", 60);
  const ctx = contexto(seconds);
  const c = await compuerta(m);
  if (!c.seguro) {
    imprimirCompuerta(c);
    process.exit(3);
  }
  console.log(`run VUs=${vus} seconds=${seconds} guardado=${ctx.guardadoMs / 1000}s respuestas=${KB_RESPUESTAS}KB`);
  const r = await correrEscalon(m, vus, seconds, ctx);
  await limpiarSubmissions(m);
  console.log(r.abortar ? `\n⛔ Señales de estrés: ${r.motivos.join(", ")}` : "\n✅ Escalón sano.");
}

async function cmdSmoke() {
  const m = leerManifiesto();
  const ctx = contexto(30);
  // 10 VUs no cargan la base; lo único que frena el humo es un examen en curso.
  const c = await compuerta(m);
  if (c.motivos.examenes.length || c.motivos.vivas.length) {
    imprimirCompuerta(c);
    process.exit(3);
  }
  console.log("Prueba de HUMO: 10 VUs, 30 s + cierre.");
  const r = await correrEscalon(m, 10, 30, ctx);
  await limpiarSubmissions(m);
  console.log(r.abortar ? `\n⛔ ${r.motivos.join(", ")}` : "\n✅ Humo sano.");
}

async function cmdRamp() {
  const m = leerManifiesto();
  const steps = argStr("--steps", "25,50,100,150,200").split(",").map(Number);
  const seconds = argNum("--seconds", 60);
  const ctx = contexto(seconds);
  console.log(
    `RAMP ${steps.join("→")} · ${seconds}s por escalón · llegada en ${ctx.llegadaMs / 1000}s · latido cada ${ctx.latidoMs / 1000}s · guardado cada ${ctx.guardadoMs / 1000}s · respuestas de ${KB_RESPUESTAS} KB\n`,
  );

  for (const vus of steps) {
    // Re-verificar la compuerta ANTES de cada escalón: una clase puede empezar
    // o un examen real abrirse mientras la rampa corre.
    const c = await compuerta(m);
    if (!c.seguro) {
      imprimirCompuerta(c);
      console.log(`⛔ Detengo la rampa antes del escalón de ${vus} VUs (${bogota()}).`);
      break;
    }
    console.log(`\n═══ Escalón ${vus} VUs (${bogota()}) ═══`);
    const r = await correrEscalon(m, vus, seconds, ctx);
    if (r.abortar) {
      console.log(`\n⛔ ABORTO en ${vus} VUs: ${r.motivos.join(", ")}. No subo más.`);
      await limpiarSubmissions(m);
      return;
    }
    console.log(`✅ ${vus} VUs OK. Pausa 10 s antes del próximo escalón…`);
    await limpiarSubmissions(m);
    await sleep(10000);
  }
  console.log("\n✅ Rampa completa sin señales de estrés.");
}

// ════════════════════════════════════════════════════════════════════════════
// Comando: ampliar — más exámenes sintéticos para las MISMAS cuentas. Cada VU es
// un par cuenta×examen distinto; con más exámenes hacen falta menos cuentas, y
// por lo tanto menos inicios de sesión (25 cuentas × 8 exámenes = 200 pares).
// ════════════════════════════════════════════════════════════════════════════
async function cmdAmpliar() {
  if (!SERVICE) {
    console.error("ampliar necesita SUPABASE_SERVICE_ROLE_KEY en .env.local");
    process.exit(2);
  }
  await exigirAvisosApagados();
  const m = leerManifiesto();
  const objetivo = argNum("--exams", 8);
  const faltan = objetivo - m.exams.length;
  if (faltan <= 0) {
    console.log(`Ya hay ${m.exams.length} exámenes sintéticos; no hace falta ampliar.`);
    return;
  }
  const nQuestions = m.exams[0]?.questionIds.length ?? 5;
  const nuevos = await svc("exams", {
    method: "POST",
    prefer: "return=representation",
    body: Array.from({ length: faltan }, (_, i) => ({
      course_id: m.courseId,
      created_by: CREATED_BY_DEMO,
      title: `${MARCA} examen ${m.exams.length + i + 1}`,
      description: "Examen sintético de carga.",
      start_time: "2026-01-01T00:00:00Z",
      end_time: "2030-12-31T23:59:00Z",
      time_limit_minutes: 120,
      navigation_type: "libre",
      shuffle_enabled: false,
      is_external: false,
      schedule_type: "normal",
      status: "published",
    })),
  });
  for (const ex of nuevos) {
    const qs = await svc("questions", {
      method: "POST",
      prefer: "return=representation",
      body: Array.from({ length: nQuestions }, (_, j) => ({
        exam_id: ex.id,
        type: "abierta",
        content: `Pregunta ${j + 1} del examen de carga. Explique con detalle.`,
        expected_rubric: "Respuesta sintética.",
        points: 1,
        position: j + 1,
      })),
    });
    m.exams.push({ id: ex.id, questionIds: qs.map((q) => q.id) });
  }
  // Asignar los exámenes nuevos a todas las cuentas: la RLS del alumno exige
  // estar asignado para ver el examen y para crear su entrega.
  const filas = [];
  for (const c of m.cuentas) for (const ex of nuevos) filas.push({ exam_id: ex.id, user_id: c.userId });
  for (let i = 0; i < filas.length; i += 200) {
    await svc("exam_assignments", { method: "POST", body: filas.slice(i, i + 200) });
  }
  guardarManifiesto(m);
  console.log(`✅ ${nuevos.length} exámenes nuevos (${m.exams.length} en total) asignados a ${m.cuentas.length} cuentas.`);
}

// ════════════════════════════════════════════════════════════════════════════
// Comando: teardown
// ════════════════════════════════════════════════════════════════════════════
async function cmdTeardown() {
  if (!SERVICE) {
    console.error("teardown necesita SUPABASE_SERVICE_ROLE_KEY en .env.local");
    process.exit(2);
  }
  const m = leerManifiesto();
  const examIds = m.exams.map((e) => e.id);
  console.log("Borrando datos sintéticos…");
  await svc(`submissions?exam_id=in.(${examIds.join(",")})`, { method: "DELETE" }).catch(() => {});
  await svc(`exam_assignments?exam_id=in.(${examIds.join(",")})`, { method: "DELETE" }).catch(() => {});
  await svc(`questions?exam_id=in.(${examIds.join(",")})`, { method: "DELETE" }).catch(() => {});
  await svc(`exams?id=in.(${examIds.join(",")})`, { method: "DELETE" }).catch(() => {});
  await svc(`course_enrollments?course_id=eq.${m.courseId}`, { method: "DELETE" }).catch(() => {});
  for (const c of m.cuentas) {
    await svc(`user_roles?user_id=eq.${c.userId}`, { method: "DELETE" }).catch(() => {});
    await svc(`exam_assignments?user_id=eq.${c.userId}`, { method: "DELETE" }).catch(() => {});
  }
  await svc(`courses?id=eq.${m.courseId}`, { method: "DELETE" }).catch(() => {});
  let borradas = 0;
  for (const c of m.cuentas) {
    await adminDeleteUser(c.userId).catch((e) => console.warn(`  ${c.email}: ${e.message}`));
    borradas++;
  }
  console.log(`  cuentas borradas: ${borradas}/${m.cuentas.length}`);
  try {
    writeFileSync(MANIFEST, JSON.stringify({ ...m, teardownEn: new Date().toISOString(), cuentas: [] }, null, 2));
  } catch {}
  console.log("✅ teardown completo.");
}

// ════════════════════════════════════════════════════════════════════════════
// Comando: limpiar — borra TODO lo sintético por MARCADOR (no depende del
// manifiesto). Sirve para recuperarse de un setup a medias.
// ════════════════════════════════════════════════════════════════════════════
async function cmdLimpiar() {
  if (!SERVICE) {
    console.error("limpiar necesita SUPABASE_SERVICE_ROLE_KEY en .env.local");
    process.exit(2);
  }
  const cursos = await svc(
    `courses?select=id&tenant_id=eq.${TENANT_DEMO_GLOBAL_CORP}&name=like.${encodeURIComponent(MARCA + "%")}`,
  );
  for (const c of cursos) {
    const exams = await svc(`exams?select=id&course_id=eq.${c.id}`);
    const examIds = exams.map((e) => e.id);
    if (examIds.length) {
      await svc(`submissions?exam_id=in.(${examIds.join(",")})`, { method: "DELETE" }).catch(() => {});
      await svc(`exam_assignments?exam_id=in.(${examIds.join(",")})`, { method: "DELETE" }).catch(() => {});
      await svc(`questions?exam_id=in.(${examIds.join(",")})`, { method: "DELETE" }).catch(() => {});
      await svc(`exams?id=in.(${examIds.join(",")})`, { method: "DELETE" }).catch(() => {});
    }
    await svc(`course_enrollments?course_id=eq.${c.id}`, { method: "DELETE" }).catch(() => {});
    await svc(`courses?id=eq.${c.id}`, { method: "DELETE" }).catch(() => {});
    console.log(`  curso ${c.id} limpiado (${examIds.length} exámenes)`);
  }
  // Cuentas sintéticas por correo.
  const perfiles = await svc(
    `profiles?select=id&institutional_email=like.${encodeURIComponent("loadtest-%@examlab.test")}`,
  );
  for (const p of perfiles) {
    await svc(`user_roles?user_id=eq.${p.id}`, { method: "DELETE" }).catch(() => {});
    await svc(`exam_assignments?user_id=eq.${p.id}`, { method: "DELETE" }).catch(() => {});
    await adminDeleteUser(p.id).catch(() => {});
  }
  console.log(`  cuentas sintéticas borradas: ${perfiles.length}`);
  console.log("✅ limpiar completo.");
}

// ── main ────────────────────────────────────────────────────────────────────
const cmd = process.argv[2];
const comandos = {
  status: cmdStatus,
  setup: cmdSetup,
  ampliar: cmdAmpliar,
  smoke: cmdSmoke,
  run: cmdRun,
  ramp: cmdRamp,
  teardown: cmdTeardown,
  limpiar: cmdLimpiar,
};
if (!comandos[cmd]) {
  console.log("Comandos: status | setup | ampliar | smoke | run | ramp | teardown | limpiar");
  console.log("Ej.:  node scripts/exam-load-test.mjs status");
  process.exit(1);
}
comandos[cmd]().then(
  () => process.exit(0),
  (e) => {
    console.error("ERROR:", e?.message ?? e);
    process.exit(1);
  },
);
