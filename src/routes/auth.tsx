import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { GraduationCap, Loader2 } from "lucide-react";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Iniciar sesión — ExamLab" }, { name: "description", content: "Accede a la plataforma de exámenes" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [seedingLoading, setSeedingLoading] = useState(false);

  // login
  const [email, setEmail] = useState("andres_dfx@hotmail.com");
  const [password, setPassword] = useState("Tester#12345");

  // signup
  const [sName, setSName] = useState("");
  const [sInst, setSInst] = useState("");
  const [sPersonal, setSPersonal] = useState("");
  const [sPass, setSPass] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/app" });
    });
  }, [navigate]);

  const onLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      if (error.message.toLowerCase().includes("invalid")) {
        toast.error("Credenciales inválidas. Si es la primera vez, ejecuta el seeding.");
      } else toast.error(error.message);
      return;
    }
    toast.success("Bienvenido");
    navigate({ to: "/app" });
  };

  const onSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email: sInst,
      password: sPass,
      options: {
        emailRedirectTo: `${window.location.origin}/app`,
        data: { full_name: sName, institutional_email: sInst, personal_email: sPersonal },
      },
    });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Cuenta creada. Iniciando sesión…");
    const { error: e2 } = await supabase.auth.signInWithPassword({ email: sInst, password: sPass });
    if (!e2) navigate({ to: "/app" });
  };

  const runSeed = async () => {
    setSeedingLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("seed-data", { body: {} });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Error de seeding");
      toast.success("Datos iniciales cargados ✓");
    } catch (e: any) {
      toast.error(e.message ?? "Error");
    } finally {
      setSeedingLoading(false);
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
            <div className="text-sm text-sidebar-foreground/60">Plataforma académica</div>
          </div>
        </div>
        <div className="space-y-6">
          <h1 className="text-4xl font-semibold tracking-tight leading-tight">
            Diseña, asigna y califica exámenes con IA y proctoring integrado.
          </h1>
          <ul className="space-y-3 text-sidebar-foreground/80">
            <li>• Tres módulos: Admin, Docente, Estudiante</li>
            <li>• Asignación granular por estudiante y exámenes supletorios</li>
            <li>• Proctoring: pantalla completa + tracking de foco</li>
            <li>• Generación y calificación con IA</li>
          </ul>
        </div>
        <div className="text-xs text-sidebar-foreground/50">© ExamLab 2026</div>
      </div>

      {/* Auth panel */}
      <div className="flex items-center justify-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader>
            <CardTitle className="text-2xl">Acceso</CardTitle>
            <CardDescription>
              Usuario maestro: <code className="text-xs">andres_dfx@hotmail.com</code> / <code className="text-xs">Tester#12345</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="login">
              <TabsList className="grid grid-cols-2 w-full">
                <TabsTrigger value="login">Iniciar sesión</TabsTrigger>
                <TabsTrigger value="signup">Registrarse</TabsTrigger>
              </TabsList>

              <TabsContent value="login" className="space-y-3 mt-4">
                <form onSubmit={onLogin} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="li-email">Email institucional</Label>
                    <Input id="li-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="li-pass">Contraseña</Label>
                    <Input id="li-pass" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Entrar
                  </Button>
                </form>
                <div className="pt-3 border-t">
                  <p className="text-xs text-muted-foreground mb-2">¿Primera vez? Carga el usuario maestro y datos de prueba:</p>
                  <Button variant="outline" className="w-full" onClick={runSeed} disabled={seedingLoading}>
                    {seedingLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Inicializar datos demo
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="signup" className="space-y-3 mt-4">
                <form onSubmit={onSignup} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Nombre completo</Label>
                    <Input value={sName} onChange={e => setSName(e.target.value)} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Email institucional</Label>
                    <Input type="email" value={sInst} onChange={e => setSInst(e.target.value)} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Email personal (opcional)</Label>
                    <Input type="email" value={sPersonal} onChange={e => setSPersonal(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Contraseña</Label>
                    <Input type="password" value={sPass} onChange={e => setSPass(e.target.value)} required minLength={8} />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Crear cuenta
                  </Button>
                  <p className="text-xs text-muted-foreground">Por defecto se asigna rol Estudiante.</p>
                </form>
              </TabsContent>
            </Tabs>
            <div className="mt-4 text-center">
              <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">← Volver al inicio</Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
