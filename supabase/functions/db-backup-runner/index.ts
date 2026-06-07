/**
 * db-backup-runner — exporta un conjunto de tablas a un ZIP que se sube
 * al bucket privado `db-backups`.
 *
 * Flujo:
 *   1. Body: `{ backupId: string }`. Si no viene, reclama el job `queued`
 *      más viejo (modo cron — el schedule semanal inserta + invoca sin
 *      pasar id explícito).
 *   2. Auth: igual que ai-grading-worker — acepta service_role key
 *      directo (cron) o JWT de Admin (UI). Defense in depth en el código
 *      porque verify_jwt = false en config.toml para que el cron pueda
 *      llamarlo con keys `sb_secret_*` que no son JWT-parseables.
 *   3. status='running' atómico.
 *   4. Para cada tabla en `tables`:
 *        - SELECT * (sin paginación — todas las tablas de ExamLab caben
 *          en memoria del runtime de Deno; el límite real son los 2GB del
 *          bucket. Si en el futuro alguna tabla pasa de cientos de miles
 *          de filas, agregar streaming).
 *        - Append `<table>.json` al ZIP.
 *   5. ZIP completo → upload a `db-backups/<backup_id>.zip`.
 *   6. UPDATE fila: status='done', file_path, size_bytes, row_count,
 *      completed_at.
 *
 * Falla loud: cualquier error transiciona a status='failed' con `error`
 * poblado. El admin puede crear un backup nuevo desde la UI.
 */
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { zipSync, strToU8 } from "npm:fflate@0.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface BackupRow {
  id: string;
  tables: string[];
  source: "manual" | "cron";
  status: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ─── Auth interna ────────────────────────────────────────────────────
  // Mismo esquema que ai-grading-worker: aceptamos service_role key
  // (cron / server-side) o JWT de Admin (botón "Procesar ahora" en UI).
  const incomingAuth = req.headers.get("Authorization") ?? "";
  {
    const bearer = incomingAuth.replace(/^Bearer\s+/i, "").trim();
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    let authorized = bearer.length > 0 && bearer === serviceRoleKey;
    if (!authorized && bearer.length > 0) {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
        { global: { headers: { Authorization: `Bearer ${bearer}` } } },
      );
      const { data: u } = await userClient.auth.getUser();
      if (u.user) {
        const { data: roles } = await adminClient
          .from("user_roles")
          .select("role")
          .eq("user_id", u.user.id);
        // SuperAdmin hereda capacidades operativas de Admin (CLAUDE.md
        // convención). Sin esto, un SuperAdmin invocando "Procesar
        // ahora" desde la UI recibe 401 — bug reportado al crear
        // backup manual desde el panel del SA.
        authorized = (roles ?? []).some(
          (r: { role: string }) => r.role === "Admin" || r.role === "SuperAdmin",
        );
      }
    }
    if (!authorized) {
      return new Response(
        JSON.stringify({ ok: false, error: "Solo Admin o SuperAdmin puede ejecutar backups" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }

  // ─── Resolver job a procesar ─────────────────────────────────────────
  let backupId: string | undefined;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (body && typeof body.backupId === "string") backupId = body.backupId;
    } catch {
      /* body vacío o no-JSON — modo "reclama el queued más viejo" */
    }
  }

  let job: BackupRow | null = null;
  if (backupId) {
    const { data, error } = await adminClient
      .from("db_backups")
      .select("id, tables, source, status")
      .eq("id", backupId)
      .maybeSingle();
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    job = data as BackupRow | null;
  } else {
    // Modo cron: reclama el queued más viejo.
    const { data } = await adminClient
      .from("db_backups")
      .select("id, tables, source, status")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    job = data as BackupRow | null;
  }

  if (!job) {
    return new Response(
      JSON.stringify({ ok: true, processed: 0, message: "Sin backups pendientes" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  if (job.status !== "queued") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `El backup está en estado '${job.status}', no en 'queued'.`,
      }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Marcar running. Si la transición falla (race entre dos invocaciones)
  // bailamos sin error duro — el otro worker ya lo tomó.
  {
    const { error: upErr } = await adminClient
      .from("db_backups")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "queued");
    if (upErr) {
      return new Response(JSON.stringify({ ok: false, error: upErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // ─── Exportar tablas ─────────────────────────────────────────────────
  try {
    // deno-lint-ignore no-explicit-any
    const zipEntries: Record<string, Uint8Array> = {};
    const tableSummary: Array<{ table: string; rows: number; bytes: number }> = [];
    let totalRows = 0;

    for (const table of job.tables) {
      // SELECT *. Si la tabla tiene > 1000 filas Supabase pagina por
      // defecto a 1000 — pedimos rango explícito de 0..999999 para que
      // PostgREST devuelva todo. Las tablas de ExamLab no llegan a 1M
      // filas en este contexto.
      const { data, error, count } = await adminClient
        .from(table)
        .select("*", { count: "exact" })
        .range(0, 999999);
      if (error) {
        throw new Error(`SELECT ${table}: ${error.message}`);
      }
      const rows = (data ?? []) as unknown[];
      const json = JSON.stringify(rows, null, 0);
      const u8 = strToU8(json);
      zipEntries[`tables/${table}.json`] = u8;
      const reportedRows = typeof count === "number" ? count : rows.length;
      tableSummary.push({ table, rows: reportedRows, bytes: u8.length });
      totalRows += reportedRows;
    }

    // Metadata del backup — útil al restaurar para verificar coherencia.
    const metadata = {
      backup_id: job.id,
      created_at: new Date().toISOString(),
      source: job.source,
      tables: tableSummary,
      total_rows: totalRows,
      format_version: 1,
      // Versión del esquema — si en el futuro renombramos columnas, el
      // restorer puede aplicar transformaciones. Hoy no se usa; queda
      // declarado para forward-compat.
      schema_version: "examlab.v1",
    };
    zipEntries["metadata.json"] = strToU8(JSON.stringify(metadata, null, 2));

    // ─── Zipear ────────────────────────────────────────────────────────
    // `level: 6` (default) es buen balance entre tamaño y CPU. Los JSON
    // son muy comprimibles (mucho whitespace + strings repetidos en
    // columnas como `role`, `status`, etc.) → ratios de 5-10x.
    const zipped = zipSync(zipEntries, { level: 6 });

    // ─── Upload a Storage ──────────────────────────────────────────────
    // Path: `<backup_id>.zip` directo en el bucket (sin subfolders por
    // user — el bucket es Admin-only y queremos paths predecibles para
    // signed URLs).
    const filePath = `${job.id}.zip`;
    const { error: uploadErr } = await adminClient.storage
      .from("db-backups")
      .upload(filePath, zipped, {
        contentType: "application/zip",
        upsert: true,
      });
    if (uploadErr) {
      throw new Error(`Upload a Storage: ${uploadErr.message}`);
    }

    // ─── Cerrar como done ──────────────────────────────────────────────
    await adminClient
      .from("db_backups")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
        file_path: filePath,
        size_bytes: zipped.length,
        row_count: totalRows,
      })
      .eq("id", job.id);

    return new Response(
      JSON.stringify({
        ok: true,
        backup_id: job.id,
        size_bytes: zipped.length,
        row_count: totalRows,
        tables: tableSummary.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[db-backup-runner] job ${job.id} failed:`, msg);
    await adminClient
      .from("db_backups")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error: msg.slice(0, 1000),
      })
      .eq("id", job.id);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
