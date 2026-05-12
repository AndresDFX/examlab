import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, CheckCircle2, XCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// Boton de diagnostico para validar que el pipeline de edge functions
// funciona end-to-end:
//   - El bundle del frontend apunta al Supabase correcto (mediante
//     supabase.functions.invoke).
//   - La funcion `health-check` esta desplegada y responde.
//   - La autenticacion via JWT del usuario actual pasa.
//
// La funcion se despliega automaticamente por GitHub Actions desde
// supabase/functions/health-check/index.ts en cada push a main.
type Result =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: unknown; latencyMs: number }
  | { state: "error"; message: string; latencyMs: number };

export function EdgeFunctionHealthCheck() {
  const [result, setResult] = useState<Result>({ state: "idle" });

  async function run() {
    setResult({ state: "loading" });
    const start = performance.now();
    try {
      const { data, error } = await supabase.functions.invoke("health-check", {
        body: { source: "admin-button", ts: new Date().toISOString() },
      });
      const latencyMs = Math.round(performance.now() - start);
      if (error) {
        setResult({ state: "error", message: error.message, latencyMs });
        return;
      }
      setResult({ state: "ok", data, latencyMs });
    } catch (e) {
      const latencyMs = Math.round(performance.now() - start);
      const message = e instanceof Error ? e.message : String(e);
      setResult({ state: "error", message, latencyMs });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-cyan-500" />
          Edge function: health-check
        </CardTitle>
        <CardDescription>
          Llama a la edge function <code className="text-xs">health-check</code> del Supabase
          configurado y muestra la respuesta. Útil para verificar que el pipeline de despliegue
          de funciones quedó bien después de migrar o ante una sospecha de regresión.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={result.state === "loading"}>
            {result.state === "loading" ? (
              <>
                <Spinner size="sm" /> Probando…
              </>
            ) : (
              "Probar edge function"
            )}
          </Button>
          {result.state !== "idle" && result.state !== "loading" && (
            <Button variant="ghost" onClick={() => setResult({ state: "idle" })}>
              Limpiar
            </Button>
          )}
        </div>

        {result.state === "ok" && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              Respuesta OK ({result.latencyMs} ms)
            </div>
            <pre className="overflow-x-auto rounded bg-background/60 p-3 text-xs">
              {JSON.stringify(result.data, null, 2)}
            </pre>
          </div>
        )}

        {result.state === "error" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-destructive">
              <XCircle className="h-4 w-4" />
              Error ({result.latencyMs} ms)
            </div>
            <p className="text-xs text-muted-foreground">{result.message}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Posibles causas: la función no está desplegada en este proyecto, el JWT del usuario
              expiró, o el VITE_SUPABASE_URL del bundle apunta a otro Supabase.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
