/**
 * Landing pública (`/`) — la cara de marketing antes del login. Es la
 * URL que ve un visitante anónimo (examlab.lovable.app).
 *
 * Estructura fija (NO cambiar sin pedido explícito de diseño):
 *   - Header: logo + ThemeToggle + botón "Acceder" (→ /auth).
 *   - Hero centrado: badge de features, título con palabra en color
 *     primary, subtítulo, CTA "Comenzar ahora".
 *   - Grid de 6 feature cards (3-col en md+) — describen el alcance real
 *     del producto (multi-institución, IA, proctoring, código, asistencia,
 *     offline). Si se agrega/quita una feature mayor, actualizar este grid.
 *   - Footer minimal con año dinámico.
 *
 * Copy en español hardcodeado (NO i18n): la landing es pre-login, antes
 * de que el usuario elija idioma. Concepto = "plataforma integral para
 * instituciones", no solo exámenes.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/shared/components/ThemeToggle";
import { GraduationCap, ShieldCheck, Sparkles, Eye, Code, Wifi, Clock } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ExamLab — Plataforma de Gestión Educativa" },
      {
        name: "description",
        content:
          "Multi-institución, IA y proctoring para gestionar cursos, exámenes, talleres, proyectos, asistencia y certificados. Para Administradores, Docentes y Estudiantes.",
      },
      { property: "og:title", content: "ExamLab — Plataforma de Gestión Educativa" },
      {
        property: "og:description",
        content:
          "Cursos, exámenes con IA, talleres en grupo, proyectos con sustentación, asistencia con QR y certificados — todo en una sola plataforma.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <GraduationCap className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="font-semibold text-lg tracking-tight">ExamLab</span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle variant="outline" />
            <Link to="/auth">
              <Button>Acceder</Button>
            </Link>
          </div>
        </div>
      </header>

      <section className="max-w-7xl mx-auto px-6 py-20 md:py-28 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent text-accent-foreground text-xs mb-6">
          <Sparkles className="h-3 w-3" /> Multi-institución · IA · Proctoring · PWA
        </div>
        <h1 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-4xl mx-auto leading-[1.1]">
          La plataforma integral para tu <span className="text-primary">institución educativa</span>
          .
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
          Cursos, exámenes con IA, talleres en grupo, proyectos con sustentación, asistencia con QR
          y certificados — para Administradores, Docentes y Estudiantes en una sola plataforma.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link to="/auth">
            <Button size="lg">Comenzar ahora</Button>
          </Link>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-6 pb-24 grid md:grid-cols-3 gap-4">
        {[
          {
            icon: ShieldCheck,
            t: "Roles y multi-institución",
            d: "Admin, Docente, Estudiante y SuperAdmin con permisos granulares enforced en base de datos (RLS). Cada institución con su marca, usuarios y datos aislados.",
          },
          {
            icon: Sparkles,
            t: "Calificación con IA",
            d: "Genera preguntas y rúbricas con Gemini. Califica respuestas abiertas, código fuente y proyectos completos con feedback explicado al estudiante.",
          },
          {
            icon: Eye,
            t: "Proctoring y antifraude",
            d: "Pantalla completa, bloqueo de copia, salida de pestaña monitoreada y detección de respuestas generadas por IA. Análisis de similitud entre entregas.",
          },
          {
            icon: Code,
            t: "Compilador en vivo",
            d: "Editor Monaco con ejecución de Java, Python, JavaScript y C. Java GUI con screenshot via AWS Lambda. Override por pregunta para resiliencia.",
          },
          {
            icon: Clock,
            t: "Cortes, asistencia y QR",
            d: "Pesos por corte, asistencia integrada al cálculo de nota final y check-in self-service con código rotativo TOTP que el docente proyecta.",
          },
          {
            icon: Wifi,
            t: "Offline y PWA",
            d: "Instalable como app. Respuestas guardadas localmente en IndexedDB y sincronización automática al recuperar conexión. Push notifications nativas.",
          },
        ].map(({ icon: Icon, t, d }) => (
          <div
            key={t}
            className="p-6 rounded-xl border bg-card hover:border-primary/30 transition-colors"
          >
            <Icon className="h-6 w-6 text-primary mb-3" />
            <h3 className="font-semibold">{t}</h3>
            <p className="text-sm text-muted-foreground mt-1">{d}</p>
          </div>
        ))}
      </section>

      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} ExamLab — Plataforma académica
      </footer>
    </div>
  );
}
