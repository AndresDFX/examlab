import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { logEvent } from "@/shared/lib/audit";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LanguageSwitcher } from "@/shared/components/LanguageSwitcher";
import { toast } from "sonner";
import { GraduationCap, KeyRound, Mail, Eye, EyeOff, Building2, Chrome } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { getTenantSlugFromUrl } from "@/modules/tenants/url";
import { friendlyError } from "@/shared/lib/db-errors";
import { requestBrowserSaveCredential } from "@/shared/lib/credential-store";
import { consumeReturnTo } from "@/shared/lib/return-to";

export const Route = createFileRoute("/auth/")({
  head: () => ({
    meta: [
      { title: "Iniciar sesión — ExamLab" },
      { name: "description", content: "Accede a la plataforma de exámenes" },
    ],
  }),
  component: AuthPage,
});

/** Fila mínima retornada por la RPC pública `list_active_tenants_public`. */
interface TenantOption {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  logo_path: string | null;
  primary_color: string | null;
}

/** Sentinel para el SuperAdmin: "no preseleccionar institución, vista
 *  cross-tenant". Si elige esto, post-login va a `/app` sin prefijo. */
const SUPERADMIN_CROSS_TENANT = "__cross_tenant__";

// Keys de localStorage para el toggle "Recordarme". Solo persistimos
// email + slug de institución — NUNCA el password (eso queda a cargo del
// password manager del navegador via autoComplete="current-password").
// Si el usuario destilda "Recordarme", limpiamos las 3 entries.
const REMEMBER_FLAG_KEY = "examlab_remember_me";
const REMEMBER_EMAIL_KEY = "examlab_remember_email";
const REMEMBER_SLUG_KEY = "examlab_remember_slug";

function AuthPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  // Email + rememberMe pre-llenados desde localStorage si el usuario
  // marcó "Recordarme" en una sesión anterior. La password NO se pre-
  // llena desde código — si el navegador la guardó vía su password
  // manager, autoComplete hará el autofill cuando el input enfoque.
  //
  // CRÍTICO — Hydration: estos 2 useState DEBEN inicializarse a valores
  // determinísticos ("" y false), NO leer localStorage en el initializer.
  // Si el primer render del cliente lee storage y obtiene `value="usuario@..."`
  // mientras el HTML pre-renderizado tiene `value=""`, React tira #418
  // (hydration mismatch). El read del storage va en el useEffect post-mount
  // (efecto "hydrate-remember" más abajo). Mismo patrón que `useTheme()`.
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState<boolean>(false);
  // SSO loading flags — separados para mostrar el spinner solo en el
  // botón clickeado (Google o Microsoft), no en ambos a la vez.
  const [ssoLoading, setSsoLoading] = useState<null | "google" | "azure">(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  // Lista de instituciones activas. Cargada vía RPC pública
  // `list_active_tenants_public()` que el caller anon puede ejecutar.
  // Si la lista está vacía o falla, el selector queda deshabilitado y el
  // login sigue funcionando — el server valida igual la pertenencia.
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  // Slug seleccionado. Prioridad de pre-llenado (aplicada POST-mount,
  // ver useEffect "hydrate-remember"):
  //   1. Slug de la URL (`/t/<slug>/auth`) — explícito del shareable link.
  //   2. Slug guardado por "Recordarme" en sesión anterior.
  //   3. Vacío — el usuario debe elegir.
  //
  // Initializer DETERMINÍSTICO ("") por la misma razón que email / rememberMe
  // — evita hydration mismatch (React #418). Leer window.location o
  // localStorage acá rompe el primer render cuando el HTML pre-renderizado
  // no los tiene.
  const [selectedSlug, setSelectedSlug] = useState<string>("");

  // Post-mount: leer flags / URL / storage y poblar email, rememberMe,
  // selectedSlug. Corre UNA sola vez tras el primer render — el árbol
  // React ya está hidratado, así que cambiar el state acá es seguro y
  // no dispara #418.
  useEffect(() => {
    try {
      const remembered = window.localStorage.getItem(REMEMBER_FLAG_KEY) === "1";
      if (remembered) {
        const storedEmail = window.localStorage.getItem(REMEMBER_EMAIL_KEY);
        if (storedEmail) setEmail(storedEmail);
        setRememberMe(true);
      }
    } catch {
      /* ignore privacy mode / SSR */
    }
    // Slug: URL gana sobre storage. El segundo useEffect (más abajo) lo
    // re-confirma cuando la lista de tenants carga, para descartar slugs
    // de URLs viejas que apunten a tenants borrados.
    const fromUrl = getTenantSlugFromUrl();
    if (fromUrl) {
      setSelectedSlug(fromUrl);
    } else {
      try {
        if (window.localStorage.getItem(REMEMBER_FLAG_KEY) === "1") {
          const storedSlug = window.localStorage.getItem(REMEMBER_SLUG_KEY);
          if (storedSlug) setSelectedSlug(storedSlug);
        }
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Cargar instituciones al montar. Cualquier usuario anon puede leer
  // esta lista (la RPC filtra a `is_active=true` y expone solo branding).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("list_active_tenants_public");
      if (cancelled) return;
      if (error) {
        console.warn("[auth] list_active_tenants_public", error);
        setTenants([]);
      } else {
        setTenants((data as TenantOption[] | null) ?? []);
      }
      setTenantsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Si la URL ya trae /t/<slug>, autoseleccionamos. Espera a que cargue
  // la lista para no setear un slug que no existe.
  useEffect(() => {
    if (tenantsLoading) return;
    const fromUrl = getTenantSlugFromUrl();
    if (fromUrl && tenants.some((tn) => tn.slug === fromUrl)) {
      setSelectedSlug(fromUrl);
    }
  }, [tenantsLoading, tenants]);

  const selectedTenant = useMemo(
    () => tenants.find((tn) => tn.slug === selectedSlug) ?? null,
    [tenants, selectedSlug],
  );

  const openForgot = () => {
    setForgotEmail(email);
    setForgotSent(false);
    setForgotOpen(true);
  };

  const onForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail.trim()) return;
    setForgotLoading(true);
    const { error } = await supabase.functions.invoke("request-password-reset", {
      body: { email: forgotEmail.trim() },
    });
    setForgotLoading(false);
    if (error) {
      console.warn("[auth] request-password-reset", error);
    }
    setForgotSent(true);
  };

  // Si ya hay sesión activa al cargar la pantalla, redirigir directo al
  // app. Usamos hard navigate con el slug del profile (lo leeremos al
  // estar logueado) — pero acá no tenemos profile aún, así que vamos a
  // `/app` y el `TenantUrlGuard` se encarga de prefijar.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        // Sesión ya activa → al app (o al deep-link recordado, ej. QR de
        // Kahoot). No tocamos localStorage del override aquí (el usuario
        // podría tener uno legítimo de antes; si es regular, `useTenant` lo
        // ignora).
        window.location.href = consumeReturnTo() ?? "/app";
      }
    });
  }, []);

  /**
   * Inicia el flow OAuth de Supabase contra Google o Microsoft (Azure).
   *
   * Política: el SSO NO crea cuentas. Tras volver del proveedor, la ruta
   * `/auth/sso-callback` invoca el edge `auth-sso-verify` que valida que
   * el email autenticado corresponda a un `profiles.institutional_email`
   * ya pre-aprovisionado. Si no existe, borra el auth.user huérfano y
   * muestra el error claro al usuario.
   *
   * Pre-reqs (Supabase project):
   *   - Auth → Providers → Google: enabled + Client ID/Secret cargados.
   *   - Auth → Providers → Azure: enabled + Client ID/Secret + tenant
   *     configurado (común: "common" para personal+trabajo).
   *   - Redirect URLs incluyen `https://<host>/auth/sso-callback`.
   */
  const onSso = async (provider: "google" | "azure") => {
    if (ssoLoading) return;
    setSsoLoading(provider);
    try {
      const redirectTo = `${window.location.origin}/auth/sso-callback`;
      // Para Microsoft (azure), pedimos los scopes mínimos. `email` y
      // `openid` vienen por defecto en Supabase Azure provider; `profile`
      // habilita el nombre del usuario.
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          // Forzamos selección de cuenta para evitar el silent SSO cuando
          // el usuario tiene varias cuentas Google/MS logueadas en el
          // navegador (común al usar laptops compartidas o cuentas
          // personales mezcladas con las institucionales).
          queryParams:
            provider === "google"
              ? { access_type: "offline", prompt: "select_account" }
              : { prompt: "select_account" },
          scopes: provider === "azure" ? "openid email profile" : undefined,
        },
      });
      if (error) {
        setSsoLoading(null);
        toast.error(
          `${t("auth.sso.startError", { defaultValue: "No se pudo iniciar el SSO" })}: ${error.message}`,
        );
      }
      // Si todo OK: el browser redirige al provider. No reseteamos el
      // loading flag — la página se va a destruir igual.
    } catch (e) {
      setSsoLoading(null);
      toast.error(
        `${t("auth.sso.startError", { defaultValue: "No se pudo iniciar el SSO" })}: ${(e as Error).message}`,
      );
    }
  };

  const onLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlug) {
      toast.error(
        t("auth.tenantRequired", { defaultValue: "Selecciona tu institución antes de continuar." }),
      );
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (supabase as any).rpc("log_failed_login", {
        p_email: email,
        p_reason: error.message,
      });
      toast.error(t("auth.invalidCredentials"));
      return;
    }

    // Login OK — ahora validamos que el usuario pertenezca al tenant
    // seleccionado (o sea SuperAdmin). Si no, le cerramos la sesión y
    // mostramos error claro.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const userId = data.user?.id;
      if (!userId) throw new Error("Sesión sin user_id");

      const [{ data: prof }, { data: rolesRows }] = await Promise.all([
        sb.from("profiles").select("tenant_id").eq("id", userId).maybeSingle(),
        sb.from("user_roles").select("role").eq("user_id", userId),
      ]);

      const userTenantId = (prof as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      const userRoles = new Set(((rolesRows ?? []) as { role: string }[]).map((r) => r.role));
      const isSuperAdmin = userRoles.has("SuperAdmin");

      // SuperAdmin: puede elegir cualquier institución (incluido el
      // "modo cross-tenant" si seleccionó el sentinel).
      let targetSlug: string | null;
      if (selectedSlug === SUPERADMIN_CROSS_TENANT) {
        if (!isSuperAdmin) {
          await supabase.auth.signOut();
          setLoading(false);
          toast.error(
            t("auth.crossTenantOnlySuperAdmin", {
              defaultValue: "Solo SuperAdmin puede acceder en modo cross-tenant.",
            }),
          );
          return;
        }
        targetSlug = null;
      } else if (isSuperAdmin) {
        targetSlug = selectedSlug;
      } else {
        // User normal: el tenant elegido DEBE coincidir con su profile.
        const selected = tenants.find((tn) => tn.slug === selectedSlug);
        if (!selected || !userTenantId || selected.id !== userTenantId) {
          await supabase.auth.signOut();
          setLoading(false);
          toast.error(
            t("auth.tenantMismatch", {
              defaultValue: "No perteneces a la institución seleccionada.",
            }),
          );
          return;
        }
        targetSlug = selected.slug;
      }

      // Login exitoso → audit log. logEvent es fire-and-forget; el RPC
      // server-side recaptura auth.uid() (ya seteado tras el signin) y
      // el actor_email de auth.users.
      void logEvent({
        action: "user.login_success",
        category: "user",
        severity: "info",
        entityType: "user",
        entityId: data.user?.id,
        entityName: data.user?.email ?? email,
      });

      // "Recordarme": persistimos email + slug en localStorage para que
      // el próximo login pre-llene esos campos. La password queda a
      // cargo del password manager del navegador (autoComplete=
      // "current-password" en el input). Si el toggle está apagado,
      // limpiamos las 3 entries.
      try {
        if (rememberMe) {
          window.localStorage.setItem(REMEMBER_FLAG_KEY, "1");
          window.localStorage.setItem(REMEMBER_EMAIL_KEY, email);
          window.localStorage.setItem(REMEMBER_SLUG_KEY, selectedSlug);
        } else {
          window.localStorage.removeItem(REMEMBER_FLAG_KEY);
          window.localStorage.removeItem(REMEMBER_EMAIL_KEY);
          window.localStorage.removeItem(REMEMBER_SLUG_KEY);
        }
      } catch {
        /* privacy mode / quota — silencio, login sigue OK */
      }

      toast.success(t("auth.welcome"));

      // Hard navigate al app. Para SuperAdmin que eligió un tenant
      // concreto, escribimos el override en localStorage antes del
      // reload — `useTenant` lo lee post-mount y aplica el branding/
      // contexto del tenant seleccionado. Para users regulares no
      // hace falta: su tenant viene de `profile.tenant_id` y el
      // override se ignora.
      if (isSuperAdmin && targetSlug) {
        try {
          window.localStorage.setItem("examlab_tenant_override", targetSlug);
        } catch {
          /* ignore */
        }
      } else if (isSuperAdmin && !targetSlug) {
        // SuperAdmin eligió "modo cross-tenant" → limpia override.
        try {
          window.localStorage.removeItem("examlab_tenant_override");
        } catch {
          /* ignore */
        }
      }

      // Disparamos el prompt nativo de "¿Guardar contraseña?" del navegador
      // ANTES de navegar. Es lo que faltaba para que, al entrar con una
      // cuenta nueva, Chrome/Edge ofrezcan guardarla (el heurístico de form
      // por sí solo no lo hace en este flujo SPA). Awaiteado para que la
      // burbuja quede encolada; el redirect siguiente la muestra.
      await requestBrowserSaveCredential(email, password);
      // Volver al deep-link protegido si el usuario llegó por uno (ej. QR de
      // Kahoot / asistencia); si no, a /app. consumeReturnTo valida que sea
      // una ruta interna (anti open-redirect).
      window.location.href = consumeReturnTo() ?? "/app";
    } catch (err) {
      console.error("[auth] post-login validation failed", err);
      await supabase.auth.signOut();
      setLoading(false);
      toast.error(friendlyError(err, "No se pudo validar la sesión"));
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Brand panel */}
      <div className="hidden lg:flex flex-col justify-between bg-sidebar text-sidebar-foreground p-10">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-sidebar-primary flex items-center justify-center">
            <GraduationCap className="h-6 w-6 text-sidebar-primary-foreground" />
          </div>
          <div>
            <div className="text-xl font-semibold">ExamLab</div>
            <div className="text-sm text-sidebar-foreground/60">{t("auth.brandSubtitle")}</div>
          </div>
        </div>
        <div className="space-y-6">
          <h1 className="text-4xl font-semibold tracking-tight leading-tight">
            {t("auth.brandTagline")}
          </h1>
          <ul className="space-y-3 text-sidebar-foreground/80">
            <li>• {t("auth.featureRoles")}</li>
            <li>• {t("auth.featureAssignment")}</li>
            <li>• {t("auth.featureProctoring")}</li>
            <li>• {t("auth.featureAI")}</li>
          </ul>
        </div>
        <div className="text-xs text-sidebar-foreground/50">© ExamLab 2026</div>
      </div>

      {/* Login panel */}
      <div className="flex items-center justify-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2 mb-2 lg:hidden">
              <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
                <GraduationCap className="h-5 w-5 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg">ExamLab</span>
            </div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-2xl">{t("auth.title")}</CardTitle>
                <CardDescription>{t("auth.instructions")}</CardDescription>
              </div>
              <LanguageSwitcher />
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={onLogin} className="space-y-4">
              {/* Hidden username — sin este input el password manager de
                  Chrome/Edge no asocia la credencial y NO ofrece "guardar
                  contraseña" tras el login. El email tiene
                  autoComplete="username" pero el manager necesita el link
                  explícito name="username" dentro del form (mismo patrón que
                  ChangePasswordDialog). */}
              <input
                type="text"
                name="username"
                value={email}
                autoComplete="username"
                readOnly
                hidden
                aria-hidden="true"
              />
              <div className="space-y-1.5">
                <Label htmlFor="li-tenant" required>
                  {t("auth.institution", { defaultValue: "Institución" })}
                </Label>
                <Select value={selectedSlug} onValueChange={setSelectedSlug}>
                  <SelectTrigger id="li-tenant" disabled={tenantsLoading}>
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <SelectValue
                        placeholder={
                          tenantsLoading
                            ? t("common.loading", { defaultValue: "Cargando…" })
                            : t("auth.selectInstitution", {
                                defaultValue: "Selecciona tu institución",
                              })
                        }
                      />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {tenants.map((tn) => (
                      <SelectItem key={tn.id} value={tn.slug}>
                        {tn.name}
                      </SelectItem>
                    ))}
                    {/* Opción especial para SuperAdmin cross-tenant. Cualquier
                        non-SuperAdmin que la elija será rechazado post-auth. */}
                    <SelectItem value={SUPERADMIN_CROSS_TENANT}>
                      {t("auth.crossTenantOption", {
                        defaultValue: "— SuperAdmin: vista cross-tenant —",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {selectedTenant && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("auth.institutionUrl", { defaultValue: "URL:" })}{" "}
                    <code className="text-[11px]">/t/{selectedTenant.slug}</code>
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="li-email" required>
                  {t("auth.institutionalEmail")}
                </Label>
                <Input
                  id="li-email"
                  type="email"
                  placeholder="usuario@institucion.edu"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  // autoComplete="username" + autoComplete="current-password"
                  // en el password input le indican al password manager
                  // del navegador (Chrome, Edge, Safari, Bitwarden, 1Password,
                  // etc.) que esto es un login form — habilita el flow
                  // estándar de "guardar contraseña" y autofill en visitas
                  // posteriores. Sin estos atributos algunos managers no
                  // ofrecen guardar.
                  autoComplete="username"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="li-pass" required>
                    {t("auth.password")}
                  </Label>
                  <button
                    type="button"
                    onClick={openForgot}
                    className="text-xs text-primary hover:underline"
                  >
                    {t("auth.forgotPassword", { defaultValue: "¿Olvidaste tu contraseña?" })}
                  </button>
                </div>
                <div className="relative">
                  <Input
                    id="li-pass"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="pr-9"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    aria-label={
                      showPassword
                        ? t("auth.hidePassword", { defaultValue: "Ocultar contraseña" })
                        : t("auth.showPassword", { defaultValue: "Mostrar contraseña" })
                    }
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {/* "Recordarme": persiste email + slug en localStorage para
                  el próximo login. La password queda a cargo del password
                  manager del navegador (autoComplete="current-password"). */}
              <label className="flex items-center gap-2 select-none cursor-pointer">
                <Checkbox
                  checked={rememberMe}
                  onCheckedChange={(v) => setRememberMe(v === true)}
                  id="li-remember"
                />
                <span className="text-sm text-muted-foreground">
                  {t("auth.rememberMe", { defaultValue: "Recordarme" })}
                </span>
              </label>
              <Button
                type="submit"
                className="w-full"
                disabled={loading || !selectedSlug || ssoLoading !== null}
              >
                {loading && <Spinner size="md" className="mr-2" />} {t("auth.submit")}
              </Button>
            </form>

            {/* Separador + SSO. El SSO NO crea cuentas — el callback edge
                valida que el email exista en `profiles.institutional_email`.
                Si no, cierra sesión + muestra error. */}
            <div className="my-4 flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("auth.sso.divider", { defaultValue: "o continúa con" })}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void onSso("google")}
                disabled={loading || ssoLoading !== null}
              >
                {ssoLoading === "google" ? (
                  <Spinner size="sm" className="mr-2" />
                ) : (
                  <Chrome className="h-4 w-4 mr-2" />
                )}
                {t("auth.sso.google", { defaultValue: "Google" })}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void onSso("azure")}
                disabled={loading || ssoLoading !== null}
              >
                {ssoLoading === "azure" ? (
                  <Spinner size="sm" className="mr-2" />
                ) : (
                  // Microsoft no tiene un ícono "Microsoft" puro en
                  // lucide; usamos un cuadradito 4-panel improvisado
                  // con divs Tailwind para mantener la marca reconocible
                  // sin agregar una dependencia.
                  <span className="inline-grid grid-cols-2 grid-rows-2 gap-[2px] mr-2 h-4 w-4 shrink-0">
                    <span className="bg-[#f25022]" />
                    <span className="bg-[#7fba00]" />
                    <span className="bg-[#00a4ef]" />
                    <span className="bg-[#ffb900]" />
                  </span>
                )}
                {t("auth.sso.microsoft", { defaultValue: "Microsoft" })}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2 text-center">
              {t("auth.sso.noAutoCreate", {
                defaultValue:
                  "El SSO solo entra si tu admin ya creó tu cuenta. No registra usuarios nuevos.",
              })}
            </p>
            <p className="text-xs text-muted-foreground mt-4 text-center">
              {t("auth.contactAdmin")}
            </p>
            <div className="mt-4 flex items-center justify-center gap-3 text-xs text-muted-foreground">
              <Link to="/" className="hover:text-foreground">
                {t("auth.backToHome")}
              </Link>
              <span aria-hidden>·</span>
              <Link to="/privacy" className="hover:text-foreground">
                {t("nav.privacy")}
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Dialog "¿Olvidaste tu contraseña?" */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              {t("auth.forgot.title", { defaultValue: "Recuperar contraseña" })}
            </DialogTitle>
            <DialogDescription>
              {t("auth.forgot.subtitle", {
                defaultValue:
                  "Ingresa el correo de tu cuenta. Te enviaremos un enlace para definir una nueva contraseña.",
              })}
            </DialogDescription>
          </DialogHeader>

          {!forgotSent ? (
            <form onSubmit={onForgotSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="forgot-email" required>
                  {t("auth.institutionalEmail")}
                </Label>
                <Input
                  id="forgot-email"
                  type="email"
                  placeholder="usuario@institucion.edu"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setForgotOpen(false)}
                  disabled={forgotLoading}
                >
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={forgotLoading || !forgotEmail.trim()}>
                  {forgotLoading ? (
                    <Spinner size="sm" className="mr-2" />
                  ) : (
                    <Mail className="h-4 w-4 mr-2" />
                  )}
                  {t("auth.forgot.send", { defaultValue: "Enviar enlace" })}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-md border bg-muted/40 text-sm">
                <Mail className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                <p>
                  {t("auth.forgot.sent", {
                    defaultValue:
                      "Si esa dirección está registrada, recibirás un correo con el enlace de recuperación en los próximos minutos. Revisa también la carpeta de spam.",
                  })}
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setForgotOpen(false)} className="w-full">
                  {t("common.close", { defaultValue: "Cerrar" })}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
