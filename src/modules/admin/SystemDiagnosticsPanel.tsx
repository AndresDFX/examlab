import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { logEvent } from "@/shared/lib/audit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Activity,
  Database,
  Bot,
  HardDrive,
  KeyRound,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Puzzle,
  Zap,
  Clock,
  Bell,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";
import { extractEdgeError } from "@/shared/lib/edge-error";

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
  /** Uso de espacio + cuotas. `null` si la migración 20260523000010
   *  no se aplicó. */
  storage_usage?: {
    db_size_bytes: number;
    objects_size_bytes: number;
    objects_count: number;
    buckets_count: number;
    db_quota_mb: number;
    storage_quota_mb: number;
    alert_threshold_pct: number;
  } | null;
  secrets: Array<{ name: string; present: boolean; expected_prefix?: string }>;
};

/** Convierte bytes a MB con 1 decimal, sin saturar el display de
 *  números pequeños (devuelve 0.0 si bytes < 1MB). */
function bytesToMB(b: number): number {
  return Math.round((b / (1024 * 1024)) * 10) / 10;
}

/** Descripción humana de cada edge function — explica qué hace en una
 *  línea para que el admin no tenga que leer el código. Si una función
 *  nueva no está aquí, el panel cae al fallback "(sin descripción)". */
const EDGE_FUNCTION_DESCRIPTIONS: Record<string, string> = {
  "admin-update-password":
    "Admin restablece la contraseña de cualquier usuario sin necesidad de su email actual.",
  "ai-generate-questions":
    "Genera preguntas de examen/taller/proyecto a partir del tema o descripción del docente.",
  "ai-grade-submission":
    "Califica entregas (examen, taller, proyecto) con IA. Punto de entrada único para grading sync y batch.",
  "ai-grading-worker":
    "Worker invocado por pg_cron hourly que drena `ai_grading_queue` y aplica resultados.",
  "broadcast-course-message":
    "Envío masivo de mensaje + notificación + email a los matriculados de un curso.",
  "bulk-import-users": "Importa usuarios desde CSV creándolos en auth.users + profiles + roles.",
  calendar: "Conecta Google/Outlook con el docente y sincroniza sesiones del curso como eventos.",
  "calendar-ics":
    "Genera el ICS de los eventos del docente para suscribirse desde calendarios externos.",
  "calendar-oauth-callback":
    "Recibe el código OAuth de Google/Outlook al final del flujo de conexión.",
  "confirm-password-reset":
    "Cierra el flujo de reset de contraseña: valida token y actualiza la credencial.",
  "detect-plagiarism": "Compara entregas pares con IA para reportar pares sospechosos de copia.",
  "evaluate-exam-time":
    "Estima si la duración asignada a un examen es razonable dadas sus preguntas.",
  "execute-code":
    "Compila y ejecuta código por consola via el provider activo (OnlineCompiler/JDoodle/AWS).",
  "execute-java-gui-screenshot":
    "Compila Java Swing/AWT en Xvfb y devuelve PNG de la ventana. Usa el provider `aws_screenshot`.",
  "generate-contents": "Genera materiales del módulo Contenidos (PPTX/MD) con IA según modalidad.",
  "health-check": "Diagnóstico de la infraestructura: alimenta este panel.",
  "manage-edge-secrets": "CRUD de Edge Function Secrets desde el panel admin (set/unset/list).",
  "request-password-reset": "Genera y envía un link de reset al email institucional del usuario.",
  "retry-failed-ai-gradings":
    "Cron job (cada 30 min) que reintenta calificaciones IA que fallaron por red/rate-limit.",
  "send-email":
    "Despacho centralizado de correos al SMTP configurado (un solo punto de trazabilidad).",
  "send-push": "Push notifications a service workers registrados (web/PWA).",
  "student-calendar-ics":
    "ICS público para que el estudiante se suscriba al calendario del curso desde su app.",
  "tutor-chat":
    "Endpoint del Tutor IA por curso: arma el prompt con `course_content_topics` y orquesta la conversación.",
};

/** Descripción humana de cada cron job programado en pg_cron — explica
 *  para qué corre y con qué frecuencia, sin que el admin tenga que ir
 *  al SQL editor. */
const CRON_JOB_DESCRIPTIONS: Record<string, string> = {
  "ai-grading-worker-hourly":
    "Cada hora (minuto :05) invoca `ai-grading-worker` para drenar la cola de calificación IA pendiente.",
  "examlab-daily-notifs":
    "Diario — recuerda al estudiante exámenes/talleres próximos y al docente entregas pendientes.",
  "admin-storage-threshold":
    "Cada 6 horas — revisa uso de DB + Storage vs cuota y notifica al admin si pasa el umbral configurado.",
  "audit-logs-purge":
    "Mensual (día 1, 03:00) — purga `audit_logs` viejos según la política de retención por severidad (Admin → Configuración → Auditoría).",
  "email-alert-threshold":
    "Cada 30 minutos — si los correos enviados en 24h superan el umbral, alerta a admins (cooldown configurable).",
  "exam-reminders-1h":
    "Cada 10 minutos — notifica al estudiante 1h antes de que abra un examen ya programado, según `exams.start_time`.",
  "exam-window-opens":
    "Cada 15 minutos — cambia el estado de exámenes con ventana abierta a `disponible` para que el estudiante pueda iniciar.",
  "project-due-24h":
    "Cada 2 horas — notifica al estudiante con 24h restantes para entregar un proyecto.",
  "retry-failed-ai-gradings":
    "Cada 30 minutos — reintenta calificaciones IA que fallaron por rate-limit / red transitorio. Tras N intentos las marca como `failed` definitivo.",
  "teacher-daily-summary":
    "Diario (04:00 hora del servidor) — envía al docente un resumen del día anterior: entregas pendientes, entregas calificables, alertas.",
  "teacher-exam-prep-1h":
    "Cada 10 minutos — notifica al docente 1h antes de que arranque un examen para que revise el monitor.",
  "workshop-due-24h":
    "Cada 2 horas — notifica al estudiante con 24h restantes para entregar un taller.",
};

/** Estado de una métrica de uso según el threshold de alerta:
 *  - "danger" si usado > 100 - threshold (= libre menor que threshold)
 *  - "warning" si usado > 60% pero todavía libre suficiente
 *  - "ok" si libre cómodo */
function usageState(usedPct: number, threshold: number): "ok" | "warning" | "danger" {
  if (usedPct >= 100 - threshold) return "danger";
  if (usedPct >= 60) return "warning";
  return "ok";
}

/** Barra de progreso + labels "X MB usado / Y MB libre / Z MB total".
 *  Reusable para DB + Storage en el panel. Color de la barra según
 *  usageState. */
function UsageBar({
  usedMB,
  totalMB,
  usedPct,
  state,
  thresholdPct,
}: {
  usedMB: number;
  totalMB: number;
  usedPct: number;
  state: "ok" | "warning" | "danger";
  thresholdPct: number;
}) {
  const freeMB = Math.max(0, Math.round((totalMB - usedMB) * 10) / 10);
  const barColor =
    state === "danger" ? "bg-destructive" : state === "warning" ? "bg-amber-500" : "bg-emerald-500";
  const labelColor =
    state === "danger"
      ? "text-destructive"
      : state === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";
  // Clamp visual entre 2% y 100% — 0% se ve como barra vacía rara,
  // 2% mínimo deja claro que hay un poquito de uso.
  const widthPct = Math.min(100, Math.max(2, usedPct));
  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className={`font-medium ${labelColor}`}>{usedPct.toFixed(1)}% usado</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {usedMB.toFixed(1)} MB / {totalMB} MB
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${widthPct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Libre: {freeMB} MB</span>
        {state === "danger" && (
          <span className="text-destructive font-medium">
            Bajo el {thresholdPct}% libre — se generará alerta
          </span>
        )}
      </div>
    </div>
  );
}

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
  const [hc, setHc] = useState<CheckResult<HealthCheckResponse>>({ state: "idle" });
  const [db, setDb] = useState<CheckResult<{ courses: number }>>({ state: "idle" });
  // Suscripciones web push del admin actual — para que el Card "Push" pueda
  // mostrar cuántos devices tiene este user registrados y desde cuándo.
  // RLS limita la SELECT al user_id del caller, así que no se necesitan
  // permisos especiales.
  const [pushSubs, setPushSubs] = useState<
    Array<{ id: string; user_agent: string | null; updated_at: string }>
  >([]);
  const [sendingTestPush, setSendingTestPush] = useState(false);

  /**
   * Inserta una notification de prueba para el admin actual. El trigger
   * `notifications_send_push` dispara la llamada a la edge function, así
   * que probamos el chain completo: notifications INSERT → pg_net →
   * send-push → VAPID → device push service. Si el admin tiene la PWA
   * instalada con permisos, el push debería llegar en segundos.
   *
   * NO llamamos directo a supabase.functions.invoke('send-push', …) porque
   * la edge exige X-Trigger-Secret (que vive en push_config, lock-down
   * via RLS). El camino legítimo desde el cliente es el trigger.
   */
  async function sendTestPush() {
    setSendingTestPush(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        toast.error("No estás autenticado");
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).from("notifications").insert({
        user_id: u.user.id,
        title: "Push de prueba",
        body: "Si ves esto en tu dispositivo, el chain de web push está funcionando.",
        kind: "info",
        link: "/app/admin/system",
      });
      if (error) {
        toast.error(friendlyError(error, "No se pudo encolar la notificación"));
        return;
      }
      toast.success(
        "Notificación encolada. Si tienes la PWA instalada con permisos, debería llegar en segundos.",
      );
      void logEvent({
        action: "system.diagnostic.test_push_sent",
        category: "system",
        severity: "info",
        metadata: { user_id: u.user.id },
      });
      // Re-cargamos las subscriptions por si fue la primera vez.
      void loadPushSubs();
    } finally {
      setSendingTestPush(false);
    }
  }

  async function loadPushSubs() {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("push_subscriptions")
      .select("id, user_agent, updated_at")
      .eq("user_id", u.user.id)
      .order("updated_at", { ascending: false });
    setPushSubs(data ?? []);
  }

  async function runEdgeFunction() {
    setHc({ state: "loading" });
    try {
      const { data, latencyMs } = await timed(async () => {
        const res = await supabase.functions.invoke<HealthCheckResponse>("health-check", {
          body: { source: "admin-dashboard", ts: new Date().toISOString() },
        });
        if (res.error) {
          const detail = await extractEdgeError(res.error, res.data);
          throw new Error(detail || "Error en health-check");
        }
        if (!res.data) throw new Error("Sin respuesta");
        return res.data;
      });
      setHc({ state: "ok", data, latencyMs });

      // Cuando el response llega OK pero detecta problemas internos
      // (secret IA faltante, storage vacío, etc.), los registramos al
      // audit como warnings. Así el admin puede revisar histórico en
      // /app/admin/audit-logs sin tener que estar refrescando este panel.
      const warnings: string[] = [];
      if (data.ai?.required_secret_missing && data.ai.required_secret) {
        warnings.push(`AI secret missing: ${data.ai.required_secret}`);
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
    await Promise.all([runEdgeFunction(), runDb(), loadPushSubs()]);
  }

  const allLoading = hc.state === "loading" || db.state === "loading";

  // ─── Computo de estados derivados para los cards ──────────────
  // Lecturas defensivas — la edge function puede devolver una version
  // vieja (sin storage/ai/push/secrets) si el deploy no se actualizó.
  // Sin esto el render explota con "Cannot read properties of undefined".
  const hcData = hc.state === "ok" ? hc.data : null;
  const ai = hcData?.ai ?? null;
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

  const secretsState: "idle" | "ok" | "warning" | "error" = hcData ? "ok" : "idle";

  const storageUsage = hcData?.storage_usage ?? null;
  // Métricas derivadas del uso. Si no llegó info (migración pendiente),
  // los % quedan en null y los componentes pintan "no disponible".
  const dbUsedMB = storageUsage ? bytesToMB(storageUsage.db_size_bytes) : null;
  const dbUsedPct =
    storageUsage && storageUsage.db_quota_mb > 0
      ? (dbUsedMB! / storageUsage.db_quota_mb) * 100
      : null;
  const storageUsedMB = storageUsage ? bytesToMB(storageUsage.objects_size_bytes) : null;
  const storageUsedPct =
    storageUsage && storageUsage.storage_quota_mb > 0
      ? (storageUsedMB! / storageUsage.storage_quota_mb) * 100
      : null;
  const threshold = storageUsage?.alert_threshold_pct ?? 15;
  const dbUsageState = dbUsedPct != null ? usageState(dbUsedPct, threshold) : null;
  const storageUsageState = storageUsedPct != null ? usageState(storageUsedPct, threshold) : null;

  // El card "Storage" ahora combina la lista de buckets + barra de uso.
  // Estado del card: 'danger' del uso (rojo) gana sobre 'warning' del
  // bucket vacío.
  const storageState: "idle" | "ok" | "warning" | "error" = (() => {
    if (storageUsageState === "danger") return "error";
    if (!storage) return hc.state === "error" ? "error" : "idle";
    if (storage.buckets.length === 0) return "warning";
    if (storageUsageState === "warning") return "warning";
    return "ok";
  })();

  // Card "Base de datos" extendido con uso.
  const dbCardState: "idle" | "ok" | "warning" | "error" = (() => {
    if (db.state === "error") return "error";
    if (dbUsageState === "danger") return "error";
    if (dbUsageState === "warning") return "warning";
    if (db.state === "ok") return "ok";
    return "idle";
  })();

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
          {hc.state === "error" && <p className="text-xs text-destructive">{hc.message}</p>}
        </StatusCard>

        {/* Database — latencia + tamaño + barra de uso vs cuota */}
        <StatusCard
          title="Base de datos"
          description="Tamaño + cuota configurada en system_settings."
          icon={<Database className="h-4 w-4 text-emerald-500" />}
          state={dbCardState}
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
          {db.state === "error" && <p className="text-xs text-destructive">{db.message}</p>}
          {/* Barra de uso. Se muestra cuando llegó info del RPC. */}
          {storageUsage && dbUsedMB != null && dbUsedPct != null && dbUsageState && (
            <UsageBar
              usedMB={dbUsedMB}
              totalMB={storageUsage.db_quota_mb}
              usedPct={dbUsedPct}
              state={dbUsageState}
              thresholdPct={storageUsage.alert_threshold_pct}
            />
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
              No hay buckets en el proyecto. Si esperabas verlos, revisa que el restore haya creado
              workshop-files, project-files y generated-contents.
            </p>
          ) : (
            <>
              <MutedLine label="Buckets" value={storage.buckets.length} />
              {storageUsage && <MutedLine label="Objetos" value={storageUsage.objects_count} />}
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
              {/* Barra de uso del storage (suma de tamaños de objetos
                  contra storage_quota_mb). Color rojo si está por debajo
                  del threshold de espacio libre. */}
              {storageUsage &&
                storageUsedMB != null &&
                storageUsedPct != null &&
                storageUsageState && (
                  <UsageBar
                    usedMB={storageUsedMB}
                    totalMB={storageUsage.storage_quota_mb}
                    usedPct={storageUsedPct}
                    state={storageUsageState}
                    thresholdPct={storageUsage.alert_threshold_pct}
                  />
                )}
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
                  Falta el secret {ai.required_secret} en Edge Function Secrets. Las llamadas de IA
                  van a fallar hasta que lo configures.
                </p>
              )}
            </>
          )}
        </StatusCard>

        {/* Web Push — verificamos los 3 eslabones del chain:
            (1) push_config en DB (URL + secret) — leído desde health-check.
            (2) Secrets VAPID + PUSH_TRIGGER_SECRET en el edge — leídos del
                array de secrets del health-check.
            (3) Suscripciones del admin actual — cuántos devices.
            Más el botón "Push de prueba" para validar end-to-end. */}
        {(() => {
          const pushUrl = hcData?.push?.send_push_url ?? null;
          const pointsOk = hcData?.push?.points_to_current_project ?? null;
          const vapidPub = secrets.find((s) => s.name === "VAPID_PUBLIC_KEY")?.present ?? false;
          const vapidPriv = secrets.find((s) => s.name === "VAPID_PRIVATE_KEY")?.present ?? false;
          const triggerSecret =
            secrets.find((s) => s.name === "PUSH_TRIGGER_SECRET")?.present ?? false;
          const allSecretsOk = vapidPub && vapidPriv && triggerSecret;
          const configOk = !!pushUrl && pointsOk === true;
          const pushState: "idle" | "ok" | "warning" | "error" = !hcData
            ? "idle"
            : !configOk
              ? "error"
              : !allSecretsOk
                ? "error"
                : pushSubs.length === 0
                  ? "warning"
                  : "ok";
          return (
            <StatusCard
              title="Web Push (PWA)"
              description="Chain completo: push_config + secrets VAPID + suscripciones del admin actual."
              icon={<Bell className="h-4 w-4 text-sky-500" />}
              state={pushState}
            >
              {!hcData ? (
                <p className="text-muted-foreground">Refresca el diagnóstico para ver el estado.</p>
              ) : (
                <>
                  {/* push_config */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">push_config.send_push_url</span>
                    {pushUrl ? (
                      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        configurado
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-destructive">
                        <XCircle className="h-3 w-3" />
                        sin configurar
                      </span>
                    )}
                  </div>
                  {pushUrl && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">apunta al proyecto actual</span>
                      {pointsOk ? (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" />
                          sí
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" />
                          no
                        </span>
                      )}
                    </div>
                  )}
                  {/* Secrets VAPID */}
                  {(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "PUSH_TRIGGER_SECRET"] as const).map(
                    (name) => {
                      const present = secrets.find((s) => s.name === name)?.present ?? false;
                      return (
                        <div key={name} className="flex items-center justify-between text-xs">
                          <span className="font-mono text-muted-foreground">{name}</span>
                          {present ? (
                            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              presente
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-destructive">
                              <XCircle className="h-3 w-3" />
                              ausente
                            </span>
                          )}
                        </div>
                      );
                    },
                  )}
                  {/* Suscripciones del admin */}
                  <div className="border-t pt-2 mt-2 space-y-1">
                    <MutedLine label="Tus devices suscritos" value={pushSubs.length} />
                    {pushSubs.length === 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Sin suscripciones — abre esta sesión en una PWA instalada (móvil o
                        escritorio) y otorga permisos de notificación.
                      </p>
                    )}
                    {pushSubs.slice(0, 3).map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between text-[11px] text-muted-foreground gap-2"
                      >
                        <span className="truncate flex-1" title={s.user_agent ?? ""}>
                          {s.user_agent
                            ? s.user_agent.slice(0, 60) + (s.user_agent.length > 60 ? "…" : "")
                            : "device sin UA"}
                        </span>
                        <span className="tabular-nums shrink-0">
                          {formatDateTime(s.updated_at)}
                        </span>
                      </div>
                    ))}
                    {pushSubs.length > 3 && (
                      <p className="text-[10px] text-muted-foreground">
                        + {pushSubs.length - 3} más
                      </p>
                    )}
                  </div>
                  {/* Botón de prueba — encola una notification para el admin
                      actual, que dispara el trigger y manda el push. */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 w-full"
                    onClick={() => void sendTestPush()}
                    disabled={sendingTestPush || !configOk || !allSecretsOk}
                  >
                    {sendingTestPush ? (
                      <Spinner size="sm" />
                    ) : (
                      <Send className="h-3.5 w-3.5 mr-1" />
                    )}
                    Enviar push de prueba a mí mismo
                  </Button>
                  {(!configOk || !allSecretsOk) && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                      Configura push_config y los secrets antes de probar.
                    </p>
                  )}
                </>
              )}
            </StatusCard>
          );
        })()}

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
                  Faltantes críticas:{" "}
                  <span className="font-mono">{missingExtensions.join(", ")}</span>
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
                const desc = EDGE_FUNCTION_DESCRIPTIONS[fn.function_name];
                return (
                  <div
                    key={fn.function_name}
                    className="text-xs border-b last:border-b-0 pb-1.5 last:pb-0 space-y-0.5"
                  >
                    <div className="flex items-start justify-between gap-2">
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
                    {desc && (
                      <p className="text-[10px] text-muted-foreground leading-relaxed">{desc}</p>
                    )}
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
                const desc = CRON_JOB_DESCRIPTIONS[j.jobname];
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
                    {desc && (
                      <p className="text-[10px] text-muted-foreground leading-relaxed">{desc}</p>
                    )}
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
