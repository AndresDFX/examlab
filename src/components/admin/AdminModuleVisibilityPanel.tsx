/**
 * Panel admin: Visibilidad + orden de módulos.
 *
 * El admin define dos cosas por módulo:
 *   1. Visibilidad por rol — 3 switches (Admin / Docente / Estudiante).
 *      Cada toggle persiste al instante (decisión atómica, sin batch).
 *   2. Orden de aparición — DRAG & DROP nativo HTML5 + flechas arriba/
 *      abajo. La posición se guarda en `display_order` de la tabla
 *      `module_visibility` pero el número NO se muestra en la UI —
 *      el admin solo ve la posición relativa.
 *
 *   Cambios de orden se acumulan localmente (`pendingOrder`) y se
 *   persisten con el botón "Guardar orden". Eso evita N UPDATEs por
 *   cada drag/click cuando el admin reorganiza varios módulos seguidos.
 *
 *   El `display_order` se aplica IDÉNTICO a los 3 roles (no por rol),
 *   simplificando el modelo mental. La tabla soporta por-rol por compat
 *   con datos viejos, pero el panel escribe el mismo valor a las 3
 *   filas (module, role) al guardar.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { RowAction } from "@/components/ui/row-action";
import { toast } from "sonner";
import { Layers, ChevronUp, ChevronDown, GripVertical, Save, RotateCcw } from "lucide-react";
import { invalidateModuleVisibility } from "@/hooks/use-module-visibility";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Row = { module_key: string; role: string; enabled: boolean; display_order: number };

// Lista canónica de módulos toggleables. Si agregas un módulo nuevo y
// quieres que el admin lo controle, agrégalo acá + en la migración.
const MODULES: Array<{ key: string; label: string }> = [
  { key: "workshops", label: "Talleres" },
  { key: "projects", label: "Proyectos" },
  { key: "exams", label: "Exámenes" },
  { key: "courses", label: "Cursos" },
  { key: "gradebook", label: "Calificaciones (Docente)" },
  { key: "grades", label: "Calificaciones (Estudiante)" },
  { key: "attendance", label: "Asistencia" },
  { key: "forum", label: "Foro" },
  { key: "calendar", label: "Calendario" },
  { key: "certificates", label: "Certificados" },
  { key: "tutor", label: "Tutor IA" },
  { key: "contents", label: "Contenidos (Docente)" },
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
  // Orden local (módulo key → posición). Se inicializa desde rows al
  // cargar; los cambios por drag o flechas modifican esto sin tocar DB.
  const [localOrder, setLocalOrder] = useState<string[]>([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  // Para el drag and drop nativo necesitamos tracker el item arrastrado.
  const [dragKey, setDragKey] = useState<string | null>(null);

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
    const fetched = (data ?? []) as Row[];
    setRows(fetched);
    // Construir el orden inicial: media del display_order por módulo (o
    // el del rol Estudiante si existe — el "usuario más común"). Para
    // módulos sin fila aún, los empujamos al final con índice alto.
    const orderByModule = new Map<string, number>();
    for (const r of fetched) {
      if (!orderByModule.has(r.module_key)) {
        orderByModule.set(r.module_key, r.display_order);
      }
    }
    const sorted = MODULES.slice().sort((a, b) => {
      const oa = orderByModule.get(a.key) ?? 9999;
      const ob = orderByModule.get(b.key) ?? 9999;
      if (oa !== ob) return oa - ob;
      return MODULES.findIndex((m) => m.key === a.key) - MODULES.findIndex((m) => m.key === b.key);
    });
    setLocalOrder(sorted.map((m) => m.key));
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  // ── Mapas para el render ────────────────────────────────────────────
  const enabledMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of rows) m.set(`${r.module_key}::${r.role}`, r.enabled);
    return m;
  }, [rows]);
  const isOn = (mod: string, role: string) => enabledMap.get(`${mod}::${role}`) ?? true;

  // Posición persistida en DB para detectar si hay cambios sin guardar.
  // Tomamos el `display_order` de cualquier fila del módulo (todas las
  // roles deberían tener el mismo número tras un guardado).
  const persistedOrderByModule = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!m.has(r.module_key)) m.set(r.module_key, r.display_order);
    }
    return m;
  }, [rows]);

  // Hay cambios pendientes si el índice local difiere del persistido.
  const orderDirty = useMemo(() => {
    if (localOrder.length === 0) return false;
    // El nuevo orden persistido sería: cada módulo recibe el índice
    // multiplicado por 10 según su posición en localOrder. Si el ÚLTIMO
    // guardado coincide con eso para cada módulo, no hay dirty.
    for (let i = 0; i < localOrder.length; i++) {
      const target = (i + 1) * 10;
      const persisted = persistedOrderByModule.get(localOrder[i]);
      if (persisted !== target) return true;
    }
    return false;
  }, [localOrder, persistedOrderByModule]);

  // ── Toggle: persiste al instante ───────────────────────────────────
  const toggle = async (moduleKey: string, role: string, next: boolean) => {
    if (!user) return;
    const key = `${moduleKey}::${role}`;
    setTogglingKey(key);
    const prev = isOn(moduleKey, role);
    // Optimistic.
    setRows((rs) => {
      const idx = rs.findIndex((r) => r.module_key === moduleKey && r.role === role);
      if (idx >= 0) {
        const copy = rs.slice();
        copy[idx] = { ...copy[idx], enabled: next };
        return copy;
      }
      return [
        ...rs,
        {
          module_key: moduleKey,
          role,
          enabled: next,
          display_order: persistedOrderByModule.get(moduleKey) ?? 100,
        },
      ];
    });
    const { error } = await db.from("module_visibility").upsert(
      {
        module_key: moduleKey,
        role,
        enabled: next,
        display_order: persistedOrderByModule.get(moduleKey) ?? 100,
        updated_by: user.id,
      },
      { onConflict: "module_key,role" },
    );
    setTogglingKey(null);
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
    invalidateModuleVisibility();
  };

  // ── Reordering local (drag-drop + flechas) ─────────────────────────
  const moveModule = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || toIdx < 0 || toIdx >= localOrder.length) return;
    setLocalOrder((order) => {
      const copy = order.slice();
      const [item] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, item);
      return copy;
    });
  };

  const onDragStart = (key: string) => setDragKey(key);
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) return;
    const from = localOrder.indexOf(dragKey);
    const to = localOrder.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    moveModule(from, to);
    setDragKey(null);
  };

  // ── Guardar orden: UN upsert por (módulo × rol) con el nuevo índice * 10
  const saveOrder = async () => {
    if (!user || savingOrder) return;
    setSavingOrder(true);
    const updates: Array<{
      module_key: string;
      role: string;
      enabled: boolean;
      display_order: number;
      updated_by: string;
    }> = [];
    for (let i = 0; i < localOrder.length; i++) {
      const mod = localOrder[i];
      const order = (i + 1) * 10;
      for (const r of ROLES) {
        updates.push({
          module_key: mod,
          role: r.key,
          enabled: isOn(mod, r.key),
          display_order: order,
          updated_by: user.id,
        });
      }
    }
    const { error } = await db
      .from("module_visibility")
      .upsert(updates, { onConflict: "module_key,role" });
    setSavingOrder(false);
    if (error) {
      toast.error(`No se pudo guardar el orden: ${error.message}`);
      return;
    }
    toast.success("Orden de módulos guardado");
    invalidateModuleVisibility();
    void load();
  };

  // Restaurar = re-cargar desde DB (descarta cambios locales).
  const discardOrder = () => {
    void load();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="h-4 w-4 text-violet-500" />
          Visibilidad y orden de módulos
          <HelpHint>
            {`Habilita o deshabilita módulos por rol (3 switches a la derecha de cada fila). El orden vertical define cómo aparecen en el sidebar — arrastra una fila, o usa las flechas ▲▼. Los cambios de orden se guardan al pulsar "Guardar orden". Los switches se guardan al instante.`}
          </HelpHint>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Admin siempre ve todo (override). Tras un cambio los usuarios deben recargar para verlo.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando matriz…
          </div>
        ) : (
          <>
            {/* Header con etiquetas de los switches a la derecha */}
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-2 pb-1 text-[10px] uppercase font-medium text-muted-foreground tracking-wide">
              <span>Módulo</span>
              <div className="flex gap-2">
                {ROLES.map((r) => (
                  <span key={r.key} className="w-16 text-center">
                    {r.label}
                  </span>
                ))}
              </div>
              <span className="w-16 text-right">Posición</span>
            </div>

            <div className="border rounded-md divide-y bg-card">
              {localOrder.map((modKey, idx) => {
                const m = MODULES.find((x) => x.key === modKey);
                if (!m) return null;
                const isDragging = dragKey === modKey;
                return (
                  <div
                    key={m.key}
                    draggable
                    onDragStart={() => onDragStart(m.key)}
                    onDragOver={onDragOver}
                    onDrop={() => onDrop(m.key)}
                    onDragEnd={() => setDragKey(null)}
                    className={`grid grid-cols-[1fr_auto_auto] items-center gap-3 px-2 py-2 hover:bg-muted/30 transition-colors ${
                      isDragging ? "opacity-40 bg-muted/40" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0"
                        title="Arrastra para reordenar"
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{m.label}</div>
                        <div className="text-[10px] text-muted-foreground font-mono truncate">
                          {m.key}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {ROLES.map((r) => {
                        const key = `${m.key}::${r.key}`;
                        return (
                          <div key={r.key} className="w-16 flex justify-center">
                            <Switch
                              checked={isOn(m.key, r.key)}
                              disabled={togglingKey === key}
                              onCheckedChange={(v) => void toggle(m.key, r.key, v)}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="w-16 flex items-center justify-end gap-0.5">
                      <RowAction
                        label="Subir"
                        icon={ChevronUp}
                        disabled={idx === 0}
                        onClick={() => moveModule(idx, idx - 1)}
                      />
                      <RowAction
                        label="Bajar"
                        icon={ChevronDown}
                        disabled={idx === localOrder.length - 1}
                        onClick={() => moveModule(idx, idx + 1)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer: estado + acciones (guardar / descartar). El badge
                de cambios pendientes aparece solo cuando orderDirty=true. */}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              {orderDirty && (
                <span className="text-xs text-amber-700 dark:text-amber-400 mr-auto">
                  Tienes cambios de orden sin guardar.
                </span>
              )}
              {orderDirty && (
                <Button variant="outline" size="sm" onClick={discardOrder} disabled={savingOrder}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  Descartar
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => void saveOrder()}
                disabled={!orderDirty || savingOrder}
              >
                {savingOrder ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1" />
                )}
                Guardar orden
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
