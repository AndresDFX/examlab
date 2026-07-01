import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { HelpHint } from "@/components/ui/help-hint";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BadgeOverflow } from "@/components/ui/badge-overflow";
import { TenantQuotaCard } from "@/modules/tenants/TenantQuotaCard";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  SortableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Pencil,
  Users as UsersIcon,
  Eye,
  EyeOff,
  GraduationCap,
  Briefcase,
  ShieldCheck,
  KeyRound,
  Copy,
  UserX,
  UserCheck,
} from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { DateCell } from "@/components/ui/date-cell";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { startImpersonate } from "@/modules/admin/impersonation";
import { Spinner } from "@/components/ui/spinner";
import { toCSV } from "@/shared/lib/csv";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { extractEdgeError } from "@/shared/lib/edge-error";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { BulkPasswordDialog } from "@/shared/components/BulkPasswordDialog";

export const Route = createFileRoute("/app/admin/users")({ component: AdminUsers });

type StudentEstado = "activo" | "retirado" | "graduado" | "aplazado";

type Row = {
  id: string;
  full_name: string;
  institutional_email: string;
  personal_email: string | null;
  roles: AppRole[];
  // Identidad estudiantil (opcionales, solo tienen sentido para
  // usuarios con rol Estudiante; quedan null para Admin/Docente).
  codigo: string | null;
  // Código institucional del estudiante (matrícula / carnet). Único por
  // tenant cuando se asigna. Mig 20260822000000. El template CSV lo
  // usa con el mismo nombre `student_code`.
  student_code: string | null;
  documento: string | null;
  cohorte: string | null;
  estado: StudentEstado | null;
  programa_id: string | null;
  /** Tenant del usuario (Fase 1 multi-tenant). Para Admin viene siempre
   *  el suyo (RLS filtra); para SuperAdmin viene cross-tenant. */
  tenant_id: string | null;
  /** Fecha de creación del profile (replica de auth.users.created_at). */
  created_at: string | null;
  /** Último sign-in. Sincronizado por trigger desde auth.users
   *  (migración 20260715000000). null si nunca inició sesión. */
  last_sign_in_at: string | null;
  /** true mientras el usuario no haya cambiado la contraseña temporal que
   *  le asignó el Admin/SA al crearlo o resetearla. Cuando es true existe
   *  (normalmente) una fila en `admin_visible_passwords` re-visible. */
  must_change_password?: boolean | null;
  /** Cuenta activa. false = desactivada (no inicia sesión, no consume licencia).
   *  Mig 20261029000000. */
  is_active?: boolean | null;
};

const ALL_ROLES: AppRole[] = ["Admin", "Docente", "Estudiante", "SuperAdmin"];

// Labels resolved at render time via t() — see estadoActivo/etc. keys
const ESTADO_VALUES: StudentEstado[] = ["activo", "retirado", "graduado", "aplazado"];

const EMPTY_NEW: Row = {
  id: "",
  full_name: "",
  institutional_email: "",
  personal_email: "",
  roles: ["Estudiante"],
  codigo: null,
  student_code: null,
  documento: null,
  cohorte: null,
  estado: null,
  programa_id: null,
  tenant_id: null,
  // Sin profile aún: created_at lo asigna la DB en INSERT, last_sign_in_at
  // llega cuando el usuario inicia sesión (trigger desde auth.users).
  created_at: null,
  last_sign_in_at: null,
};

// Template CSV de import. Incluye:
//   - student_code: matrícula institucional (REQUERIDO para Estudiante,
//     opcional para Docente/Admin — la edge lo ignora si no es Est.).
//   - course_name: debe coincidir EXACTO con un curso existente del
//     tenant (case-insensitive). Si no matchea, la fila se rechaza con
//     mensaje claro.
//   - documento / cohorte / estado: identidad estudiantil OPCIONAL.
//     documento = cédula/ID; cohorte = texto libre (ej. "2026-1");
//     estado ∈ {activo, retirado, graduado, aplazado} (otro valor se
//     ignora). Solo se aplican al rol Estudiante; vacíos no tocan nada.
const USERS_TEMPLATE_CSV = toCSV([
  {
    full_name: "Juan Pérez",
    institutional_email: "juan.perez@institucion.edu",
    personal_email: "juan.perez@gmail.com",
    password: "Temporal#123",
    roles: "Estudiante",
    student_code: "2026100123",
    course_name: "Programación II",
    documento: "1234567890",
    cohorte: "2026-1",
    estado: "activo",
  },
]);

function AdminUsers() {
  const { t } = useTranslation();
  const { roles, profile, loading: authLoading } = useAuth();
  const activeRole = useActiveRole();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  // Correo institucional ORIGINAL al abrir el editor — para detectar si el
  // admin lo cambió y, de ser así, propagar el cambio al correo de acceso
  // (auth.users.email) vía la edge `admin-update-email`, no solo a profiles.
  const editOriginalEmailRef = useRef<string>("");
  const [password, setPassword] = useState("");
  // Toggle "ojo" para el input de contraseña (crear/editar). Default
  // false (oculto) para evitar shoulder-surfing — quien crea al usuario
  // debe poder revelarla explícitamente cuando la quiera mostrar/verificar.
  const [showPassword, setShowPassword] = useState(false);
  // Si true, al crear el usuario se marca `must_change_password=true` en
  // el profile → el primer login le exige cambiar la contraseña antes
  // de usar la app (diálogo bloqueante en AppLayout). Default true por
  // seguridad — la contraseña inicial la ve quien creó al usuario.
  // El admin puede desactivar este toggle cuando crea cuentas de
  // sistema/integraciones que no son de humano.
  const [forcePasswordChange, setForcePasswordChange] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Dialog "Ver contraseña": muestra la contraseña temporal guardada en
  // `admin_visible_passwords` (la que el Admin/SA asignó al crear/resetear).
  const [viewPwUser, setViewPwUser] = useState<Row | null>(null);
  const [viewPwValue, setViewPwValue] = useState<string | null>(null);
  const [viewPwLoading, setViewPwLoading] = useState(false);
  const [viewPwReveal, setViewPwReveal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkPasswordOpen, setBulkPasswordOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Programas activos para el dropdown de identidad estudiantil.
  // Se cargan en `load` junto con los perfiles.
  const [programs, setPrograms] = useState<Array<{ id: string; name: string }>>([]);
  // Tenants visibles para el caller. Solo el SuperAdmin ve TODAS las
  // instituciones (via RLS); el Admin normal solo ve la suya. Para el
  // SuperAdmin exponemos un filtro de institución arriba del grid (ver
  // `showTenantUI`) para acotar la vista cross-tenant.
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  // Cursos disponibles para inscripción inmediata al crear un Estudiante.
  // Se carga solo cuando el dialog está abierto en modo crear + role
  // Estudiante (lazy). Para Admin: cursos de su tenant via RLS; para
  // SuperAdmin: filtrados al tenant elegido en el form (editing.tenant_id),
  // o todos cross-tenant si todavía no eligió.
  const [enrollCourses, setEnrollCourses] = useState<
    Array<{
      id: string;
      name: string;
      period: string | null;
      tenant_id: string | null;
      program_id: string | null;
    }>
  >([]);
  // Curso seleccionado en el dialog para inscribir al estudiante recién
  // creado. NULL = sin inscripción automática (el admin lo matricula
  // manualmente después si quiere).
  const [enrollCourseId, setEnrollCourseId] = useState<string | null>(null);
  // Curso "por defecto" para el flujo de IMPORT MASIVO de usuarios. Si
  // el admin lo elige, todas las filas del CSV importado que NO traigan
  // `course_name` se enrollan automáticamente a este curso (best-effort:
  // si la fila trae `course_name` propia, gana esa). UX: evita tener que
  // pegar la misma `course_name` en cada fila del CSV cuando se importa
  // una lista que va completa a un solo curso.
  // Cargado lazy al primer click del dropdown de import; cacheado en
  // `coursesForBulkImport`. Vacío "" = sin curso por defecto.
  const [bulkImportCourseId, setBulkImportCourseId] = useState<string>("");
  const [coursesForBulkImport, setCoursesForBulkImport] = useState<
    Array<{ id: string; name: string; period: string | null }>
  >([]);
  const [coursesForBulkImportLoaded, setCoursesForBulkImportLoaded] = useState(false);
  // El filtro de institución solo debe aparecer cuando el usuario está
  // ACTIVAMENTE actuando como SuperAdmin (no por solo tener el rol). Un
  // usuario con SuperAdmin + Admin que cambia a Admin con el role-switcher
  // ya no quiere ver el dropdown cross-tenant: en ese caso opera dentro
  // de SU institución como cualquier Admin.
  const isSuperAdminCaller = activeRole === "SuperAdmin";
  // Mostrar el filtro + columna "Institución" cuando el caller es
  // SuperAdmin y hay al menos una institución cargada. Antes el umbral
  // era `> 1` (escondíamos el filtro con un solo tenant para no mostrar
  // un dropdown de 1 opción), pero el SuperAdmin pidió poder filtrar
  // siempre — útil incluso con 1 institución para confirmar el alcance,
  // y queda listo al crecer. El Admin normal nunca lo ve
  // (isSuperAdminCaller=false).
  const showTenantUI = isSuperAdminCaller && tenants.length > 0;
  // Tenant del Admin actual — necesario para auto-asignar nuevos usuarios
  // a SU institución cuando el SuperAdmin no eligió otra. Lo guardamos en
  // un ref para no re-renderizar cada vez que cambia, y lo populamos al
  // cargar el primer profile del Admin.
  const myTenantIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (profile?.tenant_id) myTenantIdRef.current = profile.tenant_id;
  }, [profile?.tenant_id]);
  const confirm = useConfirm();
  // Guard "cambios sin guardar" para el dialog crear/editar usuario.
  // Agrupa los campos editables del form (el objeto `editing` + los
  // states sueltos password / forcePasswordChange / enrollCourseId) en un
  // memo; el hook compara por JSON.stringify y pide confirmación al cerrar
  // si hay cambios. El dialog "Ver contraseña" es solo lectura → no se guarda.
  const userFormMemo = useMemo(
    () => ({ editing, password, forcePasswordChange, enrollCourseId }),
    [editing, password, forcePasswordChange, enrollCourseId],
  );
  const userDirty = useDirtyDialog(dialogOpen, userFormMemo);
  // Filtramos por nombre + ambos correos + rol. case-insensitive,
  // includes (no prefix). Cualquier match en cualquier campo cuenta —
  // los admins suelen buscar por nombre parcial o pedazo de email
  // (dominio, prefijo) sin recordar el campo exacto.
  // SuperAdmin: el filtro por tenant ya se aplica a la query en `load`
  // (re-corre cuando tenantFilter cambia). Aquí solo dejamos el filtro
  // por search, que necesita ser en memoria para responder rápido a cada
  // tecla sin re-pegarle a la DB.
  // Filtro por rol — "all" muestra todos. Si el rol elegido es
  // SuperAdmin pero el caller no lo tiene, el Select no muestra esa
  // opción (filtered abajo en el render).
  const [roleFilter, setRoleFilter] = useState<"all" | AppRole>("all");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("all");
  const filteredRows = useMemo(() => {
    let out = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) =>
          r.full_name.toLowerCase().includes(q) ||
          r.institutional_email.toLowerCase().includes(q) ||
          (r.personal_email?.toLowerCase().includes(q) ?? false) ||
          r.roles.some((role) => role.toLowerCase().includes(q)),
      );
    }
    if (roleFilter !== "all") {
      out = out.filter((r) => r.roles.includes(roleFilter));
    }
    if (activeFilter !== "all") {
      // is_active nullish ⇒ activo (compat con filas pre-migración).
      out = out.filter((r) =>
        activeFilter === "inactive" ? r.is_active === false : r.is_active !== false,
      );
    }
    return out;
  }, [rows, search, roleFilter, activeFilter]);
  // Orden por columna (click en el encabezado alterna asc/desc). Va ENTRE
  // el filtro y la paginación: filtrar → ordenar → paginar.
  const sort = useTableSort(filteredRows, {
    columns: {
      full_name: (r) => r.full_name,
      institutional_email: (r) => r.institutional_email,
      personal_email: (r) => r.personal_email,
      roles: (r) => r.roles.join(", "),
      institution: (r) => tenants.find((t) => t.id === r.tenant_id)?.name ?? "",
      created_at: (r) => r.created_at,
      last_sign_in_at: (r) => r.last_sign_in_at,
    },
    defaultSort: { key: "full_name", dir: "asc" },
    storageKey: "examlab_sort:admin_users",
  });

  // El multi-select trabaja sobre la lista filtrada+ordenada COMPLETA (todas
  // las páginas), no sobre la página actual — "seleccionar todos" cuando
  // hay un filtro activo significa "todos los que cumplen el filtro",
  // no "los visibles en la página 3". Para bulk delete de muchos
  // usuarios filtrados, lo intuitivo es no tener que paginar.
  const sel = useMultiSelect(sort.sorted);

  // Paginación client-side. La RLS ya acota a lo que el caller puede
  // ver; partir en páginas evita renderizar 500 filas en tenants
  // grandes. resetKey incluye search + roleFilter + tenantFilter para
  // que al filtrar el usuario vuelva a página 1 (no se quede en la
  // página 7 con grid vacío).
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:admin_users",
    resetKey: `${search}|${roleFilter}|${activeFilter}|${tenantFilter}|${sort.resetKey}`,
  });

  // Stats 4-card sobre los usuarios visibles al caller. Se calcula
  // sobre `rows` (no `filteredRows`) para que los conteos reflejen el
  // alcance completo (RLS + tenantFilter del SuperAdmin) y no se vean
  // afectados por el search/roleFilter local — el conteo "total" tiene
  // que coincidir con lo que la query trajo.
  const userStats = useMemo(() => {
    let students = 0;
    let teachers = 0;
    let admins = 0;
    for (const r of rows) {
      if (r.roles.includes("Estudiante")) students += 1;
      if (r.roles.includes("Docente")) teachers += 1;
      // Cuenta tanto Admin como SuperAdmin acá — ambos son "admins" desde
      // la óptica de gestión. Un user con ambos roles cuenta una sola vez.
      if (r.roles.includes("Admin") || r.roles.includes("SuperAdmin")) admins += 1;
    }
    return { total: rows.length, students, teachers, admins };
  }, [rows]);

  const handleBulkDelete = async (ids: string[]) => {
    // Borramos vía edge `admin-delete-user` (uno por uno) para que cada
    // delete pase por `auth.admin.deleteUser` y cascadee correctamente.
    // Antes hacíamos `delete from profiles` directo desde el cliente,
    // pero dejaba huérfanos en `auth.users` que rompían el chequeo de
    // unicidad al recrear con el mismo email.
    // Sequential (no Promise.all) — la edge ya audita por cada borrado
    // y queremos respetar rate-limit del Admin API de Supabase.
    let okCount = 0;
    const failed: string[] = [];
    for (const id of ids) {
      const { data, error: edgeErr } = await supabase.functions.invoke("admin-delete-user", {
        body: { userId: id },
      });
      const respError = (data as { error?: string } | null)?.error;
      if (edgeErr || respError) {
        failed.push(id);
        console.warn("[bulk delete] failed for", id, respError ?? edgeErr?.message);
      } else {
        okCount += 1;
      }
    }
    if (failed.length === ids.length) {
      throw new Error(t("hc_routesAppAdminUsers.bulkDeleteNoneError"));
    }
    void logEvent({
      action: "user.bulk_deleted",
      category: "user",
      severity: "warning",
      metadata: { count: okCount, total: ids.length, failed_count: failed.length },
    });
    if (failed.length === 0) {
      toast.success(
        i18n.t("toast.routes_app_admin_users.bulkDeleteSuccess", {
          defaultValue: "{{count}} usuario(s) eliminado(s) correctamente",
          count: okCount,
        }),
      );
    } else {
      toast.warning(
        i18n.t("toast.routes_app_admin_users.bulkDeletePartial", {
          defaultValue:
            "{{ok}} usuario(s) eliminados, {{failed}} fallaron — revisá la consola para detalles.",
          ok: okCount,
          failed: failed.length,
        }),
      );
    }
    sel.clear();
    load();
  };

  const selectedItems = useMemo(
    () =>
      rows
        .filter((r) => sel.isSelected(r.id))
        .map((r) => ({ id: r.id, label: `${r.full_name} (${r.institutional_email})` })),
    [rows, sel],
  );

  // SuperAdmin hereda los privilegios de Admin en módulos compartidos —
  // ve /app/admin/users con filtro extra cross-tenant. Ver CLAUDE.md
  // sección "Filtros cross-tenant en módulos compartidos".
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");

  // Abre el dialog "Ver contraseña" y carga la contraseña temporal del
  // usuario desde admin_visible_passwords (RLS la acota a SA / Admin del
  // mismo tenant). Si el usuario ya la cambió, la fila no existe.
  const openViewPassword = async (r: Row) => {
    setViewPwUser(r);
    setViewPwValue(null);
    setViewPwReveal(false);
    setViewPwLoading(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("admin_visible_passwords")
      .select("password")
      .eq("user_id", r.id)
      .maybeSingle();
    setViewPwLoading(false);
    if (error) {
      toast.error(friendlyError(error, t("hc_routesAppAdminUsers.passwordLoadError")));
      return;
    }
    setViewPwValue((data as { password?: string } | null)?.password ?? null);
  };

  const copyViewPassword = async () => {
    if (!viewPwValue) return;
    try {
      await navigator.clipboard.writeText(viewPwValue);
      toast.success(
        i18n.t("toast.routes_app_admin_users.passwordCopied", {
          defaultValue: "Contraseña copiada al portapapeles",
        }),
      );
    } catch {
      toast.error(
        i18n.t("toast.routes_app_admin_users.copyFailed", {
          defaultValue: "No se pudo copiar",
        }),
      );
    }
  };

  const handleImpersonate = async (r: Row) => {
    if (r.roles.includes("Admin")) {
      toast.error(
        i18n.t("toast.routes_app_admin_users.cannotImpersonateAdmin", {
          defaultValue: "No se puede impersonar a otro administrador",
        }),
      );
      return;
    }
    const ok = await confirm({
      title: t("hc_routesAppAdminUsers.impersonateConfirmTitle", { name: r.full_name }),
      description: t("hc_routesAppAdminUsers.impersonateConfirmDesc"),
      confirmLabel: t("hc_routesAppAdminUsers.impersonateConfirmLabel"),
      tone: "warning",
    });
    if (!ok) return;
    try {
      await startImpersonate(r.id);
      // startImpersonate dispara window.location.href → no llegamos aquí.
    } catch (e) {
      toast.error(friendlyError(e, t("hc_routesAppAdminUsers.impersonateStartError")));
    }
  };

  // Desactivar / reactivar un usuario vía edge admin-set-user-active (ban GoTrue
  // + espejo is_active + conteo de licencia). La autz fina la re-valida la edge;
  // acá solo confirmamos y mostramos feedback.
  const handleSetActive = async (r: Row, active: boolean) => {
    const ok = await confirm({
      title: active
        ? t("adminUsers.reactivateTitle", { defaultValue: `Reactivar a ${r.full_name}` })
        : t("adminUsers.deactivateTitle", { defaultValue: `Desactivar a ${r.full_name}` }),
      description: active
        ? t("adminUsers.reactivateDesc", {
            defaultValue:
              "Volverá a poder iniciar sesión y ocupará de nuevo su cupo de licencia (si hay cupo).",
          })
        : t("adminUsers.deactivateDesc", {
            defaultValue:
              "No podrá iniciar sesión y libera su cupo de licencia. Su sesión se invalida al expirar el token. Podés reactivarlo luego.",
          }),
      confirmLabel: active ? t("common.reactivate", { defaultValue: "Reactivar" }) : t("common.deactivate", { defaultValue: "Desactivar" }),
      tone: active ? "warning" : "destructive",
    });
    if (!ok) return;
    try {
      const { data, error } = await supabase.functions.invoke("admin-set-user-active", {
        body: { userId: r.id, active },
      });
      if (error || (data as { error?: string } | null)?.error) {
        // Los errores de negocio de la edge son non-2xx (403 authz, 409 sin
        // cupo) → el body vive en FunctionsHttpError.context, no en data.
        // extractEdgeError lo desempaca para mostrar el motivo real (ej. "No
        // hay cupo de docentes (5/5)…"). Mismo patrón que las otras invokes.
        const detail = await extractEdgeError(error, data);
        toast.error(detail || "No se pudo cambiar el estado del usuario");
        return;
      }
      toast.success(
        active
          ? t("adminUsers.reactivatedToast", { defaultValue: "Usuario reactivado" })
          : t("adminUsers.deactivatedToast", { defaultValue: "Usuario desactivado" }),
      );
      void logEvent({
        action: active ? "user.reactivated" : "user.deactivated",
        category: "user",
        severity: "warning",
        entityType: "user",
        entityId: r.id,
        entityName: r.full_name,
      });
      load();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo cambiar el estado del usuario"));
    }
  };

  // Epoch que se incrementa con cada load() — permite descartar setStates
  // de una corrida vieja cuando el SA cambia tenantFilter rápido entre
  // varias opciones. Sin esto, la respuesta más lenta sobrescribía la
  // más reciente y el grid mostraba usuarios del tenant equivocado.
  const loadEpochRef = useRef(0);
  const load = async () => {
    const myEpoch = ++loadEpochRef.current;
    setLoading(true);
    setLoadError(null);
    // SuperAdmin con filtro de institución activo: aplicamos
    // `.eq('tenant_id', X)` a la query. Antes el filtro era puramente en
    // memoria — funcionaba pero traía TODO el dataset cross-tenant. Ahora
    // es funcional: el dataset llega ya filtrado por la institución
    // elegida. Para "Todas" mantenemos el comportamiento original (sin
    // restricción adicional; la RLS de SuperAdmin permite cross-tenant).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from("profiles").select("*").order("full_name");
    if (isSuperAdminCaller && tenantFilter !== "all") {
      // "none" = usuarios huérfanos sin institución asignada (tenant_id IS
      // NULL). Útil para que el SuperAdmin detecte profiles sueltos antes
      // de asignarles tenant, o post-SSO sin provisión completa.
      if (tenantFilter === "none") {
        q = q.is("tenant_id", null);
      } else {
        q = q.eq("tenant_id", tenantFilter);
      }
    }
    const { data: profs, error: profsErr } = await q;
    if (loadEpochRef.current !== myEpoch) return; // stale — superado
    if (profsErr) {
      setLoadError(friendlyError(profsErr, t("hc_routesAppAdminUsers.usersLoadError")));
      setLoading(false);
      return;
    }
    const { data: rs } = await supabase.from("user_roles").select("user_id, role");
    if (loadEpochRef.current !== myEpoch) return;
    const grouped = new Map<string, AppRole[]>();
    (rs ?? []).forEach((r: any) => {
      const arr = grouped.get(r.user_id) ?? [];
      arr.push(r.role);
      grouped.set(r.user_id, arr);
    });
    // Programas activos (best-effort — si la migración no se aplicó, el
    // dropdown queda vacío pero el form no se rompe: programa_id es opcional).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: progs } = await (supabase as any)
      .from("academic_programs")
      .select("id, name")
      .eq("active", true)
      .order("name");
    if (loadEpochRef.current !== myEpoch) return;
    // Tenants visibles (RLS-filtrado): Admin ve solo el suyo; SuperAdmin
    // ve todos. Solo expone el filtro cuando hay >1 institución cargada.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tens } = await (supabase as any)
      .from("tenants")
      .select("id, slug, name")
      .is("deleted_at", null)
      .order("name");
    if (loadEpochRef.current !== myEpoch) return;
    // Commit final: todos los setStates juntos al cierre, una sola
    // corrida ganadora.
    setRows((profs ?? []).map((p: any) => ({ ...p, roles: grouped.get(p.id) ?? [] })));
    setPrograms((progs ?? []) as Array<{ id: string; name: string }>);
    setTenants((tens ?? []) as Array<{ id: string; slug: string; name: string }>);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // SuperAdmin: cuando cambia el filtro de institución, recargamos la
    // query con `.eq('tenant_id', X)` aplicado. Para Admin normal el
    // filtro no se renderiza, así que tenantFilter queda en 'all'
    // permanente y este effect corre solo una vez al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantFilter]);

  const saveRoles = async (userId: string, newRoles: AppRole[]) => {
    const { data: current } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    const currentSet = new Set((current ?? []).map((r: any) => r.role as AppRole));
    const newSet = new Set(newRoles);
    const toAdd = newRoles.filter((r) => !currentSet.has(r));
    const toRemove = [...currentSet].filter((r) => !newSet.has(r));
    // Eliminamos los roles a quitar PRIMERO para que un fallo en el
    // INSERT subsecuente no deje al usuario con todos los roles (los
    // nuevos + los viejos que debían salir). Si el DELETE falla, ningún
    // cambio se aplicó — comportamiento atómico desde la perspectiva
    // del usuario aunque sean 2 operaciones.
    if (toRemove.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from("user_roles")
        .delete()
        .eq("user_id", userId)
        .in("role", toRemove);
      if (error) {
        toast.error(friendlyError(error));
        return false;
      }
    }
    if (toAdd.length) {
      // Cast: el tipo regenerado de supabase aún no incluye 'SuperAdmin'
      // en el enum app_role (Lovable lo regenera en el próximo Publish).
      // El INSERT igual funciona en server-side porque el enum ya tiene
      // el valor desde la migración 20260621.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from("user_roles")
        .insert(toAdd.map((role) => ({ user_id: userId, role })));
      if (error) {
        // Si el INSERT falla aquí, los roles a remover YA están fuera
        // — el usuario queda con un subset incorrecto. Reportar al admin
        // explícitamente para que reintente; no podemos auto-revertir
        // sin riesgo (el DELETE ya fue confirmado por la DB).
        toast.error(
          i18n.t("toast.routes_app_admin_users.rolesAddFailedAfterRemove", {
            defaultValue:
              "{{error}}. Los roles a quitar SÍ se eliminaron; revisa el estado del usuario y reintentá agregar los nuevos.",
            error: friendlyError(error),
          }),
        );
        return false;
      }
    }
    // Auditoría — solo si hubo cambios reales. Privilege escalation
    // (Admin/Docente añadido o removido) lo elevamos a `warning` por
    // ser un cambio sensible.
    if (toAdd.length || toRemove.length) {
      const target = rows.find((r) => r.id === userId);
      const sensitive = [...toAdd, ...toRemove].some((r) => r === "Admin" || r === "Docente");
      void logEvent({
        action: "user.roles_updated",
        category: "user",
        severity: sensitive ? "warning" : "info",
        entityType: "user",
        entityId: userId,
        entityName: target?.full_name ?? target?.institutional_email ?? null,
        metadata: {
          before: [...currentSet],
          after: newRoles,
          added: toAdd,
          removed: toRemove,
        },
      });
    }
    return true;
  };

  const openNew = () => {
    setEditing({ ...EMPTY_NEW });
    setPassword("");
    // Cada usuario nuevo arranca con el default (true) — más seguro que
    // heredar la elección del usuario creado anteriormente.
    setForcePasswordChange(true);
    // Toggle del ojo siempre oculto al abrir — quien crea/edita activa
    // la visibilidad explícitamente cuando la necesita.
    setShowPassword(false);
    setEnrollCourseId(null);
    setDialogOpen(true);
  };

  const openEdit = (r: Row) => {
    setEditing({ ...r });
    editOriginalEmailRef.current = r.institutional_email ?? "";
    setPassword("");
    setShowPassword(false);
    setEnrollCourseId(null);
    setDialogOpen(true);
  };

  /**
   * Carga los cursos disponibles para inscripción inmediata. Se dispara
   * cuando el dialog está en modo CREAR + role Estudiante. Para el Admin
   * RLS acota a su tenant; para el SuperAdmin filtramos por
   * `editing.tenant_id` si lo eligió (para evitar listar cursos de
   * tenants donde el estudiante no terminó), o traemos todos sino.
   * El curso elegido se inserta en `course_enrollments` después de crear
   * el usuario en el `save` (best-effort: si falla, el usuario queda
   * creado y el admin lo matricula manualmente).
   */
  useEffect(() => {
    if (!dialogOpen || !editing) return;
    if (editing.id) return; // solo modo crear
    if (!editing.roles.includes("Estudiante")) return;
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (supabase as any)
        .from("courses")
        .select("id, name, period, tenant_id, program_id")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      // Para SuperAdmin: si eligió tenant en el form, acotamos. Para
      // Admin: RLS ya filtra a su tenant.
      if (isSuperAdminCaller && editing.tenant_id) {
        q = q.eq("tenant_id", editing.tenant_id);
      } else if (!isSuperAdminCaller && myTenantIdRef.current) {
        q = q.eq("tenant_id", myTenantIdRef.current);
      }
      const { data } = await q;
      if (cancelled) return;
      setEnrollCourses(
        (data ?? []) as Array<{
          id: string;
          name: string;
          period: string | null;
          tenant_id: string | null;
          program_id: string | null;
        }>,
      );
    })();
    return () => {
      cancelled = true;
    };
    // Listamos las props específicas de `editing` que importan para el
    // fetch; incluir `editing` entero re-dispararía el effect cada vez
    // que el admin tipea en el form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen, editing?.id, editing?.roles, editing?.tenant_id, isSuperAdminCaller]);

  // Cascada Programa → Curso de inscripción (FK courses.program_id →
  // academic_programs). Cuando el admin elige un Programa en la identidad
  // estudiantil, el Select de "inscribir a curso" solo debe ofrecer cursos
  // de ESE programa. Sin programa elegido ("__none__"), mostramos todos
  // (incluyendo los sin programa). No filtramos por asignatura porque acá
  // no hay Select de asignatura — solo programa.
  const programaSeleccionado = editing?.programa_id ?? null;
  const filteredEnrollCourses = useMemo(
    () =>
      programaSeleccionado
        ? enrollCourses.filter((c) => c.program_id === programaSeleccionado)
        : enrollCourses,
    [enrollCourses, programaSeleccionado],
  );

  // Reset del hijo: si el curso elegido deja de pertenecer al programa
  // seleccionado (el admin cambió el programa después de elegir curso),
  // limpiamos la selección para no quedar con un curso invisible/ inválido.
  useEffect(() => {
    if (!enrollCourseId) return;
    if (!filteredEnrollCourses.some((c) => c.id === enrollCourseId)) {
      setEnrollCourseId(null);
    }
  }, [filteredEnrollCourses, enrollCourseId]);

  /** Validación proactiva de unicidad — antes de mandar el form al
   *  backend. Llama al RPC `check_email_taken` (case-insensitive,
   *  excluyendo al propio usuario en modo edit). Retorna true si
   *  algún email del form colisiona con otro usuario; el caller debe
   *  abortar y mostrar el toast correspondiente. */
  const validateEmailUniqueness = async (
    institutional: string,
    personal: string,
    excludeUserId: string | null,
  ): Promise<boolean> => {
    const check = async (email: string, kind: "institutional" | "personal") => {
      const clean = email.trim().toLowerCase();
      if (!clean) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("check_email_taken", {
        p_email: clean,
        p_exclude_user_id: excludeUserId,
      });
      if (error) {
        console.warn("[admin.users] check_email_taken failed:", error.message);
        return false; // fallback al constraint UNIQUE de DB
      }
      if (data === true) {
        toast.error(
          kind === "institutional"
            ? i18n.t("toast.routes_app_admin_users.institutionalEmailTaken", {
                defaultValue:
                  'El email institucional "{{email}}" ya está en uso por otro usuario.',
                email: clean,
              })
            : i18n.t("toast.routes_app_admin_users.personalEmailTaken", {
                defaultValue: 'El email personal "{{email}}" ya está en uso por otro usuario.',
                email: clean,
              }),
        );
        return true;
      }
      return false;
    };
    if (await check(institutional, "institutional")) return true;
    if (await check(personal, "personal")) return true;
    return false;
  };

  const saveProfile = async () => {
    if (!editing) return;
    if (!editing.full_name.trim() || !editing.institutional_email.trim()) {
      toast.error(
        i18n.t("toast.routes_app_admin_users.nameAndEmailRequired", {
          defaultValue: "Nombre y email institucional son requeridos",
        }),
      );
      return;
    }
    setSavingUser(true);
    try {
      // Validación proactiva de unicidad — antes de tocar DB. En modo
      // edit pasamos editing.id como exclude para que no choque con el
      // propio usuario.
      if (
        await validateEmailUniqueness(
          editing.institutional_email,
          editing.personal_email ?? "",
          editing.id || null,
        )
      ) {
        return;
      }
      // Guardrail anti-huérfano: solo un SuperAdmin puro puede no tener
      // institución. Si el form deja tenant_id=null pero el usuario no
      // es SuperAdmin, abortar — sino la RLS de la app le devuelve datos
      // vacíos en cada query (current_tenant_id() retorna null).
      if (
        isSuperAdminCaller &&
        editing.tenant_id === null &&
        !editing.roles.includes("SuperAdmin")
      ) {
        toast.error(
          i18n.t("toast.routes_app_admin_users.onlySuperAdminNoTenant", {
            defaultValue:
              "Solo el rol SuperAdmin puede no tener institución. Asigna una institución o agrega el rol SuperAdmin.",
          }),
        );
        return;
      }
      if (editing.id) {
        // Cambio del CORREO DE ACCESO (login): NO se escribe a profiles
        // directamente — el correo de login vive en auth.users.email y solo
        // el service_role lo toca. Si el admin cambió el correo, lo enrutamos
        // por la edge `admin-update-email`, que actualiza auth.users.email
        // (fuente de verdad) y el trigger tg_sync_profile_institutional_email
        // espeja a profiles.institutional_email. Hacerlo PRIMERO: si falla
        // (correo tomado, fuera de tenant), abortamos sin tocar nada más.
        const newEmail = editing.institutional_email.trim();
        const emailChanged =
          newEmail.toLowerCase() !== (editOriginalEmailRef.current ?? "").trim().toLowerCase();
        if (emailChanged) {
          const { data: emRes, error: emErr } = await supabase.functions.invoke(
            "admin-update-email",
            { body: { userId: editing.id, newEmail } },
          );
          if (emErr || emRes?.error) {
            const detail = await extractEdgeError(emErr, emRes);
            toast.error(
              detail ||
                i18n.t("toast.routes_app_admin_users.emailChangeFailed", {
                  defaultValue: "No se pudo cambiar el correo de acceso",
                }),
            );
            return;
          }
        }
        // Update profile
        // Identidad estudiantil — solo se persiste para usuarios con rol
        // Estudiante. Para Admin/Docente forzamos NULL aunque el form
        // hubiese tenido valores (mejor pisarlos que dejar inconsistencia).
        const isStudent = editing.roles.includes("Estudiante");
        // SuperAdmin puede reasignar tenant en edit (sujeto al trigger
        // tg_check_profile_tenant_change que bloquea si el user tiene
        // cursos activos en el tenant viejo). Admin no lo toca.
        // institutional_email NO va acá — lo gobierna la edge admin-update-email
        // + el trigger de sincronía (ver bloque emailChanged arriba). Escribirlo
        // directo dejaría auth.users.email desincronizado (el bug que se corrige).
        const updatePayload: Record<string, unknown> = {
          full_name: editing.full_name,
          personal_email: editing.personal_email || null,
          codigo: isStudent ? editing.codigo?.trim() || null : null,
          student_code: isStudent ? editing.student_code?.trim() || null : null,
          documento: isStudent ? editing.documento?.trim() || null : null,
          cohorte: isStudent ? editing.cohorte?.trim() || null : null,
          estado: isStudent ? editing.estado || null : null,
          programa_id: isStudent ? editing.programa_id || null : null,
        };
        // Tenant assignment: SOLO el SuperAdmin puede tocar este campo.
        // Cambios permitidos:
        //   - Asignar institución (valor string).
        //   - Desasociar — `tenant_id = null` SOLO si el usuario tiene
        //     rol SuperAdmin (un Admin/Docente/Estudiante sin tenant
        //     queda huérfano sin RLS funcional → mal estado).
        // El trigger `tg_check_profile_tenant_change` rechaza el cambio
        // si el usuario tiene cursos activos en el tenant viejo
        // (excepto cuando viene de NULL).
        if (isSuperAdminCaller) {
          if (editing.tenant_id) {
            updatePayload.tenant_id = editing.tenant_id;
          } else if (editing.roles.includes("SuperAdmin")) {
            // Desasociación explícita: solo válida para SuperAdmin puros.
            updatePayload.tenant_id = null;
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from("profiles")
          .update(updatePayload)
          .eq("id", editing.id);
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        const ok = await saveRoles(editing.id, editing.roles);
        if (!ok) return;
        // Update password if provided
        if (password.trim()) {
          if (password.length < 8) {
            toast.error(
              i18n.t("toast.routes_app_admin_users.passwordMinLength", {
                defaultValue: "La contraseña debe tener al menos 8 caracteres",
              }),
            );
            return;
          }
          const { data: pwRes, error: pwErr } = await supabase.functions.invoke(
            "admin-update-password",
            {
              body: { userId: editing.id, newPassword: password },
            },
          );
          if (pwErr || pwRes?.error) {
            const detail = await extractEdgeError(pwErr, pwRes);
            toast.error(detail || t("hc_routesAppAdminUsers.passwordUpdateError"));
            return;
          }
        }
        toast.success(
          password.trim()
            ? i18n.t("toast.routes_app_admin_users.userUpdatedWithPassword", {
                defaultValue: "Usuario actualizado correctamente (contraseña incluida)",
              })
            : i18n.t("toast.routes_app_admin_users.userUpdated", {
                defaultValue: "Usuario actualizado correctamente",
              }),
        );
        void logEvent({
          action: "user.updated",
          category: "user",
          actorRole: roles[0],
          entityType: "user",
          entityId: editing.id,
          entityName: editing.full_name,
          metadata: { roles: editing.roles },
        });
      } else {
        // Create via bulk-import (single row)
        if (!password || password.length < 8) {
          toast.error(
            i18n.t("toast.routes_app_admin_users.passwordRequired", {
              defaultValue: "Contraseña requerida (mínimo 8 caracteres)",
            }),
          );
          return;
        }
        const { data, error } = await supabase.functions.invoke("bulk-import-users", {
          body: {
            rows: [
              {
                full_name: editing.full_name,
                institutional_email: editing.institutional_email,
                // `|| null` (no `?? ""`): un personal_email vacío debe llegar
                // como NULL, no como "". El índice parcial de profiles
                // (personal_email IS NOT NULL) indexa el "" y el 2º usuario
                // sin personal choca → 500 "Database error creating new user".
                // El trigger handle_new_user también normaliza (NULLIF), esto
                // es defensa-en-profundidad del lado cliente.
                personal_email: editing.personal_email || null,
                password,
                roles: editing.roles.join("|"),
                // Identidad estudiantil opcional: el formulario ya tiene estos
                // inputs, pero antes NO se mandaban al crear (solo el path de
                // edición los guardaba) → al crear un estudiante se perdían.
                // La edge los persiste si el role incluye Estudiante.
                student_code: editing.student_code?.trim() || null,
                documento: editing.documento?.trim() || null,
                cohorte: editing.cohorte?.trim() || null,
                estado: editing.estado || null,
                codigo: editing.codigo?.trim() || null,
                // Pasamos explícitamente true/false para que el edge no
                // tenga que adivinar la intención. Si el caller fuera
                // legacy (CSV viejo) sin este campo, la edge cae al
                // default `true` por backward-compat.
                force_password_change: forcePasswordChange,
              },
            ],
          },
        });
        if (error) {
          const detail = await extractEdgeError(error, data);
          toast.error(detail || t("hc_routesAppAdminUsers.importError"));
          return;
        }
        const result = (data?.result ?? [])[0];
        if (!result?.ok) {
          if (result?.duplicate) {
            // El usuario ya existe. Si el admin eligió un curso y el usuario
            // es estudiante, lo matriculamos al curso existente (operación
            // aditiva, no-destructiva) en vez de solo reportar "duplicado" —
            // misma intención que el import CSV: "ya existe pero no está en
            // el curso → matricularlo".
            const existingUserId = (result as { userId?: string })?.userId;
            if (existingUserId && enrollCourseId && editing.roles.includes("Estudiante")) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { error: enrollErr } = await (supabase as any)
                .from("course_enrollments")
                .upsert(
                  { course_id: enrollCourseId, user_id: existingUserId },
                  { onConflict: "course_id,user_id" },
                );
              if (!enrollErr) {
                void logEvent({
                  action: "enrollment.added",
                  category: "course",
                  actorRole: roles[0],
                  entityType: "course",
                  entityId: enrollCourseId,
                  metadata: { user_id: existingUserId, source: "user_create_dialog_existing" },
                });
                toast.success(
                  i18n.t("toast.routes_app_admin_users.existingUserEnrolled", {
                    defaultValue:
                      "El usuario ya existía; se matriculó al curso seleccionado.",
                  }),
                );
                setDialogOpen(false);
                setEditing(null);
                load();
                return;
              }
              // Si la matrícula falla, caemos al toast de duplicado de abajo.
            }
            toast.error(
              i18n.t("toast.routes_app_admin_users.createDuplicateEmail", {
                defaultValue:
                  'No se pudo crear: ya existe un usuario con el email "{{email}}"',
                email: editing.institutional_email,
              }),
            );
          } else {
            // `reason` ya viene en español del edge; `error` puede ser el
            // mensaje crudo en inglés del trigger de auth ("Database error
            // creating new user") → lo pasamos por friendlyError (cae al
            // fallback en español si no lo reconoce).
            toast.error(
              result?.reason ??
                friendlyError(
                  result?.error ? new Error(String(result.error)) : null,
                  t("hc_routesAppAdminUsers.userCreateError"),
                ),
            );
          }
          return;
        }
        // Asignación de tenant al nuevo profile:
        //   - SuperAdmin elige institución en el form (editing.tenant_id).
        //   - Admin: si editing.tenant_id viene null/vacío, se asigna a SU
        //     tenant (los Admin solo crean usuarios para su institución).
        //   - SuperAdmin con "Sin institución" + rol SuperAdmin: persiste
        //     `tenant_id = null` explícitamente para que el usuario nazca
        //     desligado del tenant default que asignó `handle_new_user`.
        //   - El trigger handle_new_user ya creó el profile con tenant
        //     default; ahora lo ajustamos.
        const newUserId = (result as { userId?: string })?.userId;
        const targetTenantId =
          editing.tenant_id || (isSuperAdminCaller ? null : myTenantIdRef.current);
        // Actualizamos cuando hay tenant válido O cuando el nuevo
        // usuario es SuperAdmin puro y se eligió "Sin institución"
        // (target === null intencional). Sin esta segunda rama el
        // usuario quedaba pegado al tenant default del trigger.
        const shouldAssignTenant =
          newUserId !== undefined &&
          (targetTenantId !== null || (isSuperAdminCaller && editing.roles.includes("SuperAdmin")));
        if (newUserId && shouldAssignTenant) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: tErr } = await (supabase as any)
            .from("profiles")
            .update({ tenant_id: targetTenantId })
            .eq("id", newUserId);
          if (tErr) {
            console.warn("[admin.users] tenant assign failed:", tErr.message);
            // No bloqueamos: el usuario quedó creado, solo le falta el tenant
            // correcto. Toast warning para que el admin lo arregle desde el edit.
            toast.warning(
              i18n.t("toast.routes_app_admin_users.tenantAssignFailed", {
                defaultValue:
                  "Usuario creado, pero no se pudo asignar a la institución. Edítalo y guarda de nuevo.",
              }),
            );
          }
        }
        // Inscripción inmediata al curso elegido (opcional). Solo para
        // estudiantes — para Admin/Docente no tiene sentido matricularlos
        // como alumnos en un curso. Best-effort: si falla (UNIQUE
        // violation, RLS, lo que sea), el usuario queda creado y el admin
        // lo matricula manualmente desde el curso.
        if (newUserId && enrollCourseId && editing.roles.includes("Estudiante")) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: enrollErr } = await (supabase as any)
            .from("course_enrollments")
            .insert({ course_id: enrollCourseId, user_id: newUserId });
          if (enrollErr) {
            console.warn("[admin.users] enrollment failed:", enrollErr.message);
            toast.warning(
              i18n.t("toast.routes_app_admin_users.enrollmentFailed", {
                defaultValue:
                  "Usuario creado, pero no se pudo inscribir al curso. Matricúlalo manualmente desde el curso.",
              }),
            );
          } else {
            void logEvent({
              action: "enrollment.added",
              category: "course",
              actorRole: roles[0],
              entityType: "course",
              entityId: enrollCourseId,
              metadata: { user_id: newUserId, source: "user_create_dialog" },
            });
          }
        }
        toast.success(
          i18n.t("toast.routes_app_admin_users.userCreated", {
            defaultValue: "Usuario creado correctamente",
          }),
        );
        void logEvent({
          action: "user.created",
          category: "user",
          actorRole: roles[0],
          entityType: "user",
          entityName: editing.full_name,
          metadata: { roles: editing.roles, email: editing.institutional_email },
        });
      }
      setDialogOpen(false);
      setEditing(null);
      load();
    } finally {
      setSavingUser(false);
    }
  };

  const remove = async (r: Row) => {
    const ok = await confirm({
      title: t("users.deleteTitle", { name: r.full_name }),
      description: t("users.deleteBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    // Delete via edge `admin-delete-user` que usa service_role para
    // borrar de `auth.users` — eso CASCADEA a `profiles` + `user_roles`
    // + todas las tablas con FK ON DELETE CASCADE a auth.users(id).
    // Antes hacíamos `delete from profiles` directo desde el cliente,
    // pero `auth.users` quedaba huérfana y al re-crear con el mismo
    // email `check_email_taken` reportaba colisión.
    const { data, error: edgeErr } = await supabase.functions.invoke("admin-delete-user", {
      body: { userId: r.id },
    });
    const respError = (data as { error?: string } | null)?.error;
    if (edgeErr || respError) {
      // El primer respError es el mensaje friendly que viene de la edge.
      // Si no llegó, traducimos el error técnico del transport con friendlyError.
      toast.error(respError ?? friendlyError(edgeErr, t("hc_routesAppAdminUsers.userDeleteError")));
      return;
    }
    toast.success(t("users.deletedToast"));
    void logEvent({
      action: "user.deleted",
      category: "user",
      actorRole: roles[0],
      severity: "warning",
      entityType: "user",
      entityId: r.id,
      entityName: r.full_name,
      metadata: { email: r.institutional_email },
    });
    load();
  };

  const exportUsersCsv = (): string => {
    const data = rows.map((r) => ({
      full_name: r.full_name,
      institutional_email: r.institutional_email,
      personal_email: r.personal_email ?? "",
      roles: r.roles.join("|"),
    }));
    return toCSV(data);
  };

  // Carga lazy de los cursos disponibles para el "curso por defecto" del
  // import masivo. Se dispara al abrir el dropdown de import por primera
  // vez. RLS limita a su tenant para Admin; el SuperAdmin sin override
  // ve cross-tenant pero ese flujo no aplica acá (el bulk import siempre
  // va al tenant del caller, no cross-tenant).
  const loadCoursesForBulkImport = async () => {
    // SuperAdmin con filtro de institución activo: ahora amarramos el
    // selector de "curso por defecto" al `tenantFilter`. Si el SA eligió
    // un tenant arriba, solo le mostramos los cursos de ESE tenant — no
    // tiene sentido ofrecer "Programación II" del tenant A cuando el
    // import va al tenant B. Para Admin normal, RLS ya acota; el filtro
    // no se renderiza así que tenantFilter queda en "all" y el query
    // funciona como antes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = (supabase as any)
      .from("courses")
      .select("id, name, period")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (isSuperAdminCaller && tenantFilter !== "all") {
      if (tenantFilter === "none") {
        // "Sin institución" — no hay cursos huérfanos de tenant. Vaciamos.
        setCoursesForBulkImport([]);
        setCoursesForBulkImportLoaded(true);
        return;
      }
      q = q.eq("tenant_id", tenantFilter);
    }
    const { data, error } = await q;
    if (!error) {
      setCoursesForBulkImport(
        (data ?? []) as Array<{ id: string; name: string; period: string | null }>,
      );
    }
    setCoursesForBulkImportLoaded(true);
  };

  // Re-load cuando cambia el tenantFilter (SuperAdmin) para que el
  // selector refleje los cursos del tenant elegido. Sin esto, el SA
  // cambia institución pero el selector sigue mostrando cursos del
  // tenant anterior (cached por `coursesForBulkImportLoaded`).
  useEffect(() => {
    setCoursesForBulkImportLoaded(false);
    setCoursesForBulkImport([]);
    setBulkImportCourseId("");
  }, [tenantFilter]);

  const handleImportRows = async (parsed: Record<string, string>[]): Promise<string> => {
    setImporting(true);
    try {
      // Inyectar el course_name del "curso por defecto" en las filas
      // que NO lo traen. Si el admin eligió un curso en el Select pre-
      // import, todas las filas del CSV sin `course_name` heredan ese
      // curso. Filas con `course_name` propio NO se tocan — gana lo
      // explícito del CSV. La edge resuelve el name → id case-insensitive
      // contra el tenant del caller; pasar el `name` (no el id) mantiene
      // el contrato actual y evita cambios server-side.
      const defaultCourse = bulkImportCourseId
        ? coursesForBulkImport.find((c) => c.id === bulkImportCourseId)
        : null;
      const rows = defaultCourse
        ? parsed.map((r) =>
            (r.course_name ?? "").trim().length > 0
              ? r
              : { ...r, course_name: defaultCourse.name },
          )
        : parsed;
      // Batching client-side: mandar TODAS las filas en UN solo invoke hacía
      // que, para lotes grandes (ej. ~90 estudiantes), el edge excediera su
      // wall-clock (~1.3s+ por usuario: createUser + round-trips + retries) y
      // la plataforma lo cortara a mitad → la UI no recibía `result` y parecía
      // "se demoró mucho y no cargó". Partimos en chunks chicos: cada request
      // cabe sobrado en el timeout, los resultados se ACUMULAN, y si un chunk
      // falla SEGUIMOS con los demás (los éxitos parciales sobreviven en vez de
      // perderse todo el lote). Además, lotes chicos reducen la presión sobre
      // el Auth admin API (causa del "Database error creating new user").
      type ImportResult = { email: string; ok: boolean; reason?: string; duplicate?: boolean };
      const CHUNK_SIZE = 15;
      const results: ImportResult[] = [];
      const progressId = toast.loading(
        i18n.t("toast.routes_app_admin_users.importProgress", {
          defaultValue: "Importando {{done}}/{{total}}…",
          done: 0,
          total: rows.length,
        }),
      );
      try {
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
          const chunk = rows.slice(i, i + CHUNK_SIZE);
          const { data, error } = await supabase.functions.invoke("bulk-import-users", {
            body: { rows: chunk },
          });
          if (error) {
            // El chunk falló (timeout/red): marcamos sus filas como error y
            // CONTINUAMOS — no abortamos el lote completo por un chunk.
            const detail = await extractEdgeError(error, data);
            for (const r of chunk) {
              results.push({
                email: (r.institutional_email as string) ?? "(sin email)",
                ok: false,
                reason: detail || t("hc_routesAppAdminUsers.bulkImportError"),
              });
            }
          } else {
            results.push(...((data?.result ?? []) as ImportResult[]));
          }
          toast.loading(
            i18n.t("toast.routes_app_admin_users.importProgress", {
              defaultValue: "Importando {{done}}/{{total}}…",
              done: Math.min(i + chunk.length, rows.length),
              total: rows.length,
            }),
            { id: progressId },
          );
        }
      } finally {
        toast.dismiss(progressId);
      }
      const ok = results.filter((r) => r.ok).length;
      const duplicates = results.filter((r) => !r.ok && r.duplicate);
      const otherFails = results.filter((r) => !r.ok && !r.duplicate);

      if (duplicates.length === 0 && otherFails.length === 0) {
        toast.success(
          i18n.t("toast.routes_app_admin_users.importSuccess", {
            defaultValue: "Importados correctamente: {{count}}",
            count: ok,
          }),
        );
      } else {
        toast.warning(
          i18n.t("toast.routes_app_admin_users.importPartial", {
            defaultValue:
              "Importados: {{ok}} · Duplicados: {{duplicates}} · Errores: {{errors}}",
            ok,
            duplicates: duplicates.length,
            errors: otherFails.length,
          }),
          {
            duration: 12000,
            description:
              duplicates.length > 0
                ? t("hc_routesAppAdminUsers.importAlreadyExisted", {
                    emails: duplicates
                      .slice(0, 5)
                      .map((d) => d.email)
                      .join(", "),
                  }) +
                  (duplicates.length > 5
                    ? t("hc_routesAppAdminUsers.importAndMore", {
                        count: duplicates.length - 5,
                      })
                    : "")
                : otherFails
                    .slice(0, 3)
                    .map((f) => `${f.email}: ${f.reason}`)
                    .join(" | "),
          },
        );
      }
      load();
      // Devolvemos "" para evitar el toast.success genérico de
      // ImportExportMenu — ya tosteamos success/warning con detalle.
      return "";
    } finally {
      setImporting(false);
    }
  };

  if (authLoading) return null;
  if (!isAdmin) return <p className="text-muted-foreground">{t("adminUsers.needsRole")}</p>;

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<UsersIcon className="h-6 w-6" />} title={t("adminUsers.pageTitle")} />
        <ErrorState
          message={t("adminUsers.loadError")}
          hint={loadError}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Overlay full-screen mientras se procesa el bulk import. Un
          import de 90 usuarios con throttle de 500ms tarda ~45-60s; sin
          este overlay el admin no veía nada después de cargar el CSV y
          creía que la app se trabó. El overlay bloquea clicks sobre el
          resto del UI para evitar acciones accidentales durante el
          proceso. */}
      {importing && (
        <LoadingOverlay
          title={t("adminUsers.importingTitle")}
          subtitle={t("adminUsers.importingSubtitle")}
        />
      )}
      <PageHeader
        icon={<UsersIcon className="h-6 w-6" />}
        title={t("adminUsers.pageTitle")}
        subtitle={
          search.trim()
            ? t("adminUsers.subtitleFiltered", { filtered: filteredRows.length, total: rows.length })
            : t("adminUsers.subtitleTotal", { total: rows.length })
        }
        actions={
          <>
            {/* Curso por defecto para el bulk import. Carga lazy al primer
                hover/focus para no traer 500 cursos al pintar la pantalla.
                Cuando el admin elige un curso acá, todas las filas del
                CSV importado sin `course_name` propio se enrollan al
                curso elegido. Las filas con `course_name` lo respetan. */}
            <Select
              value={bulkImportCourseId || "__none__"}
              onValueChange={(v) => setBulkImportCourseId(v === "__none__" ? "" : v)}
              onOpenChange={(open) => {
                if (open) void loadCoursesForBulkImport();
              }}
            >
              <SelectTrigger
                className="h-8 max-w-[200px] hidden md:flex text-xs"
                title={t("hc_routesAppAdminUsers.bulkImportCourseTitle")}
              >
                <SelectValue placeholder={t("adminUsers.bulkImportCoursePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("adminUsers.bulkImportCourseNone")}</SelectItem>
                {coursesForBulkImport.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.period ? ` · ${c.period}` : ""}
                  </SelectItem>
                ))}
                {coursesForBulkImportLoaded && coursesForBulkImport.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {t("adminUsers.bulkImportNoCourses")}
                  </div>
                )}
              </SelectContent>
            </Select>
            <ImportExportMenu
              resourceName="usuarios"
              tourId="bulk-import-users"
              templateCsv={USERS_TEMPLATE_CSV}
              onExport={exportUsersCsv}
              onImport={handleImportRows}
              disabled={importing}
            />
            <Button size="sm" onClick={openNew} data-tour-id="create-user">
              <Plus className="h-4 w-4 mr-1" />
              <span className="hidden xs:inline">{t("adminUsers.btnNewUser")}</span>
              <span className="xs:hidden">{t("adminUsers.btnNew")}</span>
            </Button>
          </>
        }
      />

      {/* Stats 4-card — patrón compartido (Videos, Cursos, etc.). Misma
          estructura para Admin y SuperAdmin; el SA ve los conteos del
          tenant filtrado (o todos si tenantFilter="all"). Aparece
          SIEMPRE — un 0 es informativo. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={UsersIcon} label={t("adminUsers.statTotal")} value={userStats.total} />
        <StatCard icon={GraduationCap} label={t("adminUsers.statStudents")} value={userStats.students} />
        <StatCard icon={Briefcase} label={t("adminUsers.statTeachers")} value={userStats.teachers} />
        <StatCard icon={ShieldCheck} label={t("adminUsers.statAdmins")} value={userStats.admins} />
      </div>

      {/* Licencias del tenant — el componente tiene su propio gate
          interno: se auto-oculta cuando es SuperAdmin sin override
          (modo cross-tenant). Cuando SuperAdmin tiene "Ver como X"
          activo, las cuotas SÍ se muestran (las de ese tenant elegido).
          Antes había un guard manual `{!isSuperAdminCaller && ...}`
          que escondía el card en ambos casos — quitado para que ahora
          aparezca correctamente cuando el SuperAdmin está overrideado. */}
      <TenantQuotaCard compact title={t("adminUsers.quotaCardTitle")} />

      <div className="flex flex-col sm:flex-row gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t("adminUsers.searchPlaceholder")}
          className="flex-1"
        />
        {/* Filtro por rol — siempre visible. Compone con search e
            institución (todos AND). El SuperAdmin se filtra del listado
            si el caller no tiene ese rol, para que un Admin común no
            vea una opción que su RLS nunca le mostraría. */}
        <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as "all" | AppRole)}>
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder={t("adminUsers.filterRolePlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("adminUsers.filterRoleAll")}</SelectItem>
            {ALL_ROLES.filter((r) => r !== "SuperAdmin" || isSuperAdminCaller).map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Filtro por estado de cuenta (activo/inactivo). */}
        <Select
          value={activeFilter}
          onValueChange={(v) => setActiveFilter(v as "all" | "active" | "inactive")}
        >
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("adminUsers.filterActiveAll", { defaultValue: "Activos e inactivos" })}</SelectItem>
            <SelectItem value="active">{t("adminUsers.filterActiveOnly", { defaultValue: "Solo activos" })}</SelectItem>
            <SelectItem value="inactive">{t("adminUsers.filterInactiveOnly", { defaultValue: "Solo inactivos" })}</SelectItem>
          </SelectContent>
        </Select>
        {/* Filtro de institución — visible para el SuperAdmin siempre que
            haya tenants cargados. Admin normal no lo ve. */}
        {showTenantUI && (
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            <SelectTrigger className="sm:w-64">
              <SelectValue placeholder={t("tenant.filterAllTenants")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("tenant.filterAllTenants")}</SelectItem>
              <SelectItem value="none">{t("adminUsers.filterTenantNone")}</SelectItem>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular={t("adminUsers.bulkDeleteEntity")}
        entityNamePlural={t("adminUsers.bulkDeleteEntityPlural")}
        extraActions={[
          {
            key: "bulk-password",
            label: t("adminUsers.bulkPasswordAction", { defaultValue: "Cambiar contraseña" }),
            icon: KeyRound,
            onClick: () => setBulkPasswordOpen(true),
          },
        ]}
      />

      <BulkPasswordDialog
        open={bulkPasswordOpen}
        onOpenChange={setBulkPasswordOpen}
        userIds={[...sel.selectedIds]}
        onDone={sel.clear}
      />

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4">
              <TableSkeleton rows={6} cols={5} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              {/* table-fixed: emails y nombres largos truncan. */}
              <Table fixed resizable>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <MultiSelectHeaderCheckbox state={sel} />
                    </TableHead>
                    <SortableHead sortKey="full_name" sort={sort} className="max-w-[260px]">
                      {t("users.fullName")}
                    </SortableHead>
                    <SortableHead
                      sortKey="institutional_email"
                      sort={sort}
                      className="hidden sm:table-cell max-w-[260px]"
                    >
                      {t("users.institutionalEmail")}
                    </SortableHead>
                    <SortableHead
                      sortKey="personal_email"
                      sort={sort}
                      className="hidden md:table-cell"
                    >
                      {t("users.personalEmail")}
                    </SortableHead>
                    <SortableHead sortKey="roles" sort={sort} className="hidden xs:table-cell w-40">
                      {t("common.roles")}
                    </SortableHead>
                    {/* Columna Institución solo visible al SuperAdmin.
                        Para el Admin normal es siempre su tenant
                        (redundante). */}
                    {showTenantUI && (
                      <SortableHead
                        sortKey="institution"
                        sort={sort}
                        className="hidden lg:table-cell w-40"
                      >
                        {t("adminUsers.colInstitution")}
                      </SortableHead>
                    )}
                    {/* Fecha de creación + último acceso. Ocultas hasta xl
                        porque la tabla ya carga muchas columnas; en mobile
                        no aportan vs nombre/email. Sin íconos para no
                        recargar la cabecera. */}
                    <SortableHead
                      sortKey="created_at"
                      sort={sort}
                      className="hidden xl:table-cell w-28"
                    >
                      {t("adminUsers.colCreated")}
                    </SortableHead>
                    <SortableHead
                      sortKey="last_sign_in_at"
                      sort={sort}
                      className="hidden xl:table-cell w-32"
                    >
                      {t("adminUsers.colLastAccess")}
                    </SortableHead>
                    <TableHead className="text-right w-20">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.length === 0 && (
                    <TableEmpty
                      colSpan={showTenantUI ? 9 : 8}
                      icon={UsersIcon}
                      text={
                        search.trim() && rows.length > 0
                          ? t("adminUsers.tableEmptyNoMatch")
                          : t("users.emptyTitle")
                      }
                      hint={
                        search.trim() && rows.length > 0
                          ? t("adminUsers.tableEmptyNoMatchHint")
                          : t("users.emptyHint")
                      }
                      action={
                        search.trim() && rows.length > 0 ? undefined : (
                          <Button size="sm" onClick={openNew}>
                            <Plus className="h-4 w-4 mr-1" />
                            {t("users.newUser")}
                          </Button>
                        )
                      }
                    />
                  )}
                  {pagination.paginatedItems.map((r) => (
                    <TableRow key={r.id} data-state={sel.isSelected(r.id) ? "selected" : undefined}>
                      <TableCell className="w-10">
                        <MultiSelectCheckbox id={r.id} state={sel} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex flex-col gap-1 min-w-0">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate" title={r.full_name}>
                              {r.full_name}
                            </span>
                            {r.is_active === false && (
                              <Badge variant="destructive" className="text-[10px] shrink-0">
                                {t("adminUsers.inactiveBadge", { defaultValue: "Inactivo" })}
                              </Badge>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground sm:hidden truncate">
                            {r.institutional_email}
                          </span>
                          <div className="sm:hidden">
                            <BadgeOverflow items={r.roles} max={2} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell
                        className="text-sm hidden sm:table-cell"
                        title={r.institutional_email}
                      >
                        <div className="truncate">{r.institutional_email}</div>
                      </TableCell>
                      <TableCell
                        className="text-sm text-muted-foreground hidden md:table-cell"
                        title={r.personal_email ?? undefined}
                      >
                        <div className="truncate">{r.personal_email ?? "—"}</div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <BadgeOverflow items={r.roles} max={2} />
                      </TableCell>
                      {showTenantUI && (
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                          {(() => {
                            const tn = tenants.find((t) => t.id === r.tenant_id)?.name ?? "—";
                            return (
                              <div className="truncate" title={tn}>
                                {tn}
                              </div>
                            );
                          })()}
                        </TableCell>
                      )}
                      <TableCell className="hidden xl:table-cell text-xs">
                        <DateCell value={r.created_at} variant="date" />
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-xs">
                        <DateCell value={r.last_sign_in_at} variant="datetime" />
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            {
                              label: t("common.edit"),
                              icon: Pencil,
                              onClick: () => openEdit(r),
                            },
                            // "Iniciar como" — autorización por jerarquía:
                            //   - SuperAdmin puede impersonar Admin/Docente/
                            //     Estudiante (NO a otro SuperAdmin).
                            //   - Admin común puede impersonar a Docente/
                            //     Estudiante de su tenant (NO a otro Admin).
                            //   - Docente: este grid es Admin-only, no aplica.
                            // El edge `admin-impersonate` re-valida server-side
                            // (defensa-en-profundidad). Acá solo escondemos lo
                            // que sabemos que va a fallar.
                            (() => {
                              if (r.roles.includes("SuperAdmin")) return null; // nadie impersona SA
                              // Admin común: no puede impersonar a otro Admin.
                              // SuperAdmin: sí puede (cross-tenant support).
                              if (r.roles.includes("Admin") && !isSuperAdminCaller) return null;
                              return {
                                label: t("adminUsers.actionImpersonate"),
                                icon: Eye,
                                hint: t("adminUsers.actionImpersonateHint", { name: r.full_name }),
                                onClick: () => void handleImpersonate(r),
                                // Pinta el ícono con el primary del tenant
                                // actual (ya aplicado al theme via
                                // TenantThemeProvider) — visualiza que la
                                // impersonación se queda dentro de la
                                // institución.
                                iconColor: "var(--brand-primary)",
                              };
                            })(),
                            // "Ver contraseña": solo cuando el usuario aún
                            // tiene pendiente cambiar la temporal (proxy de
                            // que existe la fila en admin_visible_passwords).
                            r.must_change_password
                              ? {
                                  label: t("adminUsers.actionViewPassword"),
                                  icon: KeyRound,
                                  hint: t("adminUsers.actionViewPasswordHint"),
                                  onClick: () => void openViewPassword(r),
                                }
                              : null,
                            // Desactivar / Reactivar cuenta. Oculto para: uno
                            // mismo (evita lockout), un SuperAdmin (nunca se
                            // desactiva), y un Admin cuando el caller NO es
                            // SuperAdmin (solo un SA desactiva Admins). La edge
                            // admin-set-user-active re-valida todo server-side.
                            (() => {
                              if (r.id === profile?.id) return null;
                              if (r.roles.includes("SuperAdmin")) return null;
                              if (r.roles.includes("Admin") && !isSuperAdminCaller) return null;
                              const inactive = r.is_active === false;
                              return {
                                label: inactive
                                  ? t("common.reactivate", { defaultValue: "Reactivar" })
                                  : t("common.deactivate", { defaultValue: "Desactivar" }),
                                icon: inactive ? UserCheck : UserX,
                                tone: inactive ? undefined : ("destructive" as const),
                                onClick: () => void handleSetActive(r, inactive),
                              };
                            })(),
                            {
                              label: t("common.delete"),
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
                              onClick: () => remove(r),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DataPagination state={pagination} entityNamePlural={t("adminUsers.paginationEntity")} />
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={userDirty.guardOpenChange(setDialogOpen)}>
        <DialogContent data-tour-id="dialog-user">
          <DialogHeader>
            <DialogTitle>{editing?.id ? t("adminUsers.dialogTitleEdit") : t("adminUsers.dialogTitleNew")}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label required>{t("adminUsers.fieldFullName")}</Label>
                <Input
                  value={editing.full_name}
                  onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                />
              </div>
              <div>
                <Label required>{t("adminUsers.fieldInstitutionalEmail")}</Label>
                <Input
                  type="email"
                  value={editing.institutional_email}
                  onChange={(e) => setEditing({ ...editing, institutional_email: e.target.value })}
                />
              </div>
              <div>
                <Label>{t("adminUsers.fieldPersonalEmail")}</Label>
                <Input
                  type="email"
                  value={editing.personal_email ?? ""}
                  onChange={(e) => setEditing({ ...editing, personal_email: e.target.value })}
                />
              </div>
              {!editing.id && (
                <div className="space-y-2">
                  <div>
                    <Label required>{t("adminUsers.fieldInitialPassword")}</Label>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={t("adminUsers.fieldPasswordPlaceholder")}
                        className="pr-9"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                        aria-label={showPassword ? t("adminUsers.pwdAriaHide") : t("adminUsers.pwdAriaShow")}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  {/* Toggle "pedir cambio en el primer login". Default ON
                      por seguridad — la contraseña inicial la conoce el
                      Admin que crea al usuario, no es ideal mantenerla.
                      OFF para cuentas de sistema/integraciones o cuando
                      el Admin coordina la contraseña offline. Cuando
                      OFF, NO se envía el correo de bienvenida con link
                      de definir contraseña (la edge lo omite). */}
                  <div className="flex items-start justify-between gap-3 rounded-md border p-2.5">
                    <div className="space-y-0.5 min-w-0">
                      <Label htmlFor="force-pwd-change" className="text-sm font-medium">
                        {t("adminUsers.forcePwdChangeLabel")}
                      </Label>
                      <p className="text-[11px] text-muted-foreground">
                        {forcePasswordChange
                          ? t("adminUsers.forcePwdChangeOnDesc")
                          : t("adminUsers.forcePwdChangeOffDesc")}
                      </p>
                    </div>
                    <Switch
                      id="force-pwd-change"
                      checked={forcePasswordChange}
                      onCheckedChange={setForcePasswordChange}
                    />
                  </div>
                </div>
              )}
              {editing.id && (
                <div>
                  <Label>
                    {t("adminUsers.fieldNewPassword")}{" "}
                    <HelpHint>{t("help.newPasswordLeaveEmpty")}</HelpHint>
                  </Label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t("adminUsers.fieldPasswordPlaceholder")}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                      aria-label={showPassword ? t("adminUsers.pwdAriaHide") : t("adminUsers.pwdAriaShow")}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}
              <div>
                <Label className="mb-2 block" required>
                  {t("adminUsers.fieldRoles")}
                </Label>
                <div className="space-y-1.5">
                  {ALL_ROLES
                    // Sólo SuperAdmin puede asignar/quitar el rol
                    // SuperAdmin a otro usuario. El edge function +
                    // RLS validan esto server-side; aquí ocultamos el
                    // checkbox para que un Admin común no vea siquiera
                    // la opción.
                    .filter((role) => role !== "SuperAdmin" || isSuperAdminCaller)
                    .map((role) => (
                      <label key={role} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={editing.roles.includes(role)}
                          onCheckedChange={(v) => {
                            setEditing({
                              ...editing,
                              roles: v
                                ? [...editing.roles, role]
                                : editing.roles.filter((x) => x !== role),
                            });
                          }}
                        />
                        {role}
                      </label>
                    ))}
                </div>
              </div>

              {/* Institución — solo SuperAdmin elige. El Admin normal
                  no ve este campo y el usuario nuevo se asigna automá-
                  ticamente a SU tenant. Para usuarios EXISTENTES, el
                  SuperAdmin también puede reasignar (sujeto al trigger
                  tg_check_profile_tenant_change que bloquea si el user
                  tiene cursos activos en el tenant viejo).
                  Opción extra "Sin institución" solo cuando el user
                  tiene rol SuperAdmin — un SuperAdmin puro opera
                  cross-tenant sin pertenecer a ninguna institución;
                  para otros roles esa opción produciría un usuario
                  huérfano sin RLS funcional. */}
              {isSuperAdminCaller && (
                <div>
                  <Label className="mb-2 block">{t("adminUsers.fieldInstitution")}</Label>
                  <Select
                    value={editing.tenant_id ?? "__none__"}
                    onValueChange={(v) =>
                      setEditing({ ...editing, tenant_id: v === "__none__" ? null : v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("adminUsers.fieldInstitutionPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {editing.roles.includes("SuperAdmin") && (
                        <SelectItem value="__none__">
                          {t("adminUsers.institutionNone")}
                        </SelectItem>
                      )}
                      {tenants.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t("adminUsers.institutionSADesc")}
                    {editing.roles.includes("SuperAdmin")
                      ? t("adminUsers.institutionSADescCrossTenant")
                      : t("adminUsers.institutionSADescDot")}
                    {editing.id &&
                      !editing.roles.includes("SuperAdmin") &&
                      t("adminUsers.institutionSADescChangeFail")}
                    {editing.id &&
                      editing.roles.includes("SuperAdmin") &&
                      t("adminUsers.institutionSADescSAFree")}
                  </p>
                </div>
              )}

              {/* Identidad estudiantil — solo visible cuando el usuario
                  tiene rol Estudiante. Todos los campos son opcionales
                  pero recomendados: alimentan actas, certificados con
                  datos oficiales y el roster del Acuerdo Pedagógico. */}
              {editing.roles.includes("Estudiante") && (
                <div className="rounded-md border p-3 space-y-3">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    {t("adminUsers.studentIdentityTitle")}
                    <HelpHint>{t("help.studentIdentityOfficialData")}</HelpHint>
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">{t("adminUsers.fieldStudentCode")}</Label>
                      <Input
                        value={editing.codigo ?? ""}
                        onChange={(e) => setEditing({ ...editing, codigo: e.target.value || null })}
                        placeholder={t("adminUsers.fieldStudentCodePlaceholder")}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">{t("adminUsers.fieldStudentCardCode")}</Label>
                      <Input
                        value={editing.student_code ?? ""}
                        onChange={(e) =>
                          setEditing({ ...editing, student_code: e.target.value || null })
                        }
                        placeholder={t("adminUsers.fieldStudentCardCodePlaceholder")}
                      />
                      {/* La unicidad es por tenant cuando se asigna (mig
                          20260822). Si queda vacío, no choca con nadie. */}
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {t("adminUsers.fieldStudentCardCodeHint")}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs">{t("adminUsers.fieldDocumento")}</Label>
                      <Input
                        value={editing.documento ?? ""}
                        onChange={(e) =>
                          setEditing({ ...editing, documento: e.target.value || null })
                        }
                        placeholder={t("adminUsers.fieldDocumentoPlaceholder")}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">{t("adminUsers.fieldCohorte")}</Label>
                      <Input
                        value={editing.cohorte ?? ""}
                        onChange={(e) =>
                          setEditing({ ...editing, cohorte: e.target.value || null })
                        }
                        placeholder={t("adminUsers.fieldCohortePlaceholder")}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">{t("adminUsers.fieldEstado")}</Label>
                      <Select
                        value={editing.estado ?? "__none__"}
                        onValueChange={(v) =>
                          setEditing({
                            ...editing,
                            estado: v === "__none__" ? null : (v as StudentEstado),
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("adminUsers.fieldEstadoPlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t("adminUsers.fieldEstadoNone")}</SelectItem>
                          {ESTADO_VALUES.map((v) => (
                            <SelectItem key={v} value={v}>
                              {t(`adminUsers.estado${v.charAt(0).toUpperCase() + v.slice(1)}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="sm:col-span-2">
                      <Label className="text-xs">{t("adminUsers.fieldPrograma")}</Label>
                      <Select
                        value={editing.programa_id ?? "__none__"}
                        onValueChange={(v) =>
                          setEditing({
                            ...editing,
                            programa_id: v === "__none__" ? null : v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("adminUsers.fieldProgramaPlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t("adminUsers.fieldProgramaNone")}</SelectItem>
                          {programs.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {/* Inscripción inmediata a curso — solo en modo CREAR
                        (no en edit: para reasignar cursos existentes ya
                        existe el grid de matrículas dentro del curso).
                        Opcional: si el admin no elige nada, el alumno
                        queda creado sin inscripción y el admin lo
                        matricula manualmente desde el curso. */}
                    {!editing.id && (
                      <div className="sm:col-span-2">
                        <Label className="text-xs">{t("adminUsers.fieldEnrollCourse")}</Label>
                        <Select
                          value={enrollCourseId ?? "__none__"}
                          onValueChange={(v) => setEnrollCourseId(v === "__none__" ? null : v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t("adminUsers.fieldEnrollCoursePlaceholder")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">{t("adminUsers.fieldEnrollCourseNone")}</SelectItem>
                            {filteredEnrollCourses.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                                {c.period ? ` · ${c.period}` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          {isSuperAdminCaller && !editing.tenant_id
                            ? t("adminUsers.enrollHintChooseTenant")
                            : filteredEnrollCourses.length === 0
                              ? t("adminUsers.enrollHintNoCourses")
                              : t("adminUsers.enrollHintAfterSave")}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={savingUser}>
              {t("common.cancel")}
            </Button>
            <Button onClick={saveProfile} disabled={savingUser}>
              {savingUser && <Spinner size="md" className="mr-1" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedItems}
        entityNameSingular={t("adminUsers.bulkDeleteEntity")}
        entityNamePlural={t("adminUsers.bulkDeleteEntityPlural")}
        extraWarning={t("adminUsers.bulkDeleteWarning")}
        onConfirm={handleBulkDelete}
      />

      {/* Ver contraseña temporal asignada (admin_visible_passwords). */}
      <Dialog
        open={!!viewPwUser}
        onOpenChange={(o) => {
          if (!o) {
            setViewPwUser(null);
            setViewPwValue(null);
            setViewPwReveal(false);
          }
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              {t("adminUsers.viewPwTitle")}
            </DialogTitle>
          </DialogHeader>
          {viewPwUser && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("adminUsers.viewPwDescPrefix")}{" "}
                <strong>{viewPwUser.full_name}</strong> ({viewPwUser.institutional_email}).{" "}
                {t("adminUsers.viewPwDescSuffix")}
              </p>
              {viewPwLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Spinner size="sm" /> {t("adminUsers.viewPwLoading")}
                </div>
              ) : viewPwValue ? (
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Input
                      readOnly
                      type={viewPwReveal ? "text" : "password"}
                      value={viewPwValue}
                      className="pr-9 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setViewPwReveal((v) => !v)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                      aria-label={viewPwReveal ? t("adminUsers.pwdAriaHide") : t("adminUsers.pwdAriaShow")}
                    >
                      {viewPwReveal ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void copyViewPassword()}
                    aria-label={t("adminUsers.pwdAriaCopy")}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                  {t("adminUsers.viewPwEmptyPrefix")} <strong>{t("common.edit")}</strong>{t("adminUsers.viewPwEmptySuffix")}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setViewPwUser(null)}>
              {t("common.close", { defaultValue: "Cerrar" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
