/**
 * Preferencias del usuario.
 * Tabs (por ahora 1, deja espacio para más):
 *   - Notificaciones: silenciar canales (email / push) por kind.
 *
 * Las notificaciones in-app siempre se entregan (la regulan los kill
 * switches del admin + el bell badge).
 *
 * Para cada kind catalogado declaramos qué canales son técnicamente
 * posibles (`availableChannels`). Si un canal no está, el switch se
 * reemplaza por un placeholder "—" con tooltip explicativo. El catálogo
 * server-side de "qué kind puede ir por email" vive en el predicado
 * SQL `_notification_kind_emails` + `CRITICAL_KINDS` en
 * `notification-email.ts`. Hoy `content` es el único kind sin email.
 *
 * El estado `prefs` se NORMALIZA antes de comparar con el original:
 * como el default es opt-in (`true`), guardamos sólo los `false`
 * explícitos. Esto evita que el botón "Guardar" aparezca cuando el
 * usuario toggleó on→off→on en la misma sesión.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  Bell,
  Save,
  FileText,
  Hammer,
  FolderKanban,
  Award,
  MessageSquareText,
  Send,
  CalendarCheck,
  BookOpen,
  RotateCcw,
  Megaphone,
  BarChart3,
  ServerCog,
  LifeBuoy,
} from "lucide-react";

export const Route = createFileRoute("/app/preferences")({ component: PreferencesPage });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Channel = "email" | "push";

interface KindConfig {
  key: string;
  /** Clave i18n base (preferences.kinds.<key>.label / .desc). */
  i18nKey: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  /** Canales técnicamente disponibles. Si falta `email` acá, el toggle
   *  se reemplaza por un placeholder — evita engañar al usuario con un
   *  switch que el server descarta. Coherente con `_notification_kind_emails`
   *  + `CRITICAL_KINDS` en notification-email.ts. */
  availableChannels: Channel[];
  /** Roles que EFECTIVAMENTE reciben este kind. Si está, el toggle solo
   *  se muestra a usuarios que posean alguno de esos roles (evita mostrar
   *  "Soporte" a un estudiante, o "Encuestas" a un SuperAdmin que nunca
   *  las recibe). Si falta → visible para todos (kinds transversales como
   *  mensajes 1-a-1). Se filtra por roles POSEÍDOS (no el rol activo): tu
   *  preferencia aplica sin importar con qué rol estés navegando. */
  roles?: string[];
}

// Catálogo de kinds que el usuario puede silenciar. Solo incluimos los
// que efectivamente disparan al menos un canal (push o email).
const KINDS: KindConfig[] = [
  {
    key: "exam",
    i18nKey: "exam",
    icon: FileText,
    color: "text-violet-500",
    availableChannels: ["email", "push"],
    roles: ["Estudiante"],
  },
  {
    key: "workshop",
    i18nKey: "workshop",
    icon: Hammer,
    color: "text-amber-500",
    availableChannels: ["email", "push"],
    roles: ["Estudiante"],
  },
  {
    key: "project",
    i18nKey: "project",
    icon: FolderKanban,
    color: "text-rose-500",
    availableChannels: ["email", "push"],
    roles: ["Estudiante"],
  },
  {
    key: "grade",
    i18nKey: "grade",
    icon: Award,
    color: "text-emerald-500",
    availableChannels: ["email", "push"],
    roles: ["Estudiante"],
  },
  {
    key: "feedback",
    i18nKey: "feedback",
    icon: MessageSquareText,
    color: "text-pink-500",
    availableChannels: ["email", "push"],
    // Estudiante recibe respuestas del docente; Docente recibe comentarios
    // del alumno en el hilo de retroalimentación.
    roles: ["Estudiante", "Docente"],
  },
  {
    key: "info",
    i18nKey: "info",
    icon: Send,
    color: "text-cyan-500",
    availableChannels: ["email", "push"],
    // Mensajes 1-a-1 → cualquier rol los recibe. Transversal (sin gate).
  },
  {
    key: "attendance",
    i18nKey: "attendance",
    icon: CalendarCheck,
    color: "text-blue-500",
    availableChannels: ["email", "push"],
    roles: ["Estudiante"],
  },
  {
    key: "content",
    i18nKey: "content",
    icon: BookOpen,
    color: "text-indigo-500",
    // `content` no está en `_notification_kind_emails` — el server NUNCA
    // manda email para este kind. Mostrar el switch confundiría.
    availableChannels: ["push"],
    roles: ["Estudiante"],
  },
  {
    key: "broadcast",
    i18nKey: "broadcast",
    icon: Megaphone,
    color: "text-orange-500",
    // Difusión docente/admin a un curso. Emaila por destinatario
    // (CRITICAL_KINDS incluye 'broadcast').
    availableChannels: ["email", "push"],
    roles: ["Estudiante"],
  },
  {
    key: "poll",
    i18nKey: "poll",
    icon: BarChart3,
    color: "text-fuchsia-500",
    // `poll` no está en `_notification_kind_emails` → solo push.
    availableChannels: ["push"],
    roles: ["Estudiante"],
  },
  {
    key: "system",
    i18nKey: "system",
    icon: ServerCog,
    color: "text-slate-500",
    // Resumen diario docente + alertas del sistema (storage, edges). El
    // email es condicional al link (alertas admin / reset password), pero
    // el toggle gobierna ese envío cuando aplica.
    availableChannels: ["email", "push"],
    roles: ["Docente", "Admin", "SuperAdmin"],
  },
  {
    key: "support",
    i18nKey: "support",
    icon: LifeBuoy,
    color: "text-teal-500",
    // Tickets PQRS (Admin del tenant ↔ SuperAdmin). Email condicional al
    // toggle global `platform_settings.support_emails_enabled`.
    availableChannels: ["email", "push"],
    roles: ["Admin", "SuperAdmin"],
  },
];

type Prefs = Record<string, { email?: boolean; push?: boolean }>;

/**
 * Como el default server-side es opt-in (TRUE), las preferencias solo
 * son significativas cuando son `false`. Normalizar antes de comparar
 * evita que el botón "Guardar" aparezca por un toggle on→off→on que
 * deja la key explícita pero con el valor del default.
 */
function normalizePrefs(p: Prefs): Prefs {
  const out: Prefs = {};
  for (const [kind, channels] of Object.entries(p)) {
    if (!channels) continue;
    const nonDefault: { email?: boolean; push?: boolean } = {};
    if (channels.email === false) nonDefault.email = false;
    if (channels.push === false) nonDefault.push = false;
    if (Object.keys(nonDefault).length > 0) out[kind] = nonDefault;
  }
  return out;
}

function PreferencesPage() {
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const [prefs, setPrefs] = useState<Prefs>({});
  const [original, setOriginal] = useState<Prefs>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await db
        .from("profiles")
        .select("notification_preferences")
        .eq("id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setLoadError(friendlyError(error, t("preferences.loadError")));
        setLoading(false);
        return;
      }
      const p = (data?.notification_preferences ?? {}) as Prefs;
      setPrefs(p);
      setOriginal(p);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, retryNonce, t]);

  /** Devuelve si está habilitado (default true cuando no hay preferencia explícita). */
  const isEnabled = (kind: string, channel: Channel): boolean => {
    const v = prefs[kind]?.[channel];
    return v === undefined ? true : v;
  };

  const setEnabled = (kind: string, channel: Channel, enabled: boolean) => {
    setPrefs((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], [channel]: enabled },
    }));
  };

  // Comparación normalizada para evitar falsos positivos de "dirty"
  // cuando el usuario toggleó back-and-forth a su estado original.
  const dirty = useMemo(
    () => JSON.stringify(normalizePrefs(prefs)) !== JSON.stringify(normalizePrefs(original)),
    [prefs, original],
  );

  // Solo mostramos los kinds que el usuario EFECTIVAMENTE puede recibir
  // según sus roles poseídos. Los kinds sin `roles` (ej. mensajes 1-a-1)
  // son transversales y se muestran siempre. Funciona idéntico en todos
  // los tenants y en cross-tenant: las preferencias viven en el propio
  // perfil del usuario (profiles.notification_preferences) y los roles
  // salen de useAuth — sin dependencia del tenant activo.
  const visibleKinds = useMemo(
    () => KINDS.filter((k) => !k.roles || k.roles.some((r) => (roles as string[]).includes(r))),
    [roles],
  );

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      // Guardamos el estado normalizado: solo las preferencias `false`
      // explícitas. Mantiene la columna delgada y refleja que `{}` es
      // el estado canónico de "todo activado".
      const payload = normalizePrefs(prefs);
      const { error } = await db
        .from("profiles")
        .update({ notification_preferences: payload })
        .eq("id", user.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(t("preferences.savedToast"));
      setOriginal(payload);
      setPrefs(payload);
    } finally {
      setSaving(false);
    }
  };

  const restoreDefaults = () => {
    setPrefs({});
    toast.info(t("preferences.restoredToast"));
  };

  if (!user) return null;

  // El botón "Restaurar defaults" tiene sentido solo cuando algo está
  // efectivamente desactivado — si todo ya está en true, el click
  // sería no-op visual + sembraría confusión.
  const hasAnyOptOut = Object.keys(normalizePrefs(prefs)).length > 0;

  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        icon={<Bell className="h-6 w-6" />}
        title={t("preferences.title")}
        subtitle={t("preferences.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            {hasAnyOptOut && (
              <Button variant="outline" onClick={restoreDefaults} disabled={saving}>
                <RotateCcw className="h-4 w-4 mr-1" />
                {t("preferences.restoreDefaults")}
              </Button>
            )}
            {dirty && (
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                {t("common.save")}
              </Button>
            )}
          </div>
        }
      />

      {loading ? (
        <Card>
          <CardContent className="p-4 sm:p-8 text-center text-muted-foreground">
            <Spinner size="md" /> {t("common.loading")}
          </CardContent>
        </Card>
      ) : loadError ? (
        <ErrorState
          message={t("preferences.loadError")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("preferences.cardTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {/* Header */}
            <div className="grid grid-cols-[1fr_72px_72px] sm:grid-cols-[1fr_96px_96px] items-center pb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              <div>{t("preferences.tableHeaderCategory")}</div>
              <div className="text-center">{t("preferences.tableHeaderEmail")}</div>
              <div className="text-center">{t("preferences.tableHeaderPush")}</div>
            </div>
            {visibleKinds.map((cat) => {
              const Icon = cat.icon;
              const label = t(`preferences.kinds.${cat.i18nKey}.label`);
              const desc = t(`preferences.kinds.${cat.i18nKey}.desc`);
              const emailAvailable = cat.availableChannels.includes("email");
              const pushAvailable = cat.availableChannels.includes("push");
              return (
                <div
                  key={cat.key}
                  className="grid grid-cols-[1fr_72px_72px] sm:grid-cols-[1fr_96px_96px] items-center gap-2 py-3"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`mt-0.5 ${cat.color}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <Label className="text-sm font-medium">{label}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                    </div>
                  </div>
                  <div className="flex justify-center">
                    {emailAvailable ? (
                      <Switch
                        checked={isEnabled(cat.key, "email")}
                        onCheckedChange={(v) => setEnabled(cat.key, "email", v)}
                        aria-label={t("preferences.ariaEmailFor", { label })}
                      />
                    ) : (
                      // Placeholder cuando el server no envía email para
                      // este kind. Em-dash + tooltip de explicación —
                      // mejor que un switch deshabilitado que parece bug.
                      <div className="flex items-center gap-1 text-muted-foreground text-xs">
                        <span aria-hidden="true">—</span>
                        <HelpHint>{t("preferences.emailNotAvailableHint")}</HelpHint>
                        <span className="sr-only">{t("preferences.emailNotAvailable")}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex justify-center">
                    {pushAvailable ? (
                      <Switch
                        checked={isEnabled(cat.key, "push")}
                        onCheckedChange={(v) => setEnabled(cat.key, "push", v)}
                        aria-label={t("preferences.ariaPushFor", { label })}
                      />
                    ) : (
                      <span aria-hidden="true" className="text-muted-foreground text-xs">
                        —
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
