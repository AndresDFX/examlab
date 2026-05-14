import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Activity,
  Database,
  Bot,
  Bell,
  HardDrive,
  KeyRound,
  Shield,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Puzzle,
  Zap,
  Clock,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";

/**
 * SystemDiagnosticsPanel — dashboard de admin para verificar que todos
 * los componentes externos del backend estan conectados y funcionando.
 *
 * Hace un fan-out de checks en paralelo:
 *  - Edge function `health-check` (devuelve runtime info + secrets check
 *    + provider de IA activo + push_config).
 *  - DB connectivity (query simple via PostgREST).
 *  - Auth del usuario actual (desde useAuth).
 *  - Storage (lista buckets disponibles).
 *
 * Cada chequeo es independiente y muestra su propio estado (verde/rojo).
 * Un solo boton "Refrescar diagnostico" re-corre todos en paralelo.
 */

type HealthCheckResponse = {
  status: string;
  message: string;
  timestamp: string;
  runtime: { deno_version: string; region: string };
  ai: {
    active_provider: string | null;
    active_model: string | null;
    updated_at: string | null;
    required_secret: string | null;
    required_secret_missing: boolean;
  };
  push: {
    send_push_url: string | null;
    points_to_current_project: boolean | null;
  };
  storage: {
    buckets: Array<{ id: string; public: boolean; file_size_limit: number | null }>;
  };
  /** Extensiones de Postgres instaladas. `null` si el edge function
   *  todavía no tiene el campo (versión vieja) o si la RPC no existe. */
  db?: {
    extensions: Array<{ name: string; version: string; schema: string }> | null;
  };
  /** Stats de cada edge function conocida. `null` si el edge function
   *  todavía no tiene el campo o la RPC falló. */
  edge_functions?: Array<{
    function_name: string;
    last_invoked_at: string | null;
    last_action: string | null;
    last_severity: string | null;
  }> | null;
  /** pg_cron jobs registrados. `null` si pg_cron no está instalado o
   *  la migración 20260523000007 no se aplicó. */
  cron_jobs?: Array<{
    jobname: string;
    schedule: string;
    command: string;
    active: boolean;
    last_run_at: string | null;
    last_status: string | null;
    last_message: string | null;
  }> | null;
  secrets: Array<{ name: string; present: boolean; expected_prefix?: string }>;
};

type CheckResult<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: T; latencyMs: number }
  | { state: "error"; message: string; latencyMs: number };

async function timed<T>(fn: () => Promise<T>): Promise<{ data: T; latencyMs: number }> {
  const start = performance.now();
  const data = await fn();
  return { data, latencyMs: Math.round(performance.now() - start) };
}

// ─── Card generico de estado ───────────────────────────────────
function StatusCard({
  title,
  description,
  icon,
  state,
  children,
}: {
  title: string;
  description?: string;
  icon: React.ReactNode;
  state: "idle" | "loading" | "ok" | "warning" | "error";
  children?: React.ReactNode;
}) {
  const borderClass =
    state === "ok"
      ? "border-emerald-500/30"
      : state === "warning"
        ? "border-amber-500/30"
        : state === "error"
          ? "border-destructive/40"
          : "border-border";
  return (
    <Card className={borderClass}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            {icon}
            {title}
          </span>
          <StatusBadge state={state} />
        </CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">{children}</CardContent>
    </Card>
  );
}

function StatusBadge({ state }: { state: "idle" | "loading" | "ok" | "warning" | "error" }) {
  if (state === "loading") return <Spinner size="sm" />;
  if (state === "ok")
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4" /> OK
      </span>
    );
  if (state === "warning")
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4" /> Aviso
      </span>
    );
  if (state === "error")
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <XCircle className="h-4 w-4" /> Falla
      </span>
    );
  return <span className="text-xs text-muted-foreground">—</span>;
}

// ─── Helpers de presentacion ────────────────────────────────────
function MutedLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="min-w-[7rem] text-xs text-muted-foreground">{label}</span>
      <span className="break-all font-mono text-xs">{value}</span>
    </div>
  );
}

// ─── Componente principal ───────────────────────────────────────
export function SystemDiagnosticsPanel() {
  const { user, profile, roles } = useAuth();

  const [hc, setHc] = useState<CheckResult<HealthCheckResponse>>({ state: "idle" });
  const [db, setDb] = useState<CheckResult<{ courses: number }>>({ state: "idle" });

  async function runEdgeFunction() {
    setHc({ state: "loading" });
    try {
      const { data, latencyMs } = await timed(async () => {
        const res = await supabase.functions.invoke<HealthCheckResponse>("health-check", {
          body: { source: "admin-dashboard", ts: new Date().toISOString() },
        });
        if (res.error) throw new Error(res.error.message);
        if (!res.data) throw new Error("Sin respuesta");
        return res.data;
      });
      setHc({ state: "ok", data, latencyMs });

      // Cuando el response llega OK pero detecta problemas internos
      // (secret IA faltante, push apuntando al Supabase viejo, etc.),
      // los registramos al audit como warnings. Así el admin puede
      // revisar histórico en /app/admin/audit-logs sin tener que estar
      // refrescando este panel.
      const warnings: string[] = [];
      if (data.ai?.required_secret_missing && data.ai.required_secret) {
        warnings.push(`AI secret missing: ${data.ai.required_secret}`);
      }
      if (data.push && data.push.send_push_url && data.push.points_to_current_project === false) {
        warnings.push(`push_config apunta a otro proyecto: ${data.push.send_push_url}`);
      }
      if (data.storage && data.storage.buckets.length === 0) {
        warnings.push("Storage sin buckets configurados");
      }
      if (warnings.length > 0) {
        void logEvent({
          action: "system.diagnostic.warnings_detected",
          category: "system",
          severity: "warning",
          metadata: { warnings, latencyMs },
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setHc({ state: "error", message, latencyMs: 0 });
      void logEvent({
        action: "system.diagnostic.edge_function_failed",
        category: "system",
        severity: "error",
        metadata: { check: "health-check", error: message },
      });
    }
  }

  async function runDb() {
    setDb({ state: "loading" });
    try {
      const { data, latencyMs } = await timed(async () => {
        const { count, error } = await supabase
          .from("courses")
          .select("*", { count: "exact", head: true });
        if (error) throw error;
        return { courses: count ?? 0 };
      });
      setDb({ state: "ok", data, latencyMs });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setDb({ state: "error", message, latencyMs: 0 });
      void logEvent({
        action: "system.diagnostic.db_failed",
        category: "system",
        severity: "error",
        metadata: { check: "courses-count", error: message },
      });
    }
  }

  async function runAll() {
    // El estado de storage viene EMBEBIDO en la respuesta del health-check
    // (que corre con service_role y ve los buckets reales). No corremos
    // listBuckets() desde el cliente porque RLS lo bloquea y devolveria 0.
    await Promise.all([runEdgeFunction(), runDb()]);
  }

  const allLoading = hc.state === "loading" || db.state === "loading";

  // ─── Computo de estados derivados para los cards ──────────────
  // Lecturas defensivas — la edge function puede devolver una version
  // vieja (sin storage/ai/push/secrets) si el deploy no se actualizó.
  // Sin esto el render explota con "Cannot read properties of undefined".
  const hcData = hc.state === "ok" ? hc.data : null;
  const ai = hcData?.ai ?? null;
  const push = hcData?.push ?? null;
  const storage = hcData?.storage ?? null;
  const secrets = hcData?.secrets ?? [];
  const extensions = hcData?.db?.extensions ?? null;
  const edgeFunctions = hcData?.edge_functions ?? null;
  const cronJobs = hcData?.cron_jobs ?? null;
  // Extensiones críticas que la app necesita. Si falta cualquiera, el
  // card pasa a 'warning' para que el admin lo vea de inmediato.
  const REQUIRED_EXTENSIONS = ["pg_net", "pgcrypto", "uuid-ossp"] as const;
  const missingExtensions = extensions
    ? REQUIRED_EXTENSIONS.filter((req) => !extensions.some((e) => e.name === req))
    : [];
  const extensionsState: "idle" | "ok" | "warning" | "error" = extensions
    ? missingExtensions.length > 0
      ? "warning"
      : "ok"
    : hc.state === "error"
      ? "error"
      : "idle";
  const edgeFunctionsState: "idle" | "ok" | "warning" | "error" = edgeFunctions ? "ok" : "idle";
  // Estado del card cron: warning si hay jobs inactivos (active=false)
  // o jobs con última ejecución fallida. ok si todos están sanos. idle
  // si la RPC no devolvió data (pg_cron no instalado o migración pendiente).
  const cronInactive = cronJobs?.filter((j) => !j.active) ?? [];
  const cronFailed =
    cronJobs?.filter(
      (j) => j.last_status && !["succeeded", "running", "starting"].includes(j.last_status),
    ) ?? [];
  const cronJobsState: "idle" | "ok" | "warning" | "error" = !cronJobs
    ? "idle"
    : cronJobs.length === 0
      ? "warning"
      : cronInactive.length > 0 || cronFailed.length > 0
        ? "warning"
        : "ok";

  const aiState: "idle" | "ok" | "warning" | "error" = ai
    ? ai.active_provider
      ? ai.required_secret_missing
        ? "error"
        : "ok"
      : "warning"
    : hc.state === "error"
      ? "error"
      : "idle";

  const pushState: "idle" | "ok" | "warning" | "error" = push
    ? push.send_push_url
      ? push.points_to_current_project === false
        ? "warning"
        : "ok"
      : "warning"
    : hc.state === "error"
      ? "error"
      : "idle";

  const secretsState: "idle" | "ok" | "warning" | "error" = hcData ? "ok" : "idle";

  const storageState: "idle" | "ok" | "warning" | "error" = storage
    ? storage.buckets.length > 0
      ? "ok"
      : "warning"
    : hc.state === "error"
      ? "error"
      : "idle";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Estos chequeos consultan los servicios externos en vivo. Si todo aparece en verde, la
          plataforma puede operar normalmente.
        </p>
        <Button onClick={runAll} disabled={allLoading}>
          {allLoading ? (
            <>
              <Spinner size="sm" /> Diagnosticando…
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4" /> Refrescar diagnóstico
            </>
          )}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Edge function */}
        <StatusCard
          title="Edge functions"
          description="Llamada al endpoint health-check del Supabase configurado."
          icon={<Activity className="h-4 w-4 text-cyan-500" />}
          state={hc.state === "ok" ? "ok" : hc.state}
        >
          {hc.state === "idle" && (
            <p className="text-muted-foreground">Click en "Refrescar" para iniciar.</p>
          )}
          {hc.state === "ok" && (
            <>
              <MutedLine label="Latencia" value={`${hc.latencyMs} ms`} />
              <MutedLine label="Deno" value={hcData?.runtime?.deno_version ?? "—"} />
              <MutedLine label="Región" value={hcData?.runtime?.region ?? "—"} />
              <MutedLine label="Timestamp" value={hcData?.timestamp ?? "—"} />
            </>
          )}
          {hc.state === "error" && (
            <p className="text-xs text-destructive">{hc.message}</p>
          )}
        </StatusCard>

        {/* Database */}
        <StatusCard
          title="Base de datos"
          description="Query via PostgREST con el JWT del usuario actual."
          icon={<Database className="h-4 w-4 text-emerald-500" />}
          state={db.state === "ok" ? "ok" : db.state}
        >
          {db.state === "idle" && (
            <p className="text-muted-foreground">Click en "Refrescar" para iniciar.</p>
          )}
          {db.state === "ok" && (
            <>
              <MutedLine label="Latencia" value={`${db.latencyMs} ms`} />
              <MutedLine label="Cursos" value={db.data.courses} />
            </>
          )}
          {db.state === "error" && (
            <p className="text-xs text-destructive">{db.message}</p>
          )}
        </StatusCard>

        {/* Auth */}
        <StatusCard
          title="Autenticación"
          description="Sesión actual del usuario."
          icon={<Shield className="h-4 w-4 text-indigo-500" />}
          state={user ? "ok" : "warning"}
        >
          {user ? (
            <>
              <MutedLine label="User ID" value={user.id} />
              <MutedLine label="Email" value={user.email ?? "—"} />
              <MutedLine
                label="Nombre"
                value={profile?.full_name ?? "—"}
              />
              <MutedLine
                label="Roles"
                value={
                  roles.length > 0
                    ? roles.map((r) => (
                        <Badge key={r} variant="outline" className="mr-1 text-xs">
                          {r}
                        </Badge>
                      ))
                    : "—"
                }
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No hay sesión activa.</p>
          )}
        </StatusCard>

        {/* Storage */}
        <StatusCard
          title="Storage"
          description="Buckets reportados por el edge function (con service_role)."
          icon={<HardDrive className="h-4 w-4 text-fuchsia-500" />}
          state={storageState}
        >
          {!storage ? (
            <p className="text-muted-foreground">
              {hc.state === "ok"
                ? "La edge function no devolvió info de Storage (versión vieja desplegada)."
                : "Refresca el diagnóstico para ver el estado."}
            </p>
          ) : storage.buckets.length === 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              No hay buckets en el proyecto. Si esperabas verlos, revisa que el restore haya
              creado workshop-files, project-files y generated-contents.
            </p>
          ) : (
            <>
              <MutedLine label="Buckets" value={storage.buckets.length} />
              <div className="flex flex-wrap gap-1 pt-1">
                {storage.buckets.map((b) => (
                  <Badge key={b.id} variant="outline" className="text-xs">
                    {b.id}
                    {b.public && (
                      <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                        público
                      </span>
                    )}
                  </Badge>
                ))}
              </div>
            </>
          )}
        </StatusCard>

        {/* AI provider */}
        <StatusCard
          title="Provider de IA"
          description="Configuración en ai_model_settings + presencia del secret correspondiente."
          icon={<Bot className="h-4 w-4 text-violet-500" />}
          state={aiState}
        >
          {!ai ? (
            <p className="text-muted-foreground">
              {hc.state === "ok"
                ? "La edge function no devolvió info de IA (versión vieja desplegada)."
                : "Refresca el diagnóstico para ver el estado."}
            </p>
          ) : !ai.active_provider ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              No hay provider activo en ai_model_settings.
            </p>
          ) : (
            <>
              <MutedLine label="Provider" value={ai.active_provider} />
              <MutedLine label="Modelo" value={ai.active_model ?? "—"} />
              <MutedLine
                label="Secret"
                value={
                  <span>
                    {ai.required_secret}{" "}
                    {ai.required_secret_missing ? (
                      <span className="text-destructive">(faltante)</span>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">(presente)</span>
                    )}
                  </span>
                }
              />
              {ai.required_secret_missing && (
                <p className="pt-1 text-xs text-destructive">
                  Falta el secret {ai.required_secret} en Edge Function Secrets. Las llamadas
                  de IA van a fallar hasta que lo configures.
                </p>
              )}
            </>
          )}
        </StatusCard>

        {/* Push notifications */}
        <StatusCard
          title="Push notifications"
          description="URL del trigger y secret compartido (push_config)."
          icon={<Bell className="h-4 w-4 text-orange-500" />}
          state={pushState}
        >
          {!push ? (
            <p className="text-muted-foreground">
              {hc.state === "ok"
                ? "La edge function no devolvió info de push (versión vieja desplegada)."
                : "Refresca el diagnóstico para ver el estado."}
            </p>
          ) : !push.send_push_url ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              push_config.send_push_url está vacío.
            </p>
          ) : (
            <>
              <MutedLine label="URL" value={push.send_push_url} />
              <MutedLine
                label="Apunta a este proyecto"
                value={
                  push.points_to_current_project === false ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      NO — apunta a otro Supabase
                    </span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400">Sí</span>
                  )
                }
              />
              {push.points_to_current_project === false && (
                <p className="pt-1 text-xs text-amber-600 dark:text-amber-400">
                  Actualiza public.push_config.send_push_url al endpoint del proyecto actual.
                </p>
              )}
            </>
          )}
        </StatusCard>

        {/* Secrets de Edge Functions */}
        <StatusCard
          title="Edge Function Secrets"
          description="Presencia de cada secret crítico (NO se exponen los valores)."
          icon={<KeyRound className="h-4 w-4 text-amber-500" />}
          state={secretsState}
        >
          {!hcData ? (
            <p className="text-muted-foreground">Refresca el diagnóstico para ver el estado.</p>
          ) : secrets.length === 0 ? (
            <p className="text-muted-foreground">
              La edge function no devolvió info de secrets (versión vieja desplegada).
            </p>
          ) : (
            <div className="space-y-1">
              {secrets.map((s) => (
                <div key={s.name} className="flex items-center justify-between text-xs">
                  <span className="font-mono">{s.name}</span>
                  {s.present ? (
                    <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      presente
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <XCircle className="h-3 w-3" />
                      ausente
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </StatusCard>

        {/* Extensiones de Postgres */}
        <StatusCard
          title="Extensiones de DB"
          description="Extensiones de Postgres instaladas en el proyecto."
          icon={<Puzzle className="h-4 w-4 text-teal-500" />}
          state={extensionsState}
        >
          {!extensions ? (
            <p className="text-muted-foreground">
              {hc.state === "ok"
                ? "La edge function no devolvió info de extensiones (migración 20260523000004 no aplicada o RPC fallida)."
                : "Refresca el diagnóstico para ver el estado."}
            </p>
          ) : extensions.length === 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Sin extensiones instaladas — esto es muy raro.
            </p>
          ) : (
            <>
              <MutedLine label="Total" value={extensions.length} />
              {missingExtensions.length > 0 && (
                <p className="pt-1 text-xs text-amber-600 dark:text-amber-400">
                  Faltantes críticas: <span className="font-mono">{missingExtensions.join(", ")}</span>
                </p>
              )}
              <div className="max-h-44 overflow-y-auto pt-2 -mr-2 pr-2 space-y-1">
                {extensions.map((e) => (
                  <div
                    key={`${e.schema}.${e.name}`}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="font-mono truncate" title={`${e.schema}.${e.name}`}>
                      {e.name}
                    </span>
                    <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
                      v{e.version}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </StatusCard>

        {/* Edge functions + última invocación */}
        <StatusCard
          title="Edge functions registradas"
          description="Última invocación detectada en audit_logs por función."
          icon={<Zap className="h-4 w-4 text-yellow-500" />}
          state={edgeFunctionsState}
        >
          {!edgeFunctions ? (
            <p className="text-muted-foreground">
              {hc.state === "ok"
                ? "La edge function no devolvió info de funciones (migración 20260523000004 no aplicada)."
                : "Refresca el diagnóstico para ver el estado."}
            </p>
          ) : edgeFunctions.length === 0 ? (
            <p className="text-muted-foreground">Sin funciones registradas.</p>
          ) : (
            <div className="space-y-2">
              {edgeFunctions.map((fn) => {
                const severityColor =
                  fn.last_severity === "error"
                    ? "text-destructive"
                    : fn.last_severity === "warning"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-emerald-600 dark:text-emerald-400";
                return (
                  <div
                    key={fn.function_name}
                    className="flex items-start justify-between gap-2 text-xs border-b last:border-b-0 pb-1.5 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="font-mono truncate" title={fn.function_name}>
                        {fn.function_name}
                      </div>
                      {fn.last_action && (
                        <div className={`text-[10px] ${severityColor}`}>{fn.last_action}</div>
                      )}
                    </div>
                    <span className="text-muted-foreground tabular-nums shrink-0 text-right">
                      {fn.last_invoked_at ? (
                        formatDateTime(fn.last_invoked_at)
                      ) : (
                        <span className="italic">sin registros</span>
                      )}
                    </span>
                  </div>
                );
              })}
              <p className="pt-1 text-[10px] text-muted-foreground">
                "Sin registros" significa que la función existe pero aún no ha sido invocada (o no
                logea a audit_logs todavía).
              </p>
            </div>
          )}
        </StatusCard>

        {/* Cron jobs (pg_cron) */}
        <StatusCard
          title="Tareas programadas"
          description="pg_cron — jobs activos + última ejecución."
          icon={<Clock className="h-4 w-4 text-purple-500" />}
          state={cronJobsState}
        >
          {!cronJobs ? (
            <p className="text-muted-foreground">
              {hc.state === "ok"
                ? "pg_cron no está instalado o la migración 20260523000007 no se aplicó."
                : "Refresca el diagnóstico para ver el estado."}
            </p>
          ) : cronJobs.length === 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Sin cron jobs registrados. Programa los recordatorios desde el SQL Editor (ver
              migraciones 20260523000006 y 20260523000007).
            </p>
          ) : (
            <div className="space-y-2">
              {cronJobs.map((j) => {
                const statusColor =
                  j.last_status === "succeeded"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : j.last_status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground";
                return (
                  <div
                    key={j.jobname}
                    className="text-xs border-b last:border-b-0 pb-1.5 last:pb-0 space-y-0.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono truncate" title={j.jobname}>
                          {j.jobname}
                        </span>
                        {!j.active && (
                          <Badge variant="outline" className="text-[9px] py-0 h-3.5">
                            inactivo
                          </Badge>
                        )}
                      </div>
                      <span className="font-mono text-muted-foreground tabular-nums shrink-0">
                        {j.schedule}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className={statusColor}>{j.last_status ?? "sin ejecuciones aún"}</span>
                      <span className="text-muted-foreground tabular-nums shrink-0">
                        {j.last_run_at ? formatDateTime(j.last_run_at) : "—"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </StatusCard>
      </div>
    </div>
  );
}
