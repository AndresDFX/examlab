/**
 * Panel admin: matriz Módulo × Rol para habilitar/deshabilitar la
 * visualización de módulos por rol.
 *
 * El switch escribe directamente a `module_visibility` con upsert por
 * (module_key, role). Después invalida el cache local del hook para
 * que sidebar y rutas guarded refresquen sin recargar.
 *
 * Admin SIEMPRE pasa los guards (override implícito en ModuleGuard),
 * así que la fila Admin es informativa pero no afecta — la dejamos
 * editable solo por consistencia visual.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { Layers } from "lucide-react";
import { invalidateModuleVisibility } from "@/hooks/use-module-visibility";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Row = { module_key: string; role: string; enabled: boolean };

// Lista canónica de módulos toggleables. Si agregas un módulo nuevo y
// quieres que el admin lo controle, agrégalo acá + en la migración.
const MODULES: Array<{ key: string; label: string; description?: string }> = [
  { key: "workshops", label: "Talleres" },
  { key: "projects", label: "Proyectos" },
  { key: "exams", label: "Exámenes" },
  { key: "courses", label: "Cursos" },
  { key: "gradebook", label: "Libro de notas (docente)" },
  { key: "grades", label: "Mis notas (estudiante)" },
  { key: "attendance", label: "Asistencia" },
  { key: "forum", label: "Foro" },
  { key: "calendar", label: "Calendario" },
  { key: "certificates", label: "Certificados" },
  { key: "tutor", label: "Tutor IA" },
  { key: "question_bank", label: "Banco de preguntas" },
  { key: "ai_prompts", label: "Prompts IA" },
  { key: "messages", label: "Mensajes" },
];

const ROLES: Array<{ key: "Admin" | "Docente" | "Estudiante"; label: string }> = [
  { key: "Admin", label: "Admin" },
  { key: "Docente", label: "Docente" },
  { key: "Estudiante", label: "Estudiante" },
];

export function AdminModuleVisibilityPanel() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db
      .from("module_visibility")
      .select("module_key, role, enabled");
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    setRows((data ?? []) as Row[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  // Mapa rápido para el render.
  const map = new Map<string, boolean>();
  for (const r of rows) map.set(`${r.module_key}::${r.role}`, r.enabled);
  // Si no hay fila, default true (mismo criterio que el helper SQL y el hook).
  const isOn = (mod: string, role: string) => map.get(`${mod}::${role}`) ?? true;

  const toggle = async (moduleKey: string, role: string, next: boolean) => {
    if (!user) return;
    const key = `${moduleKey}::${role}`;
    setSaving(key);
    // Optimistic update — devolvemos al estado anterior si falla.
    const prev = isOn(moduleKey, role);
    setRows((rs) => {
      const idx = rs.findIndex((r) => r.module_key === moduleKey && r.role === role);
      if (idx >= 0) {
        const copy = rs.slice();
        copy[idx] = { ...copy[idx], enabled: next };
        return copy;
      }
      return [...rs, { module_key: moduleKey, role, enabled: next }];
    });
    const { error } = await db
      .from("module_visibility")
      .upsert(
        { module_key: moduleKey, role, enabled: next, updated_by: user.id },
        { onConflict: "module_key,role" },
      );
    setSaving(null);
    if (error) {
      toast.error(error.message);
      // Rollback
      setRows((rs) => {
        const idx = rs.findIndex((r) => r.module_key === moduleKey && r.role === role);
        if (idx >= 0) {
          const copy = rs.slice();
          copy[idx] = { ...copy[idx], enabled: prev };
          return copy;
        }
        return rs;
      });
      return;
    }
    toast.success(`${moduleKey} · ${role} → ${next ? "habilitado" : "oculto"}`);
    // Invalidamos el cache global del hook para que sidebar/rutas refresquen.
    invalidateModuleVisibility();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="h-4 w-4 text-violet-500" />
          Visibilidad de módulos por rol
          <HelpHint>
            Habilita o deshabilita módulos por rol. Los usuarios con el rol indicado dejan de ver
            el módulo en el menú y reciben "Módulo no disponible" si intentan entrar por URL
            directa. <strong>Admin siempre ve todo</strong> (override) para poder testear qué se
            le esconde a Docente/Estudiante. Si cambias un toggle, los usuarios afectados deben
            recargar la app para ver el cambio.
          </HelpHint>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Útil para despliegues escalonados (publicar un módulo solo a Docentes mientras se
          afina) o para pausar temporalmente un módulo con problemas.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando matriz…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left font-medium py-2 pr-3">Módulo</th>
                  {ROLES.map((r) => (
                    <th key={r.key} className="text-center font-medium py-2 px-2 w-24">
                      {r.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MODULES.map((m) => (
                  <tr key={m.key} className="border-b last:border-b-0 hover:bg-muted/30">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-sm">{m.label}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{m.key}</div>
                    </td>
                    {ROLES.map((r) => {
                      const key = `${m.key}::${r.key}`;
                      const checked = isOn(m.key, r.key);
                      return (
                        <td key={r.key} className="text-center py-2 px-2">
                          <div className="inline-flex items-center justify-center">
                            <Switch
                              checked={checked}
                              disabled={saving === key}
                              onCheckedChange={(v) => void toggle(m.key, r.key, v)}
                            />
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
