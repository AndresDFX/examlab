import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { logEvent } from "@/shared/lib/audit";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
import { GraduationCap, KeyRound, Mail, Eye, EyeOff, Building2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { hardNavigateToTenant, getTenantSlugFromUrl } from "@/modules/tenants/url";
import { friendlyError } from "@/shared/lib/db-errors";

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

function AuthPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
  // Slug seleccionado. Pre-llenado con el slug de la URL si el usuario
  // llegó vía `/t/<slug>/auth` (ej. shareable link).
  const [selectedSlug, setSelectedSlug] = useState<string>(() => {
    const fromUrl = getTenantSlugFromUrl();
    return fromUrl ?? "";
  });

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
        // Hard navigate para que el router se reinicie con el basepath
        // correcto. El guard prefijará al tenant del profile.
        hardNavigateToTenant(null, "/app");
      }
    });
  }, []);

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
      toast.success(t("auth.welcome"));

      // Hard navigate al app con el prefijo correcto. Esto recarga la
      // página para que `router.tsx` recompute el `basepath` con el
      // nuevo slug. Sin reload, el router se quedaría en basepath="" y
      // las navegaciones internas no incluirían el prefijo.
      hardNavigateToTenant(targetSlug, "/app");
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
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
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
              <Button type="submit" className="w-full" disabled={loading || !selectedSlug}>
                {loading && <Spinner size="md" className="mr-2" />} {t("auth.submit")}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground mt-4 text-center">
              {t("auth.contactAdmin")}
            </p>
            <div className="mt-4 text-center">
              <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
                {t("auth.backToHome")}
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Dialog "¿Olvidaste tu contraseña?" */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="sm:max-w-md">
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
