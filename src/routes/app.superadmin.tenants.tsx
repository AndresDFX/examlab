/**
 * SuperAdmin: gestión de tenants (instituciones).
 *
 * Solo accesible para usuarios con rol SuperAdmin (Fase 1). Permite:
 *   - Crear nueva institución (slug, name, branding básico).
 *   - Editar campos de una institución existente.
 *   - Activar / pausar (is_active toggle).
 *   - "Ver como" — guarda override en localStorage y refresca useTenant.
 *
 * El SQL ya bloquea INSERT/UPDATE/DELETE a no-SuperAdmin via RLS de
 * la tabla tenants — así que aunque un user normal acceda a esta ruta
 * por manipulación de URL, RLS rechaza las operaciones.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { resizeImageForLogo } from "@/modules/tenants/image-resize";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { HexColorInput } from "@/components/ui/hex-color-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { SectionLoader } from "@/components/ui/loaders";
import { Spinner } from "@/components/ui/spinner";
import { usePagination } from "@/hooks/use-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SortableHead,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Building2,
  Plus,
  Eye,
  Pencil,
  Power,
  Save,
  Upload,
  Trash2,
  UserPlus,
  LogIn,
  Copy,
  KeyRound,
  Mail,
  CreditCard,
} from "lucide-react";
import { TenantEmailSettingsDialog } from "@/modules/superadmin/TenantEmailSettingsDialog";
import { TenantBillingDialog } from "@/modules/superadmin/TenantBillingDialog";
import { startImpersonate } from "@/modules/admin/impersonation";
import { AssignUsersToTenantDialog } from "@/modules/superadmin/AssignUsersToTenantDialog";
import { isValidTenantSlug, slugifyTenantName } from "@/modules/tenants/tenant";
import { tenantUrlForSlug } from "@/modules/tenants/subdomain";
import { TenantBrandPreview } from "@/modules/tenants/TenantBrandPreview";
import { useTheme } from "@/hooks/use-theme";
import { setTenantOverride } from "@/modules/tenants/use-tenant";
import type { Tenant } from "@/modules/tenants/tenant";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/app/superadmin/tenants")({
  component: SuperAdminTenantsPage,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Fila enriquecida del RPC superadmin_tenant_overview (licencias, IA, plan,
 *  facturación) — para mostrar "de un vistazo" por institución en el grid. */
interface TenantOverview {
  tenant_id: string;
  plan_tier: string;
  ai_mode: string;
  has_own_ai_key: boolean;
  admins: number;
  teachers: number;
  students: number;
  max_admins: number | null;
  max_teachers: number | null;
  max_students: number | null;
  storage_bytes: number | null;
  storage_quota_mb: number | null;
  subscription_status: string;
  days_left: number | null;
}

/** Formatea bytes a una unidad legible (es-CO). */
const fmtBytes = (n: number | null): string => {
  if (n == null || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(".", ",")} MB`;
  return `${(mb / 1024).toFixed(2).replace(".", ",")} GB`;
};

/**
 * Copia al portapapeles avisando por toast — éxito Y falla.
 * `navigator.clipboard.writeText` rechaza cuando el permiso está denegado
 * o el contexto no es seguro; los `void navigator.clipboard...` previos
 * mostraban "Copiado" igual y el SuperAdmin pegaba una credencial vieja.
 */
async function copyToClipboard(text: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
  } catch (e) {
    toast.error(
      friendlyError(
        e,
        i18n.t("common.copyFailed", {
          defaultValue: "No se pudo copiar al portapapeles",
        }),
      ),
    );
  }
}

function SuperAdminTenantsPage() {
  const { t: tl } = useTranslation();
  const { roles, loading: authLoading } = useAuth();
  const confirm = useConfirm();
  const isSuper = roles.includes("SuperAdmin");

  const [tenants, setTenants] = useState<Tenant[]>([]);
  // Enriquecimiento comercial (licencias/IA/plan/facturación) por tenant_id,
  // del RPC superadmin_tenant_overview (SA-only). Se muestra en columnas extra.
  const [overview, setOverview] = useState<Record<string, TenantOverview>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [form, setForm] = useState({
    slug: "",
    name: "",
    logo_url: "",
    logo_path: "",
    primary_color: "",
    secondary_color: "",
    text_color: "",
    icon_color: "",
    email_domain: "",
    // Cuotas. "" = ilimitado (se persiste como NULL). Cualquier número
    // entero >= 0 es el tope.
    max_admins: "" as string,
    max_teachers: "" as string,
    max_students: "" as string,
  });
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  // Guard "cambios sin guardar" para el dialog crear/editar institución. El
  // form ya es UN objeto (`form`), así que se pasa directo al hook.
  const dirty = useDirtyDialog(dialogOpen, form);
  // Credenciales del usuario de prueba recién creado. Se muestran UNA
  // SOLA VEZ en un dialog separado tras crear la institución (la edge
  // function `provision-tenant-test-user` no las persiste en plaintext).
  // null = sin dialog abierto.
  const [testUserCreds, setTestUserCreds] = useState<{
    email: string;
    password: string;
    full_name: string;
    roles: string[];
    tenant_name: string;
  } | null>(null);
  const logoFileInputRef = useRef<HTMLInputElement>(null);
  // En modo CREAR no existe aún `tenant.id`, así que no se puede subir al
  // bucket todavía (el path es `${tenantId}/logo.ext`). Guardamos el File
  // en memoria + una preview con URL.createObjectURL, y el upload real se
  // hace dentro de `save()` después del INSERT, usando el id recién creado.
  const [pendingLogoFile, setPendingLogoFile] = useState<File | null>(null);
  const [pendingLogoPreview, setPendingLogoPreview] = useState<string | null>(null);
  /** Host actual, para deducir la dirección que le tocará a la institución.
   *  Se lee POST-MOUNT y no en el initializer: leer `window.location` en el
   *  primer render rompe la hidratación (React #418, ver CLAUDE.md). Mientras
   *  es null la vista previa no promete ninguna dirección. */
  const [browserLoc, setBrowserLoc] = useState<{
    hostname: string;
    protocol: string;
    port: string;
  } | null>(null);
  useEffect(() => {
    setBrowserLoc({
      hostname: window.location.hostname,
      protocol: window.location.protocol,
      port: window.location.port,
    });
  }, []);
  const { resolvedTheme } = useTheme();
  /** Dirección que le tocará al slug que se está escribiendo. */
  const previewUrl = useMemo(
    () => tenantUrlForSlug(form.slug, browserLoc),
    [form.slug, browserLoc],
  );
  /** Al EDITAR: la dirección que la institución tiene HOY. Sirve para advertir
   *  que cambiar el slug rompe los enlaces ya repartidos. */
  const previewUrlActual = useMemo(
    () => (editing ? tenantUrlForSlug(editing.slug, browserLoc) : null),
    [editing, browserLoc],
  );
  /** Estado del dialog 'Gestionar usuarios' — el SuperAdmin decide qué
   *  usuarios pertenecen a este tenant (marca para agregar, desmarca
   *  para quitar). tenant=null = cerrado. */
  const [assignUsersTenant, setAssignUsersTenant] = useState<Tenant | null>(null);
  const [emailTenant, setEmailTenant] = useState<Tenant | null>(null);
  const [billingTenant, setBillingTenant] = useState<Tenant | null>(null);
  /** Id del tenant con una acción de fila en vuelo (pausar/reactivar,
   *  eliminar, impersonar). Sirve para dos cosas: (1) serializar esas
   *  acciones — los handlers cortan ante CUALQUIER fila en vuelo, así que
   *  el `disabled` del menú es global (`rowBusy !== null`), no por fila:
   *  con `=== t.id` las demás filas quedaban clickeables y el handler
   *  retornaba sin feedback, y (2) alimentar el banner `busyNotice`. Estas operaciones son largas (el borrado
   *  cascadea a 8 entidades; impersonar hace 2 queries + reemplazo de
   *  sesión) y sin feedback parecían "no hacer nada". */
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [busyNotice, setBusyNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    // Filtramos las eliminadas (deleted_at IS NOT NULL) — viven en la
    // papelera (/app/trash) hasta su purga a 30d. El SuperAdmin las
    // restaura desde allí cuando hace falta.
    const { data, error } = await db
      .from("tenants")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (error) {
      setLoadError(friendlyError(error, tl("hc_routesAppSuperadminTenants.errLoadTenants")));
      setTenants([]);
    } else {
      setTenants((data ?? []) as Tenant[]);
    }
    // Enriquecimiento comercial en UN solo RPC (evita N+1). Best-effort: si
    // falla (ej. migración aún no publicada), el grid sigue mostrando lo básico.
    try {
      const { data: ov } = await db.rpc("superadmin_tenant_overview");
      const map: Record<string, TenantOverview> = {};
      for (const r of (ov ?? []) as TenantOverview[]) map[r.tenant_id] = r;
      setOverview(map);
    } catch {
      /* migración no publicada todavía — sin enriquecimiento */
    }
    setLoading(false);
  };

  useEffect(() => {
    if (authLoading || !isSuper) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isSuper]);

  // Búsqueda (nombre / slug / dominio de email) + filtro de estado
  // (activa / pausada) — patrón estándar de los grids de la app
  // (SearchInput + Select). Flujo obligatorio: filtrar → ORDENAR → paginar
  // (sort y pagination operan sobre `filtered`).
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let result = tenants;
    if (statusFilter !== "all") {
      const wantActive = statusFilter === "active";
      result = result.filter((t) => !!t.is_active === wantActive);
    }
    if (q) {
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.slug.toLowerCase().includes(q) ||
          (t.email_domain ?? "").toLowerCase().includes(q),
      );
    }
    return result;
  }, [tenants, search, statusFilter]);

  // Orden por columna (click en el encabezado alterna asc/desc). Va ENTRE
  // el listado filtrado y la paginación: cargar → filtrar → ordenar → paginar.
  const sort = useTableSort(filtered, {
    columns: {
      name: (r) => r.name,
      slug: (r) => r.slug,
      email_domain: (r) => r.email_domain,
      status: (r) => r.is_active,
    },
    defaultSort: { key: "name", dir: "asc" },
    storageKey: "examlab_sort:superadmin_tenants",
  });

  // Paginación client-side sobre el listado filtrado + ordenado. El resetKey
  // incluye la búsqueda y el filtro de estado para volver a la página 1 al
  // cambiar cualquiera de los dos.
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:superadmin_tenants",
    resetKey: `${search}|${statusFilter}|${sort.resetKey}`,
  });

  // Gate de rol — los no-SuperAdmin redirigen al dashboard.
  if (authLoading) return <SectionLoader text={tl("superadminTenants.loadingText")} />;
  if (!isSuper) {
    return <Navigate to="/app" />;
  }

  // Libera el blob URL del archivo pendiente. Si no se libera, el browser
  // mantiene el File vivo en memoria hasta el unload del tab.
  const clearPendingLogo = () => {
    if (pendingLogoPreview) URL.revokeObjectURL(pendingLogoPreview);
    setPendingLogoFile(null);
    setPendingLogoPreview(null);
  };

  const openCreate = () => {
    setEditing(null);
    clearPendingLogo();
    setForm({
      slug: "",
      name: "",
      logo_url: "",
      logo_path: "",
      primary_color: "",
      secondary_color: "",
      text_color: "",
      icon_color: "",
      email_domain: "",
      max_admins: "",
      max_teachers: "",
      max_students: "",
    });
    setDialogOpen(true);
  };

  const openEdit = (t: Tenant) => {
    setEditing(t);
    setForm({
      slug: t.slug,
      name: t.name,
      logo_url: t.logo_url ?? "",
      logo_path: t.logo_path ?? "",
      primary_color: t.primary_color ?? "",
      secondary_color: t.secondary_color ?? "",
      // text_color / icon_color: las columnas se agregaron en mig
      // 20260706000000; tipos generados de Supabase aún no las exponen.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text_color: ((t as any).text_color as string | null) ?? "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icon_color: ((t as any).icon_color as string | null) ?? "",
      email_domain: t.email_domain ?? "",
      max_admins: t.max_admins == null ? "" : String(t.max_admins),
      max_teachers: t.max_teachers == null ? "" : String(t.max_teachers),
      max_students: t.max_students == null ? "" : String(t.max_students),
    });
    setDialogOpen(true);
  };

  /** Duplicar institución: abre el form de CREACIÓN (editing=null) pre-llenado
   *  con el BRANDING (colores) y las CUOTAS del tenant origen, como plantilla
   *  para montar una institución nueva con el mismo look & feel y los mismos
   *  topes. Los campos de IDENTIDAD única quedan en blanco —slug, nombre, logo
   *  y dominio de correo— para que el SuperAdmin los complete (el slug/nombre
   *  son únicos; el logo vive en el folder del tenant origen y no se reusa).
   *  No se crea nada hasta guardar: la institución nueva pasa por el flujo
   *  normal con su trigger de provisión de defaults. */
  const duplicate = (t: Tenant) => {
    setEditing(null);
    clearPendingLogo();
    setForm({
      slug: "",
      name: "",
      logo_url: "",
      logo_path: "",
      primary_color: t.primary_color ?? "",
      secondary_color: t.secondary_color ?? "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text_color: ((t as any).text_color as string | null) ?? "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icon_color: ((t as any).icon_color as string | null) ?? "",
      email_domain: "",
      max_admins: t.max_admins == null ? "" : String(t.max_admins),
      max_teachers: t.max_teachers == null ? "" : String(t.max_teachers),
      max_students: t.max_students == null ? "" : String(t.max_students),
    });
    setDialogOpen(true);
  };

  /**
   * SuperAdmin sube el logo de CUALQUIER institución. La RLS del bucket
   * permite a SuperAdmin escribir en `<tenant_id>/...` independiente del
   * `current_tenant_id()` del caller. Solo aplica en edit (necesitamos
   * `editing.id` para construir el path).
   */
  /** Valida tipo + tamaño. Devuelve null si inválido (con toast) o el
   *  mismo archivo si es válido. Compartido por modos crear y editar. */
  const validateLogoFile = (file: File): File | null => {
    const validTypes = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
    if (!validTypes.includes(file.type)) {
      toast.error(
        i18n.t("superadminTenants.logoFormatUnsupported", {
          defaultValue: "Formato no soportado. Usa PNG, JPG, SVG o WebP.",
        }),
      );
      return null;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error(
        i18n.t("superadminTenants.logoTooLarge", {
          defaultValue: "El logo no puede pesar más de 2 MB.",
        }),
      );
      return null;
    }
    return file;
  };

  /** Sube un File al bucket `tenant-logos` con path
   *  `${tenantId}/<slug-de-institucion>-logo.<ext>`. El folder DEBE ser
   *  el UUID (lo exige la RLS via `(storage.foldername(name))[1]`); el
   *  filename usa el nombre de la institución slugificado para que sea
   *  reconocible al inspeccionar el bucket / al descargar el archivo
   *  directo. Aplica resize antes. */
  const uploadLogoToBucket = async (file: File, tenantId: string): Promise<string | null> => {
    const { file: finalFile, resized, originalSize, finalSize } = await resizeImageForLogo(file);
    const ext =
      finalFile.type === "image/png"
        ? "png"
        : finalFile.type === "image/jpeg"
          ? "jpg"
          : finalFile.type === "image/svg+xml"
            ? "svg"
            : "webp";
    const slug = slugifyTenantName(form.name);
    const path = `${tenantId}/${slug}-logo.${ext}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase.storage as any)
      .from("tenant-logos")
      .upload(path, finalFile, { upsert: true, contentType: finalFile.type });
    if (upErr) {
      toast.error(friendlyError(upErr, tl("hc_routesAppSuperadminTenants.errUploadLogo")));
      return null;
    }
    if (resized) {
      const kbBefore = Math.round(originalSize / 1024);
      const kbAfter = Math.round(finalSize / 1024);
      toast.success(
        i18n.t("superadminTenants.logoUploadedOptimized", {
          defaultValue: "Logo subido (optimizado: {{before}} KB → {{after}} KB).",
          before: kbBefore,
          after: kbAfter,
        }),
      );
    }
    return path;
  };

  /**
   * Handler del input file. En MODO EDITAR sube inmediatamente al bucket
   * (ya hay `editing.id`). En MODO CREAR no hay tenant todavía, así que
   * solo validamos + stasheamos el File con una preview local — el upload
   * real lo hace `save()` después del INSERT del tenant.
   */
  const uploadLogo = async (file: File) => {
    const valid = validateLogoFile(file);
    if (!valid) return;

    if (!editing) {
      // Modo crear: stash + preview local.
      if (pendingLogoPreview) URL.revokeObjectURL(pendingLogoPreview);
      const preview = URL.createObjectURL(valid);
      setPendingLogoFile(valid);
      setPendingLogoPreview(preview);
      setForm((p) => ({ ...p, logo_url: "" }));
      if (logoFileInputRef.current) logoFileInputRef.current.value = "";
      toast.success(
        i18n.t("superadminTenants.logoReady", {
          defaultValue: "Logo listo. Se subirá al guardar la institución.",
        }),
      );
      return;
    }

    // Modo editar: subimos al toque al bucket usando editing.id.
    if (uploadingLogo) return; // anti doble-submit
    setUploadingLogo(true);
    try {
      const path = await uploadLogoToBucket(valid, editing.id);
      if (path) {
        setForm((p) => ({ ...p, logo_path: path, logo_url: "" }));
        toast.success(
          i18n.t("superadminTenants.logoUploadedRememberSave", {
            defaultValue: "Logo subido. Recuerda 'Guardar' para aplicarlo.",
          }),
        );
      }
    } catch (e) {
      // El resize (canvas) puede lanzar con imágenes corruptas: sin este
      // catch la promesa quedaba rechazada sin feedback y el usuario veía
      // el botón volver a "Subir logo" como si nada hubiera pasado.
      toast.error(friendlyError(e, tl("hc_routesAppSuperadminTenants.errUploadLogo")));
    } finally {
      setUploadingLogo(false);
      if (logoFileInputRef.current) logoFileInputRef.current.value = "";
    }
  };

  const removeLogo = () => {
    setForm((p) => ({ ...p, logo_path: "", logo_url: "" }));
    clearPendingLogo();
    toast.info(
      i18n.t("superadminTenants.logoRemoved", {
        defaultValue: "Logo removido.",
      }),
    );
  };

  const save = async () => {
    if (saving) return; // anti doble-submit (Enter repetido / doble click)
    if (!form.slug || !form.name) {
      toast.error(
        i18n.t("superadminTenants.slugAndNameRequired", {
          defaultValue: "Slug y nombre son obligatorios.",
        }),
      );
      return;
    }
    if (!isValidTenantSlug(form.slug)) {
      toast.error(
        i18n.t("superadminTenants.slugInvalid", {
          defaultValue:
            "Slug inválido: usa minúsculas, números y guiones (3-50 chars). Ej: 'sena-bogota'.",
        }),
      );
      return;
    }
    setSaving(true);
    try {
      await persistTenant();
    } catch (e) {
      // Cualquier excepción inesperada (resize del logo, red caída al
      // invocar la edge) tiene que salir por toast: sin este catch el
      // `finally` no corría y el botón "Guardar" quedaba bloqueado.
      toast.error(friendlyError(e, tl("hc_routesAppSuperadminTenants.errSave")));
    } finally {
      setSaving(false);
    }
  };

  /** Cuerpo real del guardado (INSERT/UPDATE + logo pendiente + provisión
   *  del usuario de prueba). El flag `saving` — spinner del botón y
   *  anti doble-submit — lo administra `save()`, que además atrapa
   *  cualquier excepción y siempre lo baja en su `finally`. */
  const persistTenant = async () => {
    // Cuotas: "" → null (ilimitado). Cualquier otro → parseInt; rechazo
    // si no es entero >= 0.
    const parseQuota = (raw: string, label: string): number | null | undefined => {
      const v = raw.trim();
      if (!v) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        toast.error(
          i18n.t("superadminTenants.quotaInvalid", {
            defaultValue:
              "Cuota inválida para {{label}}. Debe ser entero ≥ 0 (o vacío = ilimitado).",
            label,
          }),
        );
        return undefined; // sentinel = abort
      }
      return n;
    };
    const maxAdmins = parseQuota(form.max_admins, tl("hc_routesAppSuperadminTenants.quotaLabelAdmins"));
    const maxTeachers = parseQuota(form.max_teachers, tl("hc_routesAppSuperadminTenants.quotaLabelTeachers"));
    const maxStudents = parseQuota(form.max_students, tl("hc_routesAppSuperadminTenants.quotaLabelStudents"));
    if (maxAdmins === undefined || maxTeachers === undefined || maxStudents === undefined) {
      return;
    }

    const payload = {
      slug: form.slug.trim(),
      name: form.name.trim(),
      logo_url: form.logo_url.trim() || null,
      logo_path: form.logo_path.trim() || null,
      primary_color: form.primary_color.trim() || null,
      secondary_color: form.secondary_color.trim() || null,
      text_color: form.text_color.trim() || null,
      icon_color: form.icon_color.trim() || null,
      email_domain: form.email_domain.trim().toLowerCase() || null,
      max_admins: maxAdmins,
      max_teachers: maxTeachers,
      max_students: maxStudents,
    };
    if (editing) {
      const { error } = await db.from("tenants").update(payload).eq("id", editing.id);
      if (error) {
        toast.error(friendlyError(error, tl("hc_routesAppSuperadminTenants.errSave")));
        return;
      }
      toast.success(
        i18n.t("superadminTenants.tenantUpdated", {
          defaultValue: "Institución actualizada",
        }),
      );
    } else {
      // Modo crear: INSERT y nos quedamos con el id retornado, porque si
      // hay un `pendingLogoFile` necesitamos subirlo al bucket y luego
      // hacer un UPDATE con su path.
      const { data: created, error } = await db
        .from("tenants")
        .insert(payload)
        .select("id")
        .single();
      if (error) {
        toast.error(friendlyError(error, tl("hc_routesAppSuperadminTenants.errCreate")));
        return;
      }

      if (pendingLogoFile && created?.id) {
        const path = await uploadLogoToBucket(pendingLogoFile, created.id as string);
        if (path) {
          const { error: updErr } = await db
            .from("tenants")
            .update({ logo_path: path, logo_url: null })
            .eq("id", created.id);
          if (updErr) {
            // No abortamos: el tenant está creado, solo falló asociar el
            // logo. El SuperAdmin puede reintentar desde "Editar".
            toast.error(
              friendlyError(updErr, tl("hc_routesAppSuperadminTenants.errLogoAssociate")),
            );
          }
        }
        clearPendingLogo();
      }
      toast.success(
        i18n.t("superadminTenants.tenantCreated", {
          defaultValue: "Institución creada",
        }),
      );

      // Provisionar usuario de prueba (Admin + Docente + Estudiante).
      // Es best-effort: si falla, el tenant queda creado igual y el
      // SuperAdmin puede crear el user manualmente desde /app/admin/users.
      // Mostramos las credenciales en un dialog separado (la password
      // solo se entrega una vez — no se guarda en plaintext).
      if (created?.id) {
        try {
          const { data: provData, error: provErr } = await supabase.functions.invoke(
            "provision-tenant-test-user",
            {
              body: {
                tenant_id: created.id,
                tenant_name: form.name.trim(),
                tenant_slug: form.slug.trim(),
              },
            },
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = provData as any;
          if (provErr || !data?.ok) {
            const msg = data?.error || friendlyError(provErr, tl("hc_routesAppSuperadminTenants.unknownError"));
            toast.error(
              i18n.t("superadminTenants.testUserCreationFailed", {
                defaultValue:
                  "Institución creada, pero falló crear usuario de prueba: {{error}}",
                error: msg,
              }),
              { duration: 8000 },
            );
          } else {
            setTestUserCreds({
              email: data.email,
              password: data.password,
              full_name: data.full_name,
              roles: data.roles ?? [],
              tenant_name: form.name.trim(),
            });
          }
        } catch (e) {
          toast.error(
            i18n.t("superadminTenants.testUserCreationFailed", {
              defaultValue:
                "Institución creada, pero falló crear usuario de prueba: {{error}}",
              error: friendlyError(e),
            }),
            { duration: 8000 },
          );
        }

        // Publicar la dirección propia de la institución
        // (`<slug>.examlab.workers.dev`). En workers.dev cada institución es un
        // Worker aparte, y el workflow que los publica no se entera solo de que
        // se creó una: sin este disparo, el enlace da 404 hasta el próximo push.
        //
        // Best-effort A PROPÓSITO, y sin `await` bloqueante en el camino feliz:
        // la institución YA está creada y sus usuarios entran igual por
        // `app.examlab.workers.dev` eligiéndola en el selector. Lo que falta
        // mientras tanto es la dirección propia, no el acceso — así que un fallo
        // acá informa, no revierte nada.
        //
        // Desaparece con dominio propio: un DNS comodín cubre cualquier
        // institución sin desplegar (ver docs/subdominios-cloudflare.md).
        void (async () => {
          try {
            const { data: depData, error: depErr } = await supabase.functions.invoke(
              "trigger-cloudflare-deploy",
              { body: { reason: `Institución creada: ${form.slug.trim()}` } },
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ok = (depData as any)?.ok === true;
            if (depErr || !ok) {
              toast.warning(
                i18n.t("superadminTenants.deployTriggerFailed", {
                  defaultValue:
                    "La institución quedó creada y ya se puede usar desde el selector, pero no se pudo publicar su dirección propia. Publicala a mano desde GitHub → Actions → Deploy a Cloudflare.",
                }),
                { duration: 12000 },
              );
            } else {
              toast.info(
                i18n.t("superadminTenants.deployTriggered", {
                  defaultValue:
                    "Publicando la dirección de la institución. Queda disponible en unos minutos.",
                }),
                { duration: 8000 },
              );
            }
          } catch {
            toast.warning(
              i18n.t("superadminTenants.deployTriggerFailed", {
                defaultValue:
                  "La institución quedó creada y ya se puede usar desde el selector, pero no se pudo publicar su dirección propia. Publicala a mano desde GitHub → Actions → Deploy a Cloudflare.",
              }),
              { duration: 12000 },
            );
          }
        })();
      }
    }
    setDialogOpen(false);
    await load();
  };

  const toggleActive = async (t: Tenant) => {
    const willDeactivate = t.is_active;
    if (willDeactivate) {
      const ok = await confirm({
        title: i18n.t("superadminTenants.pauseConfirmTitle", { name: t.name }),
        description: i18n.t("superadminTenants.pauseConfirmDesc"),
        confirmLabel: i18n.t("superadminTenants.pauseConfirmLabel"),
        tone: "warning",
      });
      if (!ok) return;
    }
    // El guard va DESPUÉS del confirm: es anti doble-submit del propio update,
    // no un motivo para negarle el diálogo al usuario. El bloqueo previo lo
    // hace el `disabled` GLOBAL del menú (`rowBusy !== null`), coherente con
    // que este guard corte ante CUALQUIER fila en vuelo.
    if (rowBusy) return;
    setRowBusy(t.id);
    setBusyNotice(
      willDeactivate
        ? i18n.t("superadminTenants.pausingNotice", {
            defaultValue: "Pausando {{name}}…",
            name: t.name,
          })
        : i18n.t("superadminTenants.reactivatingNotice", {
            defaultValue: "Reactivando {{name}}…",
            name: t.name,
          }),
    );
    try {
      const { error } = await db.from("tenants").update({ is_active: !t.is_active }).eq("id", t.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(willDeactivate ? i18n.t("superadminTenants.pausedToast") : i18n.t("superadminTenants.reactivatedToast"));
      await load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setRowBusy(null);
      setBusyNotice(null);
    }
  };

  // "Ver como X": setea el override en localStorage. `useTenant`
  // detecta el CustomEvent y re-fetch; el banner azul
  // `TenantOverrideBanner` muestra "Viendo como X". NO hace hard
  // reload — la UI se actualiza in-place. Toast informativo.
  const viewAs = (t: Tenant) => {
    setTenantOverride(t.slug);
    toast.success(
      i18n.t("superadminTenants.viewingAs", {
        defaultValue: "Viendo como: {{name}}",
        name: t.name,
      }),
    );
  };

  // Limpia el override → modo cross-tenant. Mismo update in-place.
  const clearViewAs = () => {
    setTenantOverride(null);
    toast.success(
      i18n.t("superadminTenants.backToCrossTenant", {
        defaultValue: "Volviste a la vista de plataforma",
      }),
    );
  };

  /**
   * Soft-delete cascadeado: marca el tenant como eliminado + cascadea a
   * las 8 entidades trashables (cursos, exámenes, talleres, proyectos,
   * sesiones, pizarras, contenidos, polls) con el mismo timestamp.
   * Aparece en /app/trash con 30d para revertir vía "Restaurar".
   *
   * Los profiles del tenant NO se eliminan — quedan sin acceso porque
   * el Select de institución en /auth filtra deleted_at IS NULL. Al
   * restaurar el tenant, vuelven a tener acceso normal.
   */
  const softDeleteTenantHandler = async (t: Tenant) => {
    const ok = await confirm({
      title: i18n.t("superadminTenants.deleteConfirmTitle", { name: t.name }),
      description: i18n.t("superadminTenants.deleteConfirmDesc"),
      confirmLabel: i18n.t("superadminTenants.deleteConfirmLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    // Guard DESPUÉS del confirm. Antes estaba arriba y, como corta ante
    // CUALQUIER fila en vuelo, mientras el borrado del tenant A cascadeaba
    // (varios segundos) el "Eliminar" del tenant B no abría ni el diálogo.
    if (rowBusy) return;
    // El RPC cascadea a las 8 entidades trashables del tenant: en
    // instituciones con datos tarda varios segundos. Sin el banner + el
    // menú deshabilitado, el SuperAdmin creía que el click no había
    // registrado y volvía a intentarlo.
    setRowBusy(t.id);
    setBusyNotice(
      i18n.t("superadminTenants.deletingNotice", {
        defaultValue: "Enviando {{name}} a la papelera (incluye sus cursos y contenidos)…",
        name: t.name,
      }),
    );
    try {
      const { error } = await db.rpc("soft_delete_tenant", { _tenant_id: t.id });
      if (error) {
        toast.error(friendlyError(error, tl("hc_routesAppSuperadminTenants.errDeleteTenant")));
        return;
      }
      toast.success(
        i18n.t("superadminTenants.tenantSentToTrash", {
          defaultValue: "{{name}} fue enviada a la papelera",
          name: t.name,
        }),
      );
      await load();
    } catch (e) {
      toast.error(friendlyError(e, tl("hc_routesAppSuperadminTenants.errDeleteTenant")));
    } finally {
      setRowBusy(null);
      setBusyNotice(null);
    }
  };

  /**
   * Inicia sesión como el Admin de un tenant — el SuperAdmin queda
   * "aislado" hasta que pare la impersonación. A diferencia del
   * "Ver como esta institución" (que solo cambia branding pero mantiene
   * tu identidad/rol), esto reemplaza la sesión por la del Admin del
   * tenant. Útil para reproducir bugs reportados por ese Admin sin
   * pedirle su contraseña.
   *
   * Selección del target:
   *   - Buscamos profiles del tenant con rol Admin (via user_roles).
   *   - Si hay 1, lo usamos.
   *   - Si hay >1, tomamos el más antiguo (created_at ASC) — el que
   *     más probablemente sea el "Admin principal" del tenant. Si más
   *     adelante queremos permitir elegir, se agrega un dialog acá.
   *   - Si hay 0, mostramos toast y abortamos: el SuperAdmin debe
   *     asignar un Admin primero al tenant.
   */
  const impersonateTenantAdmin = async (t: Tenant) => {
    // No hay confirm previo acá: el guard queda arriba. Corta ante cualquier
    // fila en vuelo ⇒ el `disabled` del item también es global.
    if (rowBusy) return;
    setRowBusy(t.id);
    // La búsqueda del Admin son 2 queries antes de poder preguntar nada:
    // hasta que resuelven, el menú se cerraba y no pasaba "nada" visible.
    setBusyNotice(
      i18n.t("superadminTenants.impersonateLookupNotice", {
        defaultValue: "Buscando el Admin de {{name}}…",
        name: t.name,
      }),
    );
    try {
      // 1. IDs de users con rol Admin (cross-tenant — luego filtramos por tenant_id).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: adminRoleRows, error: rolesErr } = await (supabase as any)
        .from("user_roles")
        .select("user_id")
        .eq("role", "Admin");
      // Antes el error de esta query se descartaba (solo se leía `data`):
      // un fallo de red / RLS se veía igual que "no hay Admins".
      if (rolesErr) {
        toast.error(friendlyError(rolesErr, tl("hc_routesAppSuperadminTenants.errImpersonate")));
        return;
      }
      const adminUserIds = ((adminRoleRows ?? []) as { user_id: string }[]).map((r) => r.user_id);
      if (adminUserIds.length === 0) {
        toast.error(
          i18n.t("superadminTenants.noAdminUsers", {
            defaultValue: "No hay usuarios con rol Admin en la plataforma.",
          }),
        );
        return;
      }
      // 2. Profiles del tenant que estén en ese set de Admins.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: candidates, error: candErr } = await (supabase as any)
        .from("profiles")
        .select("id, full_name, institutional_email, created_at")
        .eq("tenant_id", t.id)
        .in("id", adminUserIds)
        .order("created_at", { ascending: true })
        .limit(1);
      if (candErr) {
        toast.error(friendlyError(candErr, tl("hc_routesAppSuperadminTenants.errImpersonate")));
        return;
      }
      const target = (candidates ?? [])[0] as
        | { id: string; full_name: string | null; institutional_email: string }
        | undefined;
      if (!target) {
        toast.error(
          i18n.t("superadminTenants.tenantHasNoAdmin", {
            defaultValue:
              "{{name}} no tiene Admin asignado. Crea o asigna uno antes de iniciar sesión como.",
            name: t.name,
          }),
        );
        return;
      }
      // 3. Confirmación — esta acción reemplaza la sesión del SuperAdmin
      //    y recarga la app. Usamos useConfirm del design system (tono
      //    'warning' por ser cambio importante reversible, no destructivo
      //    en datos). Bajamos el banner mientras el modal está abierto
      //    (el spinner no debe girar esperando al usuario).
      setBusyNotice(null);
      const ok = await confirm({
        title: i18n.t("superadminTenants.impersonateConfirmTitle"),
        description: tl("hc_routesAppSuperadminTenants.impersonateConfirmDesc", {
          admin: target.full_name ?? target.institutional_email,
          tenant: t.name,
        }),
        confirmLabel: i18n.t("superadminTenants.actionImpersonate"),
        tone: "warning",
      });
      if (!ok) return;
      // Reemplazar la sesión + recargar tarda; el banner cubre esa
      // ventana en la que la pantalla sigue mostrando el grid viejo.
      setBusyNotice(
        i18n.t("superadminTenants.impersonateNotice", {
          defaultValue: "Iniciando sesión como Admin de {{name}}…",
          name: t.name,
        }),
      );
      // NOTA: antes acá llamábamos `setTenantOverride(null)` para limpiar
      // el contexto de "ver como tenant" antes de impersonar. Con la
      // arquitectura URL-driven eso haría un hard navigate y nunca
      // llegaríamos a `startImpersonate`. Ahora basta con dejar que el
      // `TenantUrlGuard` redirija a la sesión impersonada a su URL
      // correcto cuando la nueva sesión cargue.
      await startImpersonate(target.id);
      // startImpersonate hace window.location.href — no llegamos acá.
    } catch (e) {
      toast.error(friendlyError(e, tl("hc_routesAppSuperadminTenants.errImpersonate")));
    } finally {
      setRowBusy(null);
      setBusyNotice(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Building2 className="h-6 w-6" />}
        title={tl("superadminTenants.title")}
        subtitle={
          tenants.length === 1
            ? tl("hc_routesAppSuperadminTenants.subtitleOne", { count: tenants.length })
            : tl("hc_routesAppSuperadminTenants.subtitleMany", { count: tenants.length })
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={clearViewAs}>
              {tl("superadminTenants.clearViewAsBtn")}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" />
              {tl("superadminTenants.newInstitutionBtn")}
            </Button>
          </div>
        }
      />

      {/* Buscador + filtro de estado. El estado (activa / pausada) es la
          dimensión operativa más consultada del grid: al pausar una
          institución sigue listada, y sin filtro había que barrer todas las
          páginas para ver cuáles están fuera de servicio. */}
      {tenants.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={tl("superadminTenants.searchPlaceholder")}
            className="flex-1 min-w-0"
          />
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as "all" | "active" | "inactive")}
          >
            <SelectTrigger className="w-full sm:w-48 h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {tl("superadminTenants.statusFilterAll", { defaultValue: "Todos los estados" })}
              </SelectItem>
              <SelectItem value="active">
                {tl("superadminTenants.statusFilterActive", { defaultValue: "Solo activas" })}
              </SelectItem>
              <SelectItem value="inactive">
                {tl("superadminTenants.statusFilterInactive", { defaultValue: "Solo pausadas" })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Banner de acción en curso. Las acciones de fila de esta pantalla
          (pausar, enviar a la papelera con cascada, impersonar) tardan y no
          tienen un botón propio donde colgar el spinner —el menú de tres
          puntos se cierra al hacer click—, así que el estado se muestra acá. */}
      {busyNotice && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground"
        >
          <Spinner size="sm" />
          <span>{busyNotice}</span>
        </div>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <SectionLoader text={tl("superadminTenants.loadingText")} />
          ) : loadError ? (
            <ErrorState message={tl("superadminTenants.loadError")} hint={loadError} onRetry={load} />
          ) : tenants.length === 0 ? (
            <TableEmpty
              text={tl("superadminTenants.emptyText")}
              action={
                <Button size="sm" onClick={openCreate}>
                  <Plus className="h-4 w-4 mr-1" />
                  {tl("superadminTenants.createFirstBtn")}
                </Button>
              }
            />
          ) : pagination.totalItems === 0 ? (
            <TableEmpty
              text={tl("superadminTenants.noMatches")}
              hint={tl("common.tryClearFilter")}
            />
          ) : (
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="name" sort={sort}>
                    {tl("superadminTenants.colName")}
                  </SortableHead>
                  <SortableHead sortKey="slug" sort={sort} className="w-44">
                    {tl("superadminTenants.colSlug")}
                  </SortableHead>
                  <SortableHead
                    sortKey="email_domain"
                    sort={sort}
                    className="hidden sm:table-cell w-48"
                  >
                    {tl("superadminTenants.colEmailDomain")}
                  </SortableHead>
                  <SortableHead sortKey="status" sort={sort} className="w-28">
                    {tl("superadminTenants.colStatus")}
                  </SortableHead>
                  <TableHead className="hidden lg:table-cell w-24">{tl("superadminTenants.colPlan")}</TableHead>
                  {/* La columna "Licencias" (A/D/E uso/cupo) se quitó del grid por ruido
                      visual; el detalle de licencias vive en el diálogo "Facturación y plan". */}
                  <TableHead className="hidden lg:table-cell w-28">{tl("superadminTenants.colAi")}</TableHead>
                  <TableHead className="hidden xl:table-cell w-24">{tl("superadminTenants.colStorage", { defaultValue: "Almacenam." })}</TableHead>
                  <TableHead className="hidden xl:table-cell w-28">{tl("superadminTenants.colBilling")}</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagination.paginatedItems.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2 min-w-0">
                        {t.logo_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={t.logo_url}
                            alt={t.name}
                            className="h-6 w-6 rounded object-cover shrink-0"
                          />
                        )}
                        <span className="truncate" title={t.name}>
                          {t.name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* La dirección REAL, no el `/t/<slug>` del esquema de
                          rutas que se abandonó. Si el host no admite dirección
                          por institución (lovable.app, IP), mostramos el slug
                          pelado en vez de prometer una URL que no existe. */}
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {tenantUrlForSlug(t.slug, browserLoc)?.replace(/^https?:\/\//, "") ??
                          t.slug}
                      </code>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                      <div className="truncate" title={t.email_domain ?? undefined}>
                        {t.email_domain ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell>
                      {t.is_active ? (
                        <Badge variant="secondary" className="text-3xs">
                          {tl("superadminTenants.statusActive")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-3xs">
                          {tl("superadminTenants.statusPaused")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {overview[t.id] ? (
                        <Badge variant="outline" className="text-3xs capitalize">
                          {overview[t.id].plan_tier}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {overview[t.id] ? (
                        <span className="inline-flex items-center gap-1">
                          <Badge variant="secondary" className="text-3xs">
                            {overview[t.id].ai_mode === "shared"
                              ? tl("superadminTenants.aiShared")
                              : overview[t.id].ai_mode === "own"
                                ? tl("superadminTenants.aiOwn")
                                : tl("superadminTenants.aiManaged")}
                          </Badge>
                          {overview[t.id].has_own_ai_key && (
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0"
                              title={tl("superadminTenants.aiKeyPresent")}
                            />
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-xs tabular-nums whitespace-nowrap">
                      {overview[t.id] ? (
                        <span
                          title={
                            overview[t.id].storage_quota_mb
                              ? `Cupo: ${overview[t.id].storage_quota_mb} MB`
                              : undefined
                          }
                        >
                          {fmtBytes(overview[t.id].storage_bytes)}
                          {overview[t.id].storage_quota_mb ? (
                            <span className="text-muted-foreground">
                              {" "}
                              / {overview[t.id].storage_quota_mb}MB
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-xs whitespace-nowrap">
                      {(() => {
                        const o = overview[t.id];
                        if (!o) return <span className="text-muted-foreground">—</span>;
                        const s = o.subscription_status;
                        if (s === "suspended" || s === "expired" || s === "cancelled")
                          return (
                            <Badge variant="destructive" className="text-3xs">
                              {tl(`superadminTenants.sub_${s}`)}
                            </Badge>
                          );
                        if (s === "past_due")
                          return (
                            <Badge className="text-3xs border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400">
                              {tl("superadminTenants.sub_past_due")}
                            </Badge>
                          );
                        if (o.days_left == null)
                          return <span className="text-muted-foreground">{tl("superadminTenants.sub_courtesy")}</span>;
                        return (
                          <span className={o.days_left <= 7 ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground"}>
                            {tl("superadminTenants.daysLeft", { n: o.days_left })}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <RowActionsMenu
                        actions={[
                          {
                            label: tl("superadminTenants.actionImpersonate"),
                            icon: LogIn,
                            onClick: () => void impersonateTenantAdmin(t),
                            // Mientras HAY una operación de fila en vuelo (en
                            // cualquier institución) estas acciones quedan
                            // bloqueadas: los handlers las serializan, así que
                            // el disabled tiene que ser global para que no
                            // haya clicks que "no hacen nada".
                            disabled: rowBusy !== null,
                            hint:
                              rowBusy !== null
                                ? tl("common.processing", { defaultValue: "Procesando…" })
                                : tl("superadminTenants.actionImpersonateHint"),
                            // El ícono toma el primary del tenant de esta
                            // fila — pista visual de que la acción va a
                            // entrar al contexto de ESE tenant. Cae al
                            // default si el tenant no tiene color.
                            iconColor: t.primary_color ?? undefined,
                          },
                          {
                            label: tl("superadminTenants.actionManageUsers"),
                            icon: UserPlus,
                            onClick: () => setAssignUsersTenant(t),
                          },
                          {
                            label: tl("superadminTenants.actionEmail", {
                              defaultValue: "Configurar correo",
                            }),
                            icon: Mail,
                            onClick: () => setEmailTenant(t),
                            hint: tl("superadminTenants.actionEmailHint", {
                              defaultValue:
                                "SMTP propio de la institución (host, usuario, remitente). Si no, usa el global.",
                            }),
                          },
                          {
                            label: tl("superadminTenants.actionBilling", {
                              defaultValue: "Facturación y plan",
                            }),
                            icon: CreditCard,
                            onClick: () => setBillingTenant(t),
                            hint: tl("superadminTenants.actionBillingHint", {
                              defaultValue:
                                "Plan, modo de IA, ciclo de facturación (fechas + gracia en días hábiles) y auto-suspensión.",
                            }),
                          },
                          {
                            label: tl("superadminTenants.actionViewAs"),
                            icon: Eye,
                            onClick: () => viewAs(t),
                            hint: tl("superadminTenants.actionViewAsHint"),
                          },
                          {
                            label: tl("superadminTenants.actionEdit"),
                            icon: Pencil,
                            onClick: () => openEdit(t),
                            separatorBefore: true,
                          },
                          {
                            label: tl("superadminTenants.actionDuplicate", {
                              defaultValue: "Duplicar institución",
                            }),
                            icon: Copy,
                            onClick: () => duplicate(t),
                            hint: tl("superadminTenants.actionDuplicateHint", {
                              defaultValue:
                                "Crea una institución nueva con el mismo branding y cuotas (defines slug, nombre y logo).",
                            }),
                          },
                          {
                            label: t.is_active ? tl("superadminTenants.actionPause") : tl("superadminTenants.actionReactivate"),
                            icon: Power,
                            onClick: () => void toggleActive(t),
                            tone: t.is_active ? "destructive" : undefined,
                            disabled: rowBusy !== null,
                            hint:
                              rowBusy !== null
                                ? tl("common.processing", { defaultValue: "Procesando…" })
                                : undefined,
                          },
                          {
                            label: tl("superadminTenants.actionDelete"),
                            icon: Trash2,
                            onClick: () => void softDeleteTenantHandler(t),
                            tone: "destructive",
                            separatorBefore: true,
                            disabled: rowBusy !== null,
                            hint:
                              rowBusy !== null
                                ? tl("common.processing", { defaultValue: "Procesando…" })
                                : tl("superadminTenants.actionDeleteHint"),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <DataPagination state={pagination} entityNamePlural={tl("hc_routesAppSuperadminTenants.entityNamePlural")} />
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        // Mientras guarda (INSERT + logo + provisión del usuario de prueba)
        // el dialog no se cierra por Esc / click afuera: desmontarlo dejaba
        // el flujo a medias sin nadie que muestre el resultado.
        onOpenChange={(o) => {
          if (saving || uploadingLogo) return;
          void dirty.guardOpenChange(setDialogOpen)(o);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? tl("superadminTenants.dialogEditTitle", { name: editing.name }) : tl("superadminTenants.dialogNewTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Cada field es un stack vertical Label → Input → helper text
                con gap consistente de 6px (space-y-1.5). Antes los divs
                NO tenían class interna y la Label (leading-none, sin
                margin) quedaba pegada al Input — visualmente "labels
                no alineados con inputs". Fix: space-y-1.5 a cada field.
                El gap entre fields se subió a space-y-4 (16px) para no
                achicar la separación entre grupos. */}
            <div className="space-y-1.5">
              <Label required>{tl("superadminTenants.fieldSlug")}</Label>
              <Input
                value={form.slug}
                onChange={(e) => setForm((p) => ({ ...p, slug: e.target.value }))}
                placeholder="sena-bogota"
              />
              <p className="text-2xs text-muted-foreground">
                {tl("superadminTenants.fieldSlugHintChars")}
                {editing && previewUrlActual && (
                  <>
                    {" "}
                    <span className="text-amber-600 dark:text-amber-400">
                      {tl("superadminTenants.fieldSlugChangeWarning")}{" "}
                      <code>{previewUrlActual}</code>.
                    </span>
                  </>
                )}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label required>{tl("superadminTenants.fieldName")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder={tl("hc_routesAppSuperadminTenants.namePlaceholder")}
              />
            </div>
            {/* Cómo va a quedar. Va ACÁ, entre los datos de identidad y los de
                marca, para que se vea mientras se eligen los colores de abajo:
                puesta al final del formulario habría que hacer scroll de ida y
                vuelta con cada ajuste de hex. */}
            <div className="space-y-1.5 rounded-md border p-3">
              <Label>{tl("superadminTenants.previewTitle")}</Label>

              <div className="space-y-0.5">
                <div className="text-2xs text-muted-foreground">
                  {tl("superadminTenants.previewAddressLabel")}
                </div>
                {previewUrl ? (
                  <code className="block truncate text-xs font-medium">{previewUrl}</code>
                ) : (
                  <span className="text-2xs text-muted-foreground">
                    {tl("superadminTenants.previewAddressPending")}
                  </span>
                )}
                {!editing && previewUrl && (
                  <p className="text-2xs text-muted-foreground">
                    {tl("superadminTenants.previewAddressDelay")}
                  </p>
                )}
              </div>

              <TenantBrandPreview
                name={form.name}
                primaryColor={form.primary_color}
                secondaryColor={form.secondary_color}
                textColor={form.text_color}
                iconColor={form.icon_color}
                logoUrl={pendingLogoPreview || form.logo_url}
                dark={resolvedTheme === "dark"}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{tl("superadminTenants.fieldEmailDomain")}</Label>
              <Input
                value={form.email_domain}
                onChange={(e) => setForm((p) => ({ ...p, email_domain: e.target.value }))}
                placeholder="sena.edu.co"
              />
              <p className="text-2xs text-muted-foreground">
                {tl("superadminTenants.fieldEmailDomainHint")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>{tl("superadminTenants.fieldLogo")}</Label>
              {/* Misma UI en crear y editar. La diferencia vive en uploadLogo:
                  - Editar: sube al bucket al instante (tenemos editing.id).
                  - Crear: stashea el File + preview local; el upload real lo
                    hace save() después del INSERT, usando el id recién creado. */}
              <div className="flex items-center gap-3 mt-1">
                {form.logo_path ? (
                  <div className="h-14 w-14 rounded-lg border bg-background flex items-center justify-center overflow-hidden shrink-0">
                    <img
                      src={
                        supabase.storage.from("tenant-logos").getPublicUrl(form.logo_path).data
                          ?.publicUrl ?? ""
                      }
                      alt={form.name}
                      className="h-full w-full object-contain"
                    />
                  </div>
                ) : pendingLogoPreview ? (
                  <div className="h-14 w-14 rounded-lg border border-primary/40 bg-background flex items-center justify-center overflow-hidden shrink-0">
                    <img
                      src={pendingLogoPreview}
                      alt={form.name}
                      className="h-full w-full object-contain"
                    />
                  </div>
                ) : form.logo_url ? (
                  <div className="h-14 w-14 rounded-lg border bg-background flex items-center justify-center overflow-hidden shrink-0">
                    <img
                      src={form.logo_url}
                      alt={form.name}
                      className="h-full w-full object-contain"
                    />
                  </div>
                ) : (
                  <div className="h-14 w-14 rounded-lg border border-dashed bg-muted/30 flex items-center justify-center text-3xs text-muted-foreground shrink-0">
                    {tl("superadminTenants.logoNoLogo")}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <input
                    ref={logoFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadLogo(f);
                    }}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => logoFileInputRef.current?.click()}
                      disabled={uploadingLogo || saving}
                    >
                      {uploadingLogo ? (
                        <Spinner size="sm" className="mr-1" />
                      ) : (
                        <Upload className="h-3.5 w-3.5 mr-1" />
                      )}
                      {uploadingLogo ? tl("superadminTenants.logoUploadingBtn") : tl("superadminTenants.logoUploadBtn")}
                    </Button>
                    {(form.logo_path || form.logo_url || pendingLogoFile) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={removeLogo}
                        disabled={uploadingLogo || saving}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        {tl("superadminTenants.logoRemoveBtn")}
                      </Button>
                    )}
                  </div>
                  <p className="text-2xs text-muted-foreground mt-1">
                    {tl("superadminTenants.logoHint")}
                    {!editing && pendingLogoFile ? tl("superadminTenants.logoPendingHint") : ""}
                  </p>
                </div>
              </div>
              {/* Campo URL alternativo: para casos en que el SuperAdmin
                  prefiere usar un asset alojado en otro lado (ej. CDN
                  corporativo). Si hay archivo subido / pendiente, este
                  campo queda informativo y no se usa. */}
              {!form.logo_path && !pendingLogoFile && (
                <Input
                  value={form.logo_url}
                  onChange={(e) => setForm((p) => ({ ...p, logo_url: e.target.value }))}
                  placeholder={tl("superadminTenants.logoUrlPlaceholder")}
                  className="mt-2"
                />
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-4">
              <div className="space-y-1.5">
                <Label>{tl("superadminTenants.colorPrimary")}</Label>
                <HexColorInput
                  value={form.primary_color}
                  onChange={(v) => setForm((p) => ({ ...p, primary_color: v }))}
                  placeholder="#3B82F6"
                  ariaLabel={tl("superadminTenants.colorPrimary")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{tl("superadminTenants.colorSecondary")}</Label>
                <HexColorInput
                  value={form.secondary_color}
                  onChange={(v) => setForm((p) => ({ ...p, secondary_color: v }))}
                  placeholder="#8B5CF6"
                  ariaLabel={tl("superadminTenants.colorSecondary")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{tl("superadminTenants.colorText")}</Label>
                <HexColorInput
                  value={form.text_color}
                  onChange={(v) => setForm((p) => ({ ...p, text_color: v }))}
                  placeholder="#FFFFFF"
                  ariaLabel={tl("superadminTenants.colorText")}
                />
                <p className="text-2xs text-muted-foreground">
                  {tl("superadminTenants.colorTextHint")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>{tl("superadminTenants.colorIcon")}</Label>
                <HexColorInput
                  value={form.icon_color}
                  onChange={(v) => setForm((p) => ({ ...p, icon_color: v }))}
                  placeholder="#FFFFFF"
                  ariaLabel={tl("superadminTenants.colorIcon")}
                />
                <p className="text-2xs text-muted-foreground">
                  {tl("superadminTenants.colorIconHint")}
                </p>
              </div>
            </div>

            {/* Cuotas de usuarios — define el plan/contrato del tenant.
                NULL = ilimitado. El trigger tg_check_tenant_user_quota
                rechaza INSERT en user_roles cuando se excede. Aplica
                solo a Admin/Docente/Estudiante (SuperAdmin es
                cross-tenant, no cuenta). */}
            <div className="space-y-2 pt-2 border-t">
              <Label className="text-sm font-medium">{tl("superadminTenants.quotaSection")}</Label>
              <p className="text-2xs text-muted-foreground">
                {tl("superadminTenants.quotaHint")}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">{tl("superadminTenants.quotaAdmins")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_admins}
                    onChange={(e) => setForm((p) => ({ ...p, max_admins: e.target.value }))}
                    placeholder="∞"
                    className="text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tl("superadminTenants.quotaTeachers")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_teachers}
                    onChange={(e) => setForm((p) => ({ ...p, max_teachers: e.target.value }))}
                    placeholder="∞"
                    className="text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tl("superadminTenants.quotaStudents")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.max_students}
                    onChange={(e) => setForm((p) => ({ ...p, max_students: e.target.value }))}
                    placeholder="∞"
                    className="text-xs"
                  />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              {tl("superadminTenants.cancelBtn")}
            </Button>
            <Button onClick={() => void save()} disabled={saving || uploadingLogo}>
              {saving ? <Spinner size="sm" className="mr-2" /> : <Save className="h-4 w-4 mr-1" />}
              {saving ? tl("superadminTenants.savingBtn") : tl("superadminTenants.saveBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 'Gestionar usuarios' — el SuperAdmin marca/desmarca
          profiles cross-tenant para agregar o quitar de este tenant.
          Trigger DB rechaza si el user tiene cursos activos en su
          tenant actual. */}
      <AssignUsersToTenantDialog
        tenant={assignUsersTenant}
        open={assignUsersTenant !== null}
        onOpenChange={(o) => {
          if (!o) setAssignUsersTenant(null);
        }}
        tenants={tenants}
        onAssigned={() => void load()}
      />

      {emailTenant && (
        <TenantEmailSettingsDialog
          open={emailTenant !== null}
          onOpenChange={(o) => {
            if (!o) setEmailTenant(null);
          }}
          tenantId={emailTenant.id}
          tenantName={emailTenant.name}
        />
      )}

      {billingTenant && (
        <TenantBillingDialog
          open={billingTenant !== null}
          tenantId={billingTenant.id}
          tenantName={billingTenant.name}
          onClose={() => setBillingTenant(null)}
          onSaved={load}
        />
      )}

      {/* Credenciales del usuario de prueba — se muestran UNA SOLA VEZ
          tras crear una institución. La password no se persiste en
          plaintext: si el SuperAdmin cierra sin copiar, tiene que pedir
          reset desde /auth o crear otro user manualmente. */}
      <Dialog
        open={testUserCreds !== null}
        onOpenChange={(o) => {
          if (!o) setTestUserCreds(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-amber-500" />
              {tl("superadminTenants.testUserDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {tl("superadminTenants.testUserDialogDesc")} <strong>{tl("superadminTenants.testUserDialogDescStrong")}</strong> {tl("superadminTenants.testUserDialogDescSuffix")}
            </DialogDescription>
          </DialogHeader>
          {testUserCreds && (
            <div className="space-y-3 text-sm">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{tl("superadminTenants.testUserLabelInstitution")}</Label>
                <div className="font-medium">{testUserCreds.tenant_name}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{tl("superadminTenants.testUserLabelFullName")}</Label>
                <div className="font-medium">{testUserCreds.full_name}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{tl("superadminTenants.testUserLabelEmail")}</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono break-all">
                    {testUserCreds.email}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    onClick={() =>
                      void copyToClipboard(
                        testUserCreds.email,
                        i18n.t("superadminTenants.emailCopied", {
                          defaultValue: "Email copiado",
                        }),
                      )
                    }
                    title={tl("hc_routesAppSuperadminTenants.copyEmailTitle")}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{tl("superadminTenants.testUserLabelPassword")}</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono break-all">
                    {testUserCreds.password}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    onClick={() =>
                      void copyToClipboard(
                        testUserCreds.password,
                        i18n.t("superadminTenants.passwordCopied", {
                          defaultValue: "Contraseña copiada",
                        }),
                      )
                    }
                    title={tl("hc_routesAppSuperadminTenants.copyPasswordTitle")}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{tl("superadminTenants.testUserLabelRoles")}</Label>
                <div className="flex flex-wrap gap-1">
                  {testUserCreds.roles.map((r) => (
                    <Badge key={r} variant="secondary" className="text-3xs">
                      {r}
                    </Badge>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground border-t pt-3">
                {tl("superadminTenants.testUserLoginHint")}
                <code className="mx-1 rounded bg-muted px-1">/auth</code>
                {tl("superadminTenants.testUserDomainNote")} <code>.test</code> {tl("superadminTenants.testUserDomainNoteEnd")}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={() => {
                if (!testUserCreds) return;
                void copyToClipboard(
                  tl("hc_routesAppSuperadminTenants.copyAllText", {
                    email: testUserCreds.email,
                    password: testUserCreds.password,
                  }),
                  i18n.t("superadminTenants.credentialsCopied", {
                    defaultValue: "Credenciales copiadas",
                  }),
                );
              }}
              variant="outline"
            >
              <Copy className="h-3.5 w-3.5 mr-1" />
              {tl("superadminTenants.copyAllBtn")}
            </Button>
            <Button onClick={() => setTestUserCreds(null)}>{tl("superadminTenants.closeBtn")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
