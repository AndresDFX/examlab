/**
 * Preferencias del usuario.
 * Tabs (por ahora 1, deja espacio para más):
 *   - Notificaciones: silenciar canales (email / push) por kind.
 *
 * Las notificaciones in-app siempre se entregan (la regulan los kill
 * switches del admin + el bell badge).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
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
} from "lucide-react";

export const Route = createFileRoute("/app/preferences")({ component: PreferencesPage });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Channel = "email" | "push";

interface KindConfig {
  key: string;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}

// Catálogo de kinds que el usuario puede silenciar. Solo incluimos los
// que efectivamente disparan email/push (predicado _notification_kind_emails).
const KINDS: KindConfig[] = [
  {
    key: "exam",
    label: "Exámenes",
    desc: "Asignación, recordatorios 1h antes, apertura de ventana",
    icon: FileText,
    color: "text-violet-500",
  },
  {
    key: "workshop",
    label: "Talleres",
    desc: "Publicación + recordatorio 24h antes del vencimiento",
    icon: Hammer,
    color: "text-amber-500",
  },
  {
    key: "project",
    label: "Proyectos",
    desc: "Publicación + recordatorio 24h antes del vencimiento",
    icon: FolderKanban,
    color: "text-rose-500",
  },
  {
    key: "grade",
    label: "Calificaciones",
    desc: "Cuando se publica la nota de una entrega",
    icon: Award,
    color: "text-emerald-500",
  },
  {
    key: "feedback",
    label: "Retroalimentación",
    desc: "Nuevos comentarios y respuestas",
    icon: MessageSquareText,
    color: "text-pink-500",
  },
  {
    key: "info",
    label: "Mensajes 1-a-1",
    desc: "Chat interno con docentes/compañeros (rate-limit 10 min)",
    icon: Send,
    color: "text-cyan-500",
  },
  {
    key: "attendance",
    label: "Asistencia",
    desc: "Cuando el docente abre el check-in",
    icon: CalendarCheck,
    color: "text-blue-500",
  },
  {
    key: "content",
    label: "Contenidos",
    desc: "Material nuevo asignado a una sesión (push/in-app, sin email)",
    icon: BookOpen,
    color: "text-indigo-500",
  },
];

type Prefs = Record<string, { email?: boolean; push?: boolean }>;

function PreferencesPage() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<Prefs>({});
  const [original, setOriginal] = useState<Prefs>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await db
        .from("profiles")
        .select("notification_preferences")
        .eq("id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        toast.error(`No se pudieron cargar las preferencias: ${error.message}`);
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
  }, [user]);

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

  const dirty = JSON.stringify(prefs) !== JSON.stringify(original);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await db
        .from("profiles")
        .update({ notification_preferences: prefs })
        .eq("id", user.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Preferencias guardadas");
      setOriginal(prefs);
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        backTo="/app"
        icon={<Bell className="h-6 w-6" />}
        title="Preferencias de notificación"
        subtitle="Decide qué tipos de notificación quieres recibir por correo y por push. Las notificaciones in-app siempre se entregan."
        actions={
          dirty ? (
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Guardar
            </Button>
          ) : null
        }
      />

      {loading ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <Spinner size="md" /> Cargando…
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Canales por tipo</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {/* Header */}
            <div className="grid grid-cols-[1fr_72px_72px] sm:grid-cols-[1fr_96px_96px] items-center pb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              <div>Categoría</div>
              <div className="text-center">Email</div>
              <div className="text-center">Push</div>
            </div>
            {KINDS.map((cat) => {
              const Icon = cat.icon;
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
                      <Label className="text-sm font-medium">{cat.label}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">{cat.desc}</p>
                    </div>
                  </div>
                  <div className="flex justify-center">
                    <Switch
                      checked={isEnabled(cat.key, "email")}
                      onCheckedChange={(v) => setEnabled(cat.key, "email", v)}
                      aria-label={`Email para ${cat.label}`}
                    />
                  </div>
                  <div className="flex justify-center">
                    <Switch
                      checked={isEnabled(cat.key, "push")}
                      onCheckedChange={(v) => setEnabled(cat.key, "push", v)}
                      aria-label={`Push para ${cat.label}`}
                    />
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
