import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { GraduationCap, ShieldCheck, Sparkles, Eye } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ExamLab — Plataforma de Exámenes Online" },
      { name: "description", content: "Plataforma académica con IA, proctoring y gestión completa de exámenes para Admin, Docentes y Estudiantes." },
      { property: "og:title", content: "ExamLab — Plataforma de Exámenes Online" },
      { property: "og:description", content: "Diseña, asigna y califica exámenes con IA y proctoring integrado." },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="font-semibold text-lg">ExamLab</span>
          </div>
          <Link to="/auth"><Button>Acceder</Button></Link>
        </div>
      </header>

      <section className="max-w-7xl mx-auto px-6 py-20 md:py-28 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent text-accent-foreground text-xs mb-6">
          <Sparkles className="h-3 w-3" /> Calificación con IA · Proctoring integrado
        </div>
        <h1 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-4xl mx-auto leading-[1.1]">
          La plataforma moderna para <span className="text-primary">evaluar a tus estudiantes</span>.
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
          Crea exámenes con preguntas generadas por IA, asígnalos individualmente,
          gestiona supletorios y exporta calificaciones — todo en un solo lugar.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link to="/auth"><Button size="lg">Comenzar ahora</Button></Link>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-6 pb-24 grid md:grid-cols-3 gap-6">
        {[
          { icon: ShieldCheck, t: "Roles dinámicos", d: "Admin, Docente y Estudiante con permisos granulares y RLS en base de datos." },
          { icon: Sparkles, t: "Generación con IA", d: "Crea preguntas abiertas, cerradas y de código a partir de temas y rúbricas." },
          { icon: Eye, t: "Proctoring incluido", d: "Pantalla completa, bloqueo de copia y tracking de salida de pestaña." },
        ].map(({ icon: Icon, t, d }) => (
          <div key={t} className="p-6 rounded-xl border bg-card">
            <Icon className="h-6 w-6 text-primary mb-3" />
            <h3 className="font-semibold">{t}</h3>
            <p className="text-sm text-muted-foreground mt-1">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
