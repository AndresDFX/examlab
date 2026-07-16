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

const PLAN_LABEL: Record<PlanKey, string> = {
  Starter: "Starter (≤200)",
  Pequena: "Pequeña (≤1.000)",
  Mediana: "Mediana (≤3.000)",
  Grande: "Grande (≤10.000)",
  Enterprise: "Enterprise (custom)",
};

const MODELO_LABEL: Record<ModeloNegocio, string> = {
  1: "1 · Autogestionada (sin admin mía)",
  2: "2 · Administrada (yo opero el tenant)",
  3: "3 · Independientes (mi admin ligera)",
};

const usd = (n: number, dec = 0) =>
  n.toLocaleString("es-CO", { style: "currency", currency: "USD", minimumFractionDigits: dec, maximumFractionDigits: dec });

const pct = (n: number) => `${(n * 100).toLocaleString("es-CO", { maximumFractionDigits: 1 })}%`;

function PricingCalculatorPage() {
  const { roles, loading } = useAuth();

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
    toast.success("Escala exportada a CSV");
  };

  if (loading) return <SectionLoader text="Cargando…" />;
  if (!roles.includes("SuperAdmin")) return <Navigate to="/app" />;

  return (
    <div className="space-y-5 pb-8">
      <PageHeader
        icon={<Calculator className="h-6 w-6" />}
        title="Calculadora de precios"
        subtitle={
          source === "db"
            ? "Supuestos desde la base de datos · uso interno (costos y márgenes)"
            : "Supuestos por defecto (tabla no configurada) · uso interno"
        }
        actions={
          <Button variant="outline" onClick={exportCsv}>
            <Download className="h-4 w-4 mr-2" />
            Exportar escala (CSV)
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_1fr] gap-5 items-start">
        {/* ── Formulario de entrada ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Parámetros</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="matriculas" required>
                Matrículas activas
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
                Plan{" "}
                <HelpHint>Se autoselecciona según el volumen. Cambialo para forzar un plan distinto.</HelpHint>
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
              <Label>Modelo de negocio</Label>
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
                Margen objetivo (%)
              </Label>
              <DecimalInput
                id="margen"
                value={margen}
                onChange={setMargen}
                min={0}
                max={99}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">Decimales con coma (ej. 90). Se limita a 99%.</p>
            </div>

            <div className="space-y-3 pt-1">
              <ToggleRow
                label="Aislamiento dedicado"
                hint="Instancia Supabase dedicada por tenant (gestionada por mí). Ignorado en el modelo 3."
                checked={aislamiento}
                disabled={modelo === 3}
                onChange={setAislamiento}
              />
              <ToggleRow label="Descuento anual (−10%)" checked={descuentoAnual} onChange={setDescuentoAnual} />
              <ToggleRow
                label="IA administrada (yo pago la IA)"
                hint="Suma el costo real de IA por matrícula/mes. En BYO (cliente paga su key) dejar apagado."
                checked={iaAdmin}
                onChange={setIaAdmin}
              />
              <ToggleRow label="Code runner dedicado" checked={codeRunner} onChange={setCodeRunner} />
              <ToggleRow label="SSO" checked={sso} onChange={setSso} />
              <ToggleRow label="Certificación / cumplimiento" checked={certificacion} onChange={setCertificacion} />
            </div>

            <div>
              <Label htmlFor="storageExtra">Storage extra (GB)</Label>
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
                <Hero label="Precio sugerido / mes" value={usd(quote.precioSugerido)} accent />
                <Hero
                  label={descuentoAnual ? "Precio final (anual −10%)" : "Precio final / mes"}
                  value={usd(quote.precioFinal)}
                />
                <Hero label="Costo total / mes" value={usd(quote.costoTotal, 2)} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t">
                <Metric label="Margen" value={pct(quote.margenPct)} />
                <Metric label="Ganancia / mes" value={usd(quote.margenUsd, 2)} />
                <Metric
                  label="$ / matrícula"
                  value={quote.dollarPorMatricula == null ? "—" : usd(quote.dollarPorMatricula, 3)}
                />
                <Metric
                  label="Vs. lista v3"
                  value={
                    quote.precioLista == null
                      ? "—"
                      : `${quote.deltaVsLista != null && quote.deltaVsLista > 0 ? "+" : ""}${usd(quote.deltaVsLista ?? 0)}`
                  }
                  sub={quote.precioLista == null ? undefined : `lista ${usd(quote.precioLista)}`}
                />
              </div>
            </CardContent>
          </Card>

          {/* Desglose de costo */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Desglose del costo mensual (a ExamLab)</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableBody>
                  <BreakRow label="Infraestructura (siempre de ExamLab)" value={usd(quote.costoInfra, 2)} />
                  <BreakRow label={`Operación humana (modelo ${modelo})`} value={usd(quote.costoHumano, 2)} />
                  <BreakRow label="Add-ons" value={usd(quote.addonCost, 2)} />
                  <BreakRow label="Storage sobre el cap" value={usd(quote.storageOverage, 2)} />
                  <TableRow className="font-semibold border-t-2">
                    <TableCell>Costo total</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(quote.costoTotal, 2)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <div className="px-4 py-2 text-xs text-muted-foreground">
                Storage estimado: {quote.gbNecesario.toLocaleString("es-CO", { maximumFractionDigits: 1 })} GB necesarios ·{" "}
                {quote.gbIncluido} GB incluidos{quote.gbSobre > 0 ? ` · ${quote.gbSobre.toFixed(1)} GB sobre el cap` : ""}.
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
                    <span>{w}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Tabla por escala */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Escala (con los parámetros actuales)</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Matrículas</TableHead>
                    <TableHead className="hidden sm:table-cell">Plan</TableHead>
                    <TableHead className="text-right">Costo</TableHead>
                    <TableHead className="text-right">Precio sug.</TableHead>
                    <TableHead className="text-right hidden md:table-cell">Precio final</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Margen</TableHead>
                    <TableHead className="text-right hidden lg:table-cell">$/matr.</TableHead>
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
