/**
 * SuperAdmin → Calculadora de precios (interna).
 *
 * Herramienta comercial SOLO del dueño de la plataforma: dado un volumen de
 * matrículas + plan + modelo de negocio + add-ons, calcula el costo real a
 * ExamLab (infra + humano + add-ons + storage) y el precio de venta sugerido
 * con margen parametrizable. NO se expone al Admin del tenant (RBAC ya acota
 * /app/superadmin/* a SuperAdmin; NO hay herencia desde Admin en esta ruta).
 *
 * El motor de cálculo es PURO y vive en src/modules/pricing/pricing-engine.ts
 * (testeado). Los supuestos se leen de la tabla `pricing_assumptions` (SA-only)
 * con fallback a FALLBACK_ASSUMPTIONS si la tabla aún no existe/está vacía.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Calculator, Download, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/ui/page-header";
import { SectionLoader } from "@/components/ui/loaders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Switch } from "@/components/ui/switch";
import { HelpHint } from "@/components/ui/help-hint";
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
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  FALLBACK_ASSUMPTIONS,
  PLAN_ORDER,
  computeQuote,
  scaleTable,
  suggestPlan,
  type ModeloNegocio,
  type PlanKey,
  type PricingAssumptions,
  type QuoteInput,
} from "@/modules/pricing/pricing-engine";

export const Route = createFileRoute("/app/superadmin/pricing-calculator")({
  component: PricingCalculatorPage,
});

const usd = (n: number, dec = 0) =>
  n.toLocaleString("es-CO", { style: "currency", currency: "USD", minimumFractionDigits: dec, maximumFractionDigits: dec });

const pct = (n: number) => `${(n * 100).toLocaleString("es-CO", { maximumFractionDigits: 1 })}%`;

function PricingCalculatorPage() {
  const { t } = useTranslation();
  const { roles, loading } = useAuth();

  const PLAN_LABEL: Record<PlanKey, string> = {
    Starter: t("pricingCalculator.planStarter", { defaultValue: "Starter (≤200)" }),
    Pequena: t("pricingCalculator.planPequena", { defaultValue: "Pequeña (≤1.000)" }),
    Mediana: t("pricingCalculator.planMediana", { defaultValue: "Mediana (≤3.000)" }),
    Grande: t("pricingCalculator.planGrande", { defaultValue: "Grande (≤10.000)" }),
    Enterprise: t("pricingCalculator.planEnterprise", { defaultValue: "Enterprise (custom)" }),
  };
  const MODELO_LABEL: Record<ModeloNegocio, string> = {
    1: t("pricingCalculator.modelo1", { defaultValue: "1 · Autogestionada (sin admin mía)" }),
    2: t("pricingCalculator.modelo2", { defaultValue: "2 · Administrada (yo opero el tenant)" }),
    3: t("pricingCalculator.modelo3", { defaultValue: "3 · Independientes (mi admin ligera)" }),
  };

  const [assumptions, setAssumptions] = useState<PricingAssumptions>(FALLBACK_ASSUMPTIONS);
  const [source, setSource] = useState<"db" | "fallback">("fallback");

  // Inputs (valores iniciales deterministas — sin browser APIs en el initializer).
  const [matriculas, setMatriculas] = useState<number | null>(1000);
  const [plan, setPlan] = useState<PlanKey>("Pequena");
  const [modelo, setModelo] = useState<ModeloNegocio>(1);
  const [aislamiento, setAislamiento] = useState(false);
  const [margen, setMargen] = useState<number | null>(FALLBACK_ASSUMPTIONS.margenDefault * 100);
  const [descuentoAnual, setDescuentoAnual] = useState(false);
  const [iaAdmin, setIaAdmin] = useState(false);
  const [storageExtraGb, setStorageExtraGb] = useState<number | null>(0);
  const [codeRunner, setCodeRunner] = useState(false);
  const [sso, setSso] = useState(false);
  const [certificacion, setCertificacion] = useState(false);
  const [planTouched, setPlanTouched] = useState(false);

  // Cargar supuestos de la tabla (SA-only). Fallback silencioso si no existe/vacía.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("pricing_assumptions" as never)
          .select("*")
          .limit(1)
          .maybeSingle();
        if (cancelled || error || !data) return;
        const row = data as Record<string, unknown>;
        setAssumptions({
          costoFijoMensual: Number(row.costo_fijo_mensual ?? FALLBACK_ASSUMPTIONS.costoFijoMensual),
          costoHumanoAdmin: Number(row.costo_humano_admin ?? FALLBACK_ASSUMPTIONS.costoHumanoAdmin),
          factorHumanoIndep: Number(row.factor_humano_indep ?? FALLBACK_ASSUMPTIONS.factorHumanoIndep),
          storageOverageUsdGb: Number(row.storage_overage_usd_gb ?? FALLBACK_ASSUMPTIONS.storageOverageUsdGb),
          egressOverageUsdGb: Number(row.egress_overage_usd_gb ?? FALLBACK_ASSUMPTIONS.egressOverageUsdGb),
          gbBasePorMatricula: Number(row.gb_base_por_matricula ?? FALLBACK_ASSUMPTIONS.gbBasePorMatricula),
          margenDefault: Number(row.margen_default ?? FALLBACK_ASSUMPTIONS.margenDefault),
          factorMateriasDefault: Number(row.factor_materias_default ?? FALLBACK_ASSUMPTIONS.factorMateriasDefault),
          descuentoAnual: Number(row.descuento_anual ?? FALLBACK_ASSUMPTIONS.descuentoAnual),
          scaleCurve: (row.scale_curve as PricingAssumptions["scaleCurve"]) ?? FALLBACK_ASSUMPTIONS.scaleCurve,
          plans: (row.plans as PricingAssumptions["plans"]) ?? FALLBACK_ASSUMPTIONS.plans,
          addons: (row.addons as PricingAssumptions["addons"]) ?? FALLBACK_ASSUMPTIONS.addons,
        });
        setSource("db");
      } catch {
        /* fallback ya seteado */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const n = Math.max(0, Math.floor(matriculas ?? 0));

  // Auto-sugerir plan por volumen hasta que el usuario elija manualmente.
  useEffect(() => {
    if (planTouched) return;
    setPlan(suggestPlan(n, assumptions));
  }, [n, assumptions, planTouched]);

  const input: QuoteInput = useMemo(
    () => ({
      matriculas: n,
      plan,
      modelo,
      aislamientoDedicado: aislamiento,
      margen: (margen ?? 0) / 100,
      descuentoAnual,
      iaAdmin,
      storageExtraGb: storageExtraGb ?? 0,
      codeRunner,
      sso,
      certificacion,
    }),
    [n, plan, modelo, aislamiento, margen, descuentoAnual, iaAdmin, storageExtraGb, codeRunner, sso, certificacion],
  );

  const quote = useMemo(() => computeQuote(input, assumptions), [input, assumptions]);
  const rows = useMemo(
    () =>
      scaleTable(
        {
          modelo,
          aislamientoDedicado: aislamiento,
          margen: (margen ?? 0) / 100,
          descuentoAnual,
          iaAdmin,
          storageExtraGb: storageExtraGb ?? 0,
          codeRunner,
          sso,
          certificacion,
        },
        assumptions,
      ),
    [modelo, aislamiento, margen, descuentoAnual, iaAdmin, storageExtraGb, codeRunner, sso, certificacion, assumptions],
  );

  const exportCsv = () => {
    const header = [
      "matriculas",
      "plan_sugerido",
      "modalidad",
      "costo_infra_usd",
      "costo_humano_usd",
      "addons_usd",
      "storage_overage_usd",
      "costo_total_usd",
      "precio_sugerido_usd",
      "precio_final_usd",
      "margen_pct",
      "usd_por_matricula",
    ];
    const fmt = (x: number | null) => (x == null ? "" : x.toFixed(4).replace(".", ","));
    const lines = rows.map((r) =>
      [
        r.matriculas,
        suggestPlan(r.matriculas, assumptions),
        r.modalidad,
        fmt(r.costoInfra),
        fmt(r.costoHumano),
        fmt(r.addonCost),
        fmt(r.storageOverage),
        fmt(r.costoTotal),
        fmt(r.precioSugerido),
        fmt(r.precioFinal),
        fmt(r.margenPct),
        fmt(r.dollarPorMatricula),
      ].join(";"),
    );
    const csv = [header.join(";"), ...lines].join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `examlab-escala-precios-modelo${modelo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t("pricingCalculator.exportedToast", { defaultValue: "Escala exportada a CSV" }));
  };

  if (loading) return <SectionLoader text={t("common.loading", { defaultValue: "Cargando…" })} />;
  if (!roles.includes("SuperAdmin")) return <Navigate to="/app" />;

  return (
    <div className="space-y-5 pb-8">
      <PageHeader
        icon={<Calculator className="h-6 w-6" />}
        title={t("pricingCalculator.title", { defaultValue: "Calculadora de precios" })}
        subtitle={
          source === "db"
            ? t("pricingCalculator.subtitleDb", {
                defaultValue: "Supuestos desde la base de datos · uso interno (costos y márgenes)",
              })
            : t("pricingCalculator.subtitleFallback", {
                defaultValue: "Supuestos por defecto (tabla no configurada) · uso interno",
              })
        }
        actions={
          <Button variant="outline" onClick={exportCsv}>
            <Download className="h-4 w-4 mr-2" />
            {t("pricingCalculator.exportCsv", { defaultValue: "Exportar escala (CSV)" })}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_1fr] gap-5 items-start">
        {/* ── Formulario de entrada ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("pricingCalculator.paramsTitle", { defaultValue: "Parámetros" })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="matriculas" required>
                {t("pricingCalculator.enrollments", { defaultValue: "Matrículas activas" })}
              </Label>
              <Input
                id="matriculas"
                type="number"
                min={0}
                value={matriculas ?? ""}
                onChange={(e) => setMatriculas(e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))))}
                className="mt-1"
              />
            </div>

            <div>
              <Label>
                {t("pricingCalculator.plan", { defaultValue: "Plan" })}{" "}
                <HelpHint>
                  {t("pricingCalculator.planHint", {
                    defaultValue: "Se autoselecciona según el volumen. Cambialo para forzar un plan distinto.",
                  })}
                </HelpHint>
              </Label>
              <Select
                value={plan}
                onValueChange={(v) => {
                  setPlan(v as PlanKey);
                  setPlanTouched(true);
                }}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_ORDER.map((k) => (
                    <SelectItem key={k} value={k}>
                      {PLAN_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>{t("pricingCalculator.businessModel", { defaultValue: "Modelo de negocio" })}</Label>
              <Select value={String(modelo)} onValueChange={(v) => setModelo(Number(v) as ModeloNegocio)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {([1, 2, 3] as ModeloNegocio[]).map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {MODELO_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="margen" required>
                {t("pricingCalculator.targetMargin", { defaultValue: "Margen objetivo (%)" })}
              </Label>
              <DecimalInput
                id="margen"
                value={margen}
                onChange={setMargen}
                min={0}
                max={99}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("pricingCalculator.marginHint", { defaultValue: "Decimales con coma (ej. 90). Se limita a 99%." })}
              </p>
            </div>

            <div className="space-y-3 pt-1">
              <ToggleRow
                label={t("pricingCalculator.toggleIsolation", { defaultValue: "Aislamiento dedicado" })}
                hint={t("pricingCalculator.toggleIsolationHint", {
                  defaultValue: "Instancia Supabase dedicada por tenant (gestionada por mí). Ignorado en el modelo 3.",
                })}
                checked={aislamiento}
                disabled={modelo === 3}
                onChange={setAislamiento}
              />
              <ToggleRow
                label={t("pricingCalculator.toggleAnnual", { defaultValue: "Descuento anual (−10%)" })}
                checked={descuentoAnual}
                onChange={setDescuentoAnual}
              />
              <ToggleRow
                label={t("pricingCalculator.toggleIaAdmin", { defaultValue: "IA administrada (yo pago la IA)" })}
                hint={t("pricingCalculator.toggleIaAdminHint", {
                  defaultValue: "Suma el costo real de IA por matrícula/mes. En BYO (cliente paga su key) dejar apagado.",
                })}
                checked={iaAdmin}
                onChange={setIaAdmin}
              />
              <ToggleRow
                label={t("pricingCalculator.toggleCodeRunner", { defaultValue: "Code runner dedicado" })}
                checked={codeRunner}
                onChange={setCodeRunner}
              />
              <ToggleRow label={t("pricingCalculator.toggleSso", { defaultValue: "SSO" })} checked={sso} onChange={setSso} />
              <ToggleRow
                label={t("pricingCalculator.toggleCert", { defaultValue: "Certificación / cumplimiento" })}
                checked={certificacion}
                onChange={setCertificacion}
              />
            </div>

            <div>
              <Label htmlFor="storageExtra">{t("pricingCalculator.storageExtra", { defaultValue: "Storage extra (GB)" })}</Label>
              <DecimalInput id="storageExtra" value={storageExtraGb} onChange={setStorageExtraGb} min={0} className="mt-1" />
            </div>
          </CardContent>
        </Card>

        {/* ── Resultado ── */}
        <div className="space-y-5">
          {/* Hero */}
          <Card className="border-primary/40">
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Hero label={t("pricingCalculator.heroSuggested", { defaultValue: "Precio sugerido / mes" })} value={usd(quote.precioSugerido)} accent />
                <Hero
                  label={
                    descuentoAnual
                      ? t("pricingCalculator.heroFinalAnnual", { defaultValue: "Precio final (anual −10%)" })
                      : t("pricingCalculator.heroFinalMonthly", { defaultValue: "Precio final / mes" })
                  }
                  value={usd(quote.precioFinal)}
                />
                <Hero label={t("pricingCalculator.heroTotalCost", { defaultValue: "Costo total / mes" })} value={usd(quote.costoTotal, 2)} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t">
                <Metric label={t("pricingCalculator.metricMargin", { defaultValue: "Margen" })} value={pct(quote.margenPct)} />
                <Metric label={t("pricingCalculator.metricProfit", { defaultValue: "Ganancia / mes" })} value={usd(quote.margenUsd, 2)} />
                <Metric
                  label={t("pricingCalculator.metricPerEnrollment", { defaultValue: "$ / matrícula" })}
                  value={quote.dollarPorMatricula == null ? "—" : usd(quote.dollarPorMatricula, 3)}
                />
                <Metric
                  label={t("pricingCalculator.metricVsList", { defaultValue: "Vs. precio de lista" })}
                  value={
                    quote.precioLista == null
                      ? "—"
                      : `${quote.deltaVsLista != null && quote.deltaVsLista > 0 ? "+" : ""}${usd(quote.deltaVsLista ?? 0)}`
                  }
                  sub={quote.precioLista == null ? undefined : t("pricingCalculator.metricListSub", { defaultValue: "lista {{price}}", price: usd(quote.precioLista) })}
                />
              </div>
            </CardContent>
          </Card>

          {/* Desglose de costo */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("pricingCalculator.breakdownTitle", { defaultValue: "Desglose del costo mensual (a ExamLab)" })}</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableBody>
                  <BreakRow label={t("pricingCalculator.breakInfra", { defaultValue: "Infraestructura (siempre de ExamLab)" })} value={usd(quote.costoInfra, 2)} />
                  <BreakRow label={t("pricingCalculator.breakHuman", { defaultValue: "Operación humana (modelo {{modelo}})", modelo })} value={usd(quote.costoHumano, 2)} />
                  <BreakRow label={t("pricingCalculator.breakAddons", { defaultValue: "Add-ons" })} value={usd(quote.addonCost, 2)} />
                  <BreakRow label={t("pricingCalculator.breakStorage", { defaultValue: "Storage sobre el cap" })} value={usd(quote.storageOverage, 2)} />
                  <TableRow className="font-semibold border-t-2">
                    <TableCell>{t("pricingCalculator.breakTotal", { defaultValue: "Costo total" })}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(quote.costoTotal, 2)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <div className="px-4 py-2 text-xs text-muted-foreground">
                {t("pricingCalculator.storageEstimate", {
                  defaultValue: "Storage estimado: {{needed}} GB necesarios · {{included}} GB incluidos",
                  needed: quote.gbNecesario.toLocaleString("es-CO", { maximumFractionDigits: 1 }),
                  included: quote.gbIncluido,
                })}
                {quote.gbSobre > 0
                  ? t("pricingCalculator.storageOver", { defaultValue: " · {{over}} GB sobre el cap", over: quote.gbSobre.toFixed(1) })
                  : ""}
                .
              </div>
            </CardContent>
          </Card>

          {/* Warnings */}
          {quote.warnings.length > 0 && (
            <Card className="border-amber-500/50">
              <CardContent className="pt-5 space-y-2">
                {quote.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                    <span>{t(`pricingCalculator.warn.${w.code}`, { ...(w.params ?? {}), defaultValue: w.code })}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Tabla por escala */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("pricingCalculator.scaleTitle", { defaultValue: "Escala (con los parámetros actuales)" })}</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("pricingCalculator.colEnrollments", { defaultValue: "Matrículas" })}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("pricingCalculator.colPlan", { defaultValue: "Plan" })}</TableHead>
                    <TableHead className="text-right">{t("pricingCalculator.colCost", { defaultValue: "Costo" })}</TableHead>
                    <TableHead className="text-right">{t("pricingCalculator.colSuggested", { defaultValue: "Precio sug." })}</TableHead>
                    <TableHead className="text-right hidden md:table-cell">{t("pricingCalculator.colFinal", { defaultValue: "Precio final" })}</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">{t("pricingCalculator.colMargin", { defaultValue: "Margen" })}</TableHead>
                    <TableHead className="text-right hidden lg:table-cell">{t("pricingCalculator.colPerEnrollment", { defaultValue: "$/matr." })}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.matriculas}>
                      <TableCell className="tabular-nums">{r.matriculas.toLocaleString("es-CO")}</TableCell>
                      <TableCell className="hidden sm:table-cell">{suggestPlan(r.matriculas, assumptions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(r.costoTotal, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{usd(r.precioSugerido)}</TableCell>
                      <TableCell className="text-right tabular-nums hidden md:table-cell">{usd(r.precioFinal)}</TableCell>
                      <TableCell className="text-right tabular-nums hidden sm:table-cell">{pct(r.margenPct)}</TableCell>
                      <TableCell className="text-right tabular-nums hidden lg:table-cell">
                        {r.dollarPorMatricula == null ? "—" : usd(r.dollarPorMatricula, 3)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm flex items-center">
        {label}
        {hint ? <HelpHint>{hint}</HelpHint> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function Hero({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${accent ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub ? <div className="text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function BreakRow({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground">{label}</TableCell>
      <TableCell className="text-right tabular-nums">{value}</TableCell>
    </TableRow>
  );
}
