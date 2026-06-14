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
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/shared/components/ThemeToggle";
import { GraduationCap, ShieldCheck, Sparkles, Eye, Code, Wifi, Clock } from "lucide-react";

/** Año actual leído post-mount. Antes era `{new Date().getFullYear()}`
 *  inline en el footer — eso difería entre el SSR de Lovable (fecha
 *  del worker en UTC) y el cliente (fecha del browser en su TZ), si la
 *  hidratación cruzaba medianoche. React 18 lo marcaba como #418
 *  intermitente. Renderemos el año en un componente con estado
 *  determinista que se sincroniza post-mount: el SSR sale con string
 *  vacío + el cliente lo rellena. Cero mismatch. */
function CurrentYear() {
  const [year, setYear] = useState<number | null>(null);
  useEffect(() => {
    setYear(new Date().getFullYear());
  }, []);
  // Antes del mount renderemos un placeholder invisible del mismo
  // ancho aproximado (4 chars) para que el layout no salte al hidratar.
  return <span>{year ?? "    "}</span>;
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: i18n.t("hc_routesIndex.metaTitle") },
      {
        name: "description",
        content: i18n.t("hc_routesIndex.metaDescription"),
      },
      { property: "og:title", content: i18n.t("hc_routesIndex.ogTitle") },
      {
        property: "og:description",
        content: i18n.t("hc_routesIndex.ogDescription"),
      },
    ],
  }),
  component: Home,
});

function Home() {
  const { t } = useTranslation();
  const features = [
    {
      icon: ShieldCheck,
      titleKey: "hc_routesIndex.featureRolesTitle",
      descKey: "hc_routesIndex.featureRolesDesc",
    },
    {
      icon: Sparkles,
      titleKey: "hc_routesIndex.featureAiTitle",
      descKey: "hc_routesIndex.featureAiDesc",
    },
    {
      icon: Eye,
      titleKey: "hc_routesIndex.featureProctoringTitle",
      descKey: "hc_routesIndex.featureProctoringDesc",
    },
    {
      icon: Code,
      titleKey: "hc_routesIndex.featureCompilerTitle",
      descKey: "hc_routesIndex.featureCompilerDesc",
    },
    {
      icon: Clock,
      titleKey: "hc_routesIndex.featureAttendanceTitle",
      descKey: "hc_routesIndex.featureAttendanceDesc",
    },
    {
      icon: Wifi,
      titleKey: "hc_routesIndex.featureOfflineTitle",
      descKey: "hc_routesIndex.featureOfflineDesc",
    },
  ];
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
              <Button>{t("hc_routesIndex.access")}</Button>
            </Link>
          </div>
        </div>
      </header>

      <section className="max-w-7xl mx-auto px-6 py-20 md:py-28 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent text-accent-foreground text-xs mb-6">
          <Sparkles className="h-3 w-3" /> {t("hc_routesIndex.heroBadge")}
        </div>
        <h1 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-4xl mx-auto leading-[1.1]">
          {t("hc_routesIndex.heroTitlePrefix")}{" "}
          <span className="text-primary">{t("hc_routesIndex.heroTitleHighlight")}</span>
          {t("hc_routesIndex.heroTitleSuffix")}
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
          {t("hc_routesIndex.heroSubtitle")}
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link to="/auth">
            <Button size="lg">{t("hc_routesIndex.startNow")}</Button>
          </Link>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-6 pb-24 grid md:grid-cols-3 gap-4">
        {features.map(({ icon: Icon, titleKey, descKey }) => (
          <div
            key={titleKey}
            className="p-6 rounded-xl border bg-card hover:border-primary/30 transition-colors"
          >
            <Icon className="h-6 w-6 text-primary mb-3" />
            <h3 className="font-semibold">{t(titleKey)}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t(descKey)}</p>
          </div>
        ))}
      </section>

      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        <div>© <CurrentYear /> {t("hc_routesIndex.footerBrand")}</div>
        <Link to="/privacy" className="mt-1 inline-block hover:text-foreground">
          {t("hc_routesIndex.privacyPolicy")}
        </Link>
      </footer>
    </div>
  );
}
