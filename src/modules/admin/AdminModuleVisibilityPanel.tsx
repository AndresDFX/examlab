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
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride } from "@/modules/tenants/use-tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { HelpHint } from "@/components/ui/help-hint";
import { RowAction } from "@/components/ui/row-action";
import { toast } from "sonner";
import { Layers, ChevronUp, ChevronDown, GripVertical, Save, RotateCcw } from "lucide-react";
import { invalidateModuleVisibility } from "@/hooks/use-module-visibility";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Row = {
  module_key: string;
  role: string;
  enabled: boolean;
  display_order: number;
  /** Migración 20260717000000: NULL = fila global (default plataforma);
   *  UUID = override de ese tenant. El panel decide cuál cargar/escribir
   *  según el "scope" del caller (global vs tenant). */
  tenant_id: string | null;
};

type ModuleRoleKey = "Admin" | "Docente" | "Estudiante";

/**
 * Lista canónica de FILAS del panel. La mayoría de filas usa `key` como
 * module_key directo (1:1 con la tabla `module_visibility`). Algunas son
 * VIRTUALES: una sola fila en el panel pero internamente se mapea a >1
 * module_key dependiendo del rol. Ej.: "Calificaciones" muestra UN sólo
 * row con switches Admin/Docente/Estudiante, pero detrás:
 *   - Docente → escribe `gradebook` (la vista del docente)
 *   - Estudiante → escribe `grades` (la vista del estudiante)
 * Es el MISMO concepto del producto ("calificaciones"), expuesto distinto
 * a cada rol; antes el panel mostraba 2 filas separadas y los Admins se
 * confundían sobre cuál tocar.
 *
 * `roleKeyMap` (opcional) define el remapeo: si para un rol está
 * presente, ese key se usa; si no, cae al `key` por defecto. Ej.:
 *   - Para el Admin nunca hay vista "Calificaciones" propia, mapeamos
 *     a `gradebook` (override-friendly: si lo prendés, Admin igual ve
 *     todo por has_role).
 */
const MODULES: Array<{
  key: string;
  label: string;
  roleKeyMap?: Partial<Record<ModuleRoleKey, string>>;
}> = [
  { key: "dashboard", label: "Dashboard" },
  // Académico: programas / asignaturas / periodos. Solo aplica al rol
  // Admin (estructura cross-curso). El SuperAdmin lo hereda vía Admin.
  // Antes vivía como tab de Configuración → Institución y no era
  // togglable desde acá; se sacó a su módulo propio para que el
  // SuperAdmin pueda definir el orden/visibilidad central de los Admin.
  { key: "academic", label: "Académico" },
  { key: "courses", label: "Cursos" },
  { key: "contents", label: "Contenidos" },
  { key: "exams", label: "Exámenes" },
  { key: "workshops", label: "Talleres" },
  { key: "projects", label: "Proyectos" },
  {
    // Unificación: antes había dos filas separadas (`gradebook`,
    // `grades`); las colapsamos en una sola "Calificaciones" — es el
    // mismo módulo conceptual, solo cambia la VISTA por rol.
    key: "calificaciones",
    label: "Calificaciones",
    roleKeyMap: { Admin: "gradebook", Docente: "gradebook", Estudiante: "grades" },
  },
  { key: "attendance", label: "Asistencia" },
  // Encuestas (mig 20260720000000) — Docente y Estudiante. Tipos:
  // single/multiple/slot. Async tipo Doodle o en vivo en sesión.
  { key: "polls", label: "Encuestas" },
  { key: "forum", label: "Foro" },
  { key: "calendar", label: "Calendario" },
  { key: "certificates", label: "Certificados" },
  { key: "tutor", label: "Tutor IA" },
  { key: "question_bank", label: "Banco de preguntas" },
  { key: "ai_prompts", label: "Prompts IA" },
  { key: "ai_cron", label: "Cola" },
  { key: "statistics", label: "Estadísticas" },
  { key: "messages", label: "Mensajes" },
  { key: "videos", label: "Biblioteca de videos" },
  { key: "teacher_students", label: "Usuarios (Docente)" },
  { key: "reports", label: "Informes" },
  // Auditoría: variantes Admin y Docente apuntan al mismo módulo.
  { key: "audit_logs", label: "Auditoría" },
];

/** Resuelve la fila virtual + rol a su `module_key` físico (en DB). */
function physicalKeyFor(
  module: { key: string; roleKeyMap?: Partial<Record<ModuleRoleKey, string>> },
  role: string,
): string {
  return module.roleKeyMap?.[role as ModuleRoleKey] ?? module.key;
}

const ROLES: Array<{ key: "Admin" | "Docente" | "Estudiante"; label: string }> = [
  { key: "Admin", label: "Admin" },
  { key: "Docente", label: "Docente" },
  { key: "Estudiante", label: "Estudiante" },
];

export function AdminModuleVisibilityPanel() {
  const { user, profile, roles } = useAuth();
  const activeRole = useActiveRole();
  // Scope global = SuperAdmin actuando como SuperAdmin sin "Ver como"
  // tenant. En ese caso el panel edita la fila `tenant_id IS NULL`
  // (default de la plataforma). En cualquier otro escenario (Admin de
  // tenant, o SuperAdmin con override activo) edita filas del tenant.
  const isGlobalScope =
    roles.includes("SuperAdmin") && activeRole === "SuperAdmin" && readTenantOverride() === null;
  const scopeTenantId: string | null = isGlobalScope ? null : (profile?.tenant_id ?? null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Orden local (módulo key → posición). Se inicializa desde rows al
  // cargar; los cambios por drag o flechas modifican esto sin tocar DB.
  const [localOrder, setLocalOrder] = useState<string[]>([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  // Para el drag and drop nativo necesitamos tracker el item arrastrado.
  const [dragKey, setDragKey] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    // En scope GLOBAL leemos solo las filas `tenant_id IS NULL`.
    // En scope TENANT leemos AMBAS (NULL + del tenant), y mostramos las
    // del tenant si existen, si no las del global como "default
    // heredado". Así el Admin arranca viendo el orden/visibilidad que
    // el SuperAdmin definió y solo crea overrides cuando toca algo.
    let q = db
      .from("module_visibility")
      .select("module_key, role, enabled, display_order, tenant_id");
    if (isGlobalScope) {
      q = q.is("tenant_id", null);
    } else if (scopeTenantId) {
      q = q.or(`tenant_id.is.null,tenant_id.eq.${scopeTenantId}`);
    } else {
      // Sin scope claro (Admin sin profile.tenant_id, raro): solo global.
      q = q.is("tenant_id", null);
    }
    const { data, error } = await q;
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar la visibilidad de módulos."));
      setLoading(false);
      return;
    }
    const fetched = (data ?? []) as Row[];
    // Merge tenant-sobre-global solo aplica en scope tenant — collapsamos
    // ambas fuentes en un solo conjunto preferente al override del tenant.
    let displayRows: Row[] = fetched;
    if (!isGlobalScope) {
      const byKey = new Map<string, Row>();
      // Primero las globales como base.
      for (const r of fetched) if (r.tenant_id == null) byKey.set(`${r.module_key}::${r.role}`, r);
      // Luego las del tenant pisan.
      for (const r of fetched) if (r.tenant_id != null) byKey.set(`${r.module_key}::${r.role}`, r);
      displayRows = [...byKey.values()];
    }
    setRows(displayRows);
    // Construir el orden inicial: tomar el `display_order` de cualquier
    // fila del módulo (después del merge, las del tenant ganan).
    // El orden inicial se calcula contra las VIRTUALES — para módulos
    // 1:1 con `key`, busca directamente; para los unificados (ej.
    // "calificaciones" → gradebook/grades) toma el primer physical row
    // encontrado entre los mapeos del rol. Tras un saveOrder ambos
    // physical comparten display_order, así que da igual cuál de los
    // dos vimos primero.
    const orderByVirtual = new Map<string, number>();
    for (const mod of MODULES) {
      const physicalKeys = new Set<string>([mod.key]);
      if (mod.roleKeyMap) {
        for (const k of Object.values(mod.roleKeyMap)) if (k) physicalKeys.add(k);
      }
      for (const r of displayRows) {
        if (physicalKeys.has(r.module_key)) {
          if (!orderByVirtual.has(mod.key)) orderByVirtual.set(mod.key, r.display_order);
        }
      }
    }
    const sorted = MODULES.slice().sort((a, b) => {
      const oa = orderByVirtual.get(a.key) ?? 9999;
      const ob = orderByVirtual.get(b.key) ?? 9999;
      if (oa !== ob) return oa - ob;
      return MODULES.findIndex((m) => m.key === a.key) - MODULES.findIndex((m) => m.key === b.key);
    });
    setLocalOrder(sorted.map((m) => m.key));
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // Cuando cambia el scope (el usuario alterna entre SuperAdmin
    // cross-tenant y Admin / "Ver como"), tenemos que re-cargar para
    // mostrar la fila correcta: global vs override del tenant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce, isGlobalScope, scopeTenantId]);

  // ── Mapas para el render ────────────────────────────────────────────
  // enabledMap está indexado por physical_key::role. Los lookups del UI
  // (que pasan virtualKey) van por `isOn`, que resuelve la traducción.
  const enabledMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of rows) m.set(`${r.module_key}::${r.role}`, r.enabled);
    return m;
  }, [rows]);
  const isOn = (virtualKey: string, role: string) => {
    const mod = MODULES.find((m) => m.key === virtualKey);
    const physical = mod ? physicalKeyFor(mod, role) : virtualKey;
    return enabledMap.get(`${physical}::${role}`) ?? true;
  };

  // Posición persistida en DB para detectar si hay cambios sin guardar.
  // Indexado por VIRTUAL key (igual que localOrder). Para virtuales
  // unificadas como "calificaciones" leemos el display_order del primer
  // physical encontrado.
  const persistedOrderByModule = useMemo(() => {
    const m = new Map<string, number>();
    for (const mod of MODULES) {
      const physicalKeys = new Set<string>([mod.key]);
      if (mod.roleKeyMap) {
        for (const k of Object.values(mod.roleKeyMap)) if (k) physicalKeys.add(k);
      }
      for (const r of rows) {
        if (physicalKeys.has(r.module_key)) {
          if (!m.has(mod.key)) m.set(mod.key, r.display_order);
        }
      }
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
  // `virtualKey` viene del UI (puede ser una fila unificada como
  // "calificaciones"). Resolvemos al physical key real ANTES de tocar
  // la DB o el state — todas las filas en `rows` viven en términos
  // físicos.
  const toggle = async (virtualKey: string, role: string, next: boolean) => {
    if (!user) return;
    const mod = MODULES.find((m) => m.key === virtualKey);
    const physicalKey = mod ? physicalKeyFor(mod, role) : virtualKey;
    const togglingId = `${virtualKey}::${role}`;
    setTogglingKey(togglingId);
    const prev = isOn(virtualKey, role);
    // Optimistic — usar physicalKey en setRows porque rows está en
    // términos físicos.
    setRows((rs) => {
      const idx = rs.findIndex((r) => r.module_key === physicalKey && r.role === role);
      if (idx >= 0) {
        const copy = rs.slice();
        copy[idx] = { ...copy[idx], enabled: next };
        return copy;
      }
      return [
        ...rs,
        {
          module_key: physicalKey,
          role,
          enabled: next,
          display_order: persistedOrderByModule.get(virtualKey) ?? 100,
          tenant_id: scopeTenantId,
        },
      ];
    });
    const { error } = await db.from("module_visibility").upsert(
      {
        module_key: physicalKey,
        role,
        enabled: next,
        display_order: persistedOrderByModule.get(virtualKey) ?? 100,
        updated_by: user.id,
        // En scope global escribimos NULL (la fila default de la
        // plataforma). En scope tenant escribimos el id del tenant —
        // esto CREA un override si no existía, o actualiza el existente.
        tenant_id: scopeTenantId,
      },
      // El unique index ahora es (tenant_id, module_key, role) con NULLS
      // NOT DISTINCT (migración 20260717000000), así que el onConflict
      // tiene que incluir las 3 columnas. La fila global y la del tenant
      // son filas DISTINTAS (no comparten PK), por eso podemos upsert
      // sin pisar la otra.
      { onConflict: "tenant_id,module_key,role" },
    );
    setTogglingKey(null);
    if (error) {
      toast.error(friendlyError(error));
      // Rollback
      setRows((rs) => {
        const idx = rs.findIndex((r) => r.module_key === physicalKey && r.role === role);
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
      tenant_id: string | null;
    }> = [];
    for (let i = 0; i < localOrder.length; i++) {
      const virtualKey = localOrder[i];
      const moduleDef = MODULES.find((m) => m.key === virtualKey);
      const order = (i + 1) * 10;
      // Para módulos unificados como "calificaciones", esto escribe
      // 3 filas distintas: (gradebook, Admin), (gradebook, Docente),
      // (grades, Estudiante) — todas con el MISMO display_order, así
      // los physical keys quedan sincronizados en posición.
      for (const r of ROLES) {
        const physicalKey = moduleDef ? physicalKeyFor(moduleDef, r.key) : virtualKey;
        updates.push({
          module_key: physicalKey,
          role: r.key,
          enabled: isOn(virtualKey, r.key),
          display_order: order,
          updated_by: user.id,
          tenant_id: scopeTenantId,
        });
      }
    }
    const { error } = await db
      .from("module_visibility")
      .upsert(updates, { onConflict: "tenant_id,module_key,role" });
    setSavingOrder(false);
    if (error) {
      toast.error(`No se pudo guardar el orden: ${friendlyError(error)}`);
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
        {/* Indicador de scope: el panel ahora opera en dos modos. El
            SuperAdmin (cross-tenant) edita el DEFAULT global de toda la
            plataforma; cada Admin (o SuperAdmin con "Ver como X") edita
            el OVERRIDE de su institución sobre ese default. */}
        <div
          className={`mt-2 rounded-md border px-3 py-2 text-xs ${
            isGlobalScope
              ? "border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300"
              : "border-indigo-500/30 bg-indigo-500/5 text-indigo-700 dark:text-indigo-300"
          }`}
        >
          {isGlobalScope ? (
            <>
              <strong>Configuración global de la plataforma.</strong> Lo que guardás acá es el
              default que reciben TODAS las instituciones. Cada Admin puede sobrescribirlo para su
              institución desde su propio panel.
            </>
          ) : (
            <>
              <strong>Override por institución.</strong> Lo que guardás acá aplica SOLO a esta
              institución y se superpone sobre la configuración global de la plataforma. Si dejás un
              módulo o estado sin tocar, se hereda del default global.
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando matriz…
          </div>
        ) : loadError ? (
          <ErrorState
            message="No pudimos cargar la matriz"
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <>
            {/* overflow-x-auto + min-w en el contenido evita que la matrix
              se apriete a 375px (3 switches w-16 + acciones w-16 + gaps
              ocupan ~256px fijos, dejaban <80px para el label del módulo
              — los nombres se truncaban a "Banc..." y eran ilegibles).
              En mobile la matrix scrollea horizontalmente; en sm+ cabe. */}
            <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
              <div className="min-w-[480px]">
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
              </div>
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
