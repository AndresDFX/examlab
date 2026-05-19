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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { Layers } from "lucide-react";
import { invalidateModuleVisibility } from "@/hooks/use-module-visibility";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Row = { module_key: string; role: string; enabled: boolean; display_order: number };

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
  { key: "videos", label: "Biblioteca de videos" },
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
      .select("module_key, role, enabled, display_order");
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

  // Mapas rápidos para el render.
  const enabledMap = new Map<string, boolean>();
  const orderMap = new Map<string, number>();
  for (const r of rows) {
    enabledMap.set(`${r.module_key}::${r.role}`, r.enabled);
    orderMap.set(`${r.module_key}::${r.role}`, r.display_order);
  }
  // Si no hay fila, default true (mismo criterio que el helper SQL y el hook).
  const isOn = (mod: string, role: string) => enabledMap.get(`${mod}::${role}`) ?? true;
  const getOrder = (mod: string, role: string) => orderMap.get(`${mod}::${role}`) ?? 100;

  const saveOrder = async (moduleKey: string, role: string, next: number) => {
    if (!user) return;
    const key = `${moduleKey}::${role}::ord`;
    setSaving(key);
    // Optimistic update.
    const prev = getOrder(moduleKey, role);
    setRows((rs) => {
      const idx = rs.findIndex((r) => r.module_key === moduleKey && r.role === role);
      if (idx >= 0) {
        const copy = rs.slice();
        copy[idx] = { ...copy[idx], display_order: next };
        return copy;
      }
      // Si no había fila, creamos una con enabled=true (default) y el orden.
      return [...rs, { module_key: moduleKey, role, enabled: true, display_order: next }];
    });
    const { error } = await db.from("module_visibility").upsert(
      {
        module_key: moduleKey,
        role,
        enabled: isOn(moduleKey, role),
        display_order: next,
        updated_by: user.id,
      },
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
          copy[idx] = { ...copy[idx], display_order: prev };
          return copy;
        }
        return rs;
      });
      return;
    }
    invalidateModuleVisibility();
  };

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
    const { error } = await db.from("module_visibility").upsert(
      {
        module_key: moduleKey,
        role,
        enabled: next,
        display_order: getOrder(moduleKey, role),
        updated_by: user.id,
      },
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
            {`Habilita o deshabilita módulos por rol. Admin siempre ve todo (override). El campo Orden controla la posición del ítem en el sidebar para ese rol — número menor = aparece antes. Tras cambios los usuarios deben recargar la app para verlos.`}
          </HelpHint>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Útil para despliegues escalonados o para pausar temporalmente un módulo con problemas.
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
                    <th key={r.key} className="text-center font-medium py-2 px-2 w-36">
                      {r.label}
                      <div className="text-[9px] font-normal opacity-70 mt-0.5">
                        Visible · Orden
                      </div>
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
                      const ordKey = `${key}::ord`;
                      const checked = isOn(m.key, r.key);
                      const ord = getOrder(m.key, r.key);
                      return (
                        <td key={r.key} className="text-center py-2 px-2">
                          <div className="flex items-center justify-center gap-2">
                            <Switch
                              checked={checked}
                              disabled={saving === key}
                              onCheckedChange={(v) => void toggle(m.key, r.key, v)}
                            />
                            <Input
                              type="number"
                              min={0}
                              max={9999}
                              step={1}
                              value={ord}
                              disabled={saving === ordKey}
                              onChange={(e) => {
                                // Optimistic local-only update mientras
                                // el usuario escribe; persistimos en blur
                                // para no spamear UPDATEs por cada tecla.
                                const next = Number(e.target.value);
                                if (!Number.isFinite(next)) return;
                                setRows((rs) => {
                                  const idx = rs.findIndex(
                                    (x) => x.module_key === m.key && x.role === r.key,
                                  );
                                  if (idx >= 0) {
                                    const copy = rs.slice();
                                    copy[idx] = { ...copy[idx], display_order: next };
                                    return copy;
                                  }
                                  return [
                                    ...rs,
                                    {
                                      module_key: m.key,
                                      role: r.key,
                                      enabled: true,
                                      display_order: next,
                                    },
                                  ];
                                });
                              }}
                              onBlur={(e) => {
                                const next = Number(e.target.value);
                                if (!Number.isFinite(next)) return;
                                void saveOrder(m.key, r.key, next);
                              }}
                              className="h-7 w-14 text-xs text-center tabular-nums"
                              title="Orden en el sidebar (menor = arriba)"
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
