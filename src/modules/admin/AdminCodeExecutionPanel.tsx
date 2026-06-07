/**
 * Panel de configuración del proveedor de ejecución de código (Admin).
 *
 * Proveedores:
 *   onlinecompiler — OnlineCompiler.io (principal, sin cuota diaria)
 *   jdoodle        — JDoodle (fallback, requiere JDOODLE_CLIENT_ID + JDOODLE_CLIENT_SECRET)
 *   cheerp         — CheerpJ browser-side (Java corre en el navegador; otros lenguajes
 *                    usan OnlineCompiler.io igualmente)
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { HelpHint } from "@/components/ui/help-hint";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Save, Info, Code2, MonitorPlay, Terminal } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type CodeProvider = "onlinecompiler" | "jdoodle" | "cheerp" | "aws_lambda";
type JavaGuiProvider = "cheerp" | "aws_screenshot";
// Solo aws_screenshot por ahora — no existe Pyodide+tkinter en WASM.
// Modelado como type union para que TS reclame si se añade un valor en
// el CHECK sin extender el front.
type PythonGuiProvider = "aws_screenshot";

type ProviderRow = {
  id: string;
  provider: CodeProvider;
  java_gui_provider: JavaGuiProvider;
  python_gui_provider: PythonGuiProvider;
  is_active: boolean;
};

const JAVA_GUI_LABELS: Record<JavaGuiProvider, string> = {
  cheerp: "CheerpJ — navegador (interactivo)",
  aws_screenshot: "AWS Lambda + Xvfb — captura PNG (no interactivo)",
};

const JAVA_GUI_DESCRIPTION: Record<JavaGuiProvider, string> = {
  cheerp:
    "Swing/AWT/JavaFX corre completamente en el navegador del estudiante (WebAssembly). El alumno puede clickear, escribir, interactuar con la ventana en tiempo real. Requiere licencia comercial para uso multi-usuario en producción — ver docs/JAVA-GUI-OPTIONS.md.",
  aws_screenshot:
    "AWS Lambda corre la app Swing bajo Xvfb (display virtual) y devuelve UNA captura PNG. El alumno solo VE la ventana — no puede clickear ni probar eventos. Útil como modo 'submit & ver render' sin licencia. Requiere desplegar la Lambda con Xvfb + ImageMagick (ver aws/code-runner/).",
};

const JAVA_GUI_SECRETS: Record<JavaGuiProvider, string[]> = {
  cheerp: [],
  aws_screenshot: [
    "AWS_RUNNER_URL (mismo endpoint que el provider aws_lambda)",
    "AWS_RUNNER_API_KEY",
  ],
};

// Python GUI (tkinter). Hoy solo hay un provider: AWS Lambda con Xvfb
// + tkinter (server-side, captura PNG). El alumno NO interactúa. No
// existe equivalente client-side (no hay Pyodide+tkinter en WASM).
const PYTHON_GUI_LABELS: Record<PythonGuiProvider, string> = {
  aws_screenshot: "AWS Lambda + Xvfb — captura PNG (no interactivo)",
};

const PYTHON_GUI_DESCRIPTION: Record<PythonGuiProvider, string> = {
  aws_screenshot:
    "AWS Lambda corre la app tkinter bajo Xvfb (display virtual) y devuelve UNA captura PNG. El alumno solo VE la ventana — no puede clickear ni probar eventos. Requiere desplegar la misma Lambda que para Java GUI (ya tiene Python + tkinter en el container).",
};

const PYTHON_GUI_SECRETS: Record<PythonGuiProvider, string[]> = {
  aws_screenshot: [
    "AWS_RUNNER_URL (mismo endpoint que el provider aws_lambda)",
    "AWS_RUNNER_API_KEY",
  ],
};

const PROVIDER_LABELS: Record<CodeProvider, string> = {
  onlinecompiler: "OnlineCompiler.io (API externa)",
  jdoodle: "JDoodle (fallback)",
  cheerp: "CheerpJ — navegador (solo Java)",
  aws_lambda: "AWS Lambda — runner propio (recomendado para Java)",
};

const PROVIDER_DESCRIPTION: Record<CodeProvider, string> = {
  onlinecompiler:
    "API síncrona, 12 lenguajes, sin cuota diaria. Requiere el secret ONLINE_COMPILER_API_KEY.",
  jdoodle:
    "API clásica de JDoodle. Cuota de 200 ejecuciones/día en el plan gratuito. Requiere JDOODLE_CLIENT_ID y JDOODLE_CLIENT_SECRET.",
  cheerp:
    "Java corre completamente en el navegador del estudiante (WebAssembly). Sin API externa ni cuota. Los demás lenguajes siguen usando OnlineCompiler.io.",
  aws_lambda:
    "Lambda con OpenJDK 21 desplegada en TU cuenta de AWS. Cabe en Always Free hasta ~50K execs/mes. Compile errors completos (línea + mensaje). Otros lenguajes caen automáticamente a OnlineCompiler.io. Ver aws/code-runner/README.md para el deploy.",
};

const PROVIDER_SECRETS: Record<CodeProvider, string[]> = {
  onlinecompiler: ["ONLINE_COMPILER_API_KEY"],
  jdoodle: ["JDOODLE_CLIENT_ID", "JDOODLE_CLIENT_SECRET"],
  cheerp: ["ONLINE_COMPILER_API_KEY (para lenguajes distintos a Java)"],
  aws_lambda: [
    "AWS_RUNNER_URL (Function URL)",
    "AWS_RUNNER_API_KEY (shared secret en SSM)",
    "ONLINE_COMPILER_API_KEY (fallback para lenguajes no-Java)",
  ],
};

export function AdminCodeExecutionPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [activeRow, setActiveRow] = useState<ProviderRow | null>(null);
  const [draftProvider, setDraftProvider] = useState<CodeProvider>("onlinecompiler");
  const [draftJavaGui, setDraftJavaGui] = useState<JavaGuiProvider>("cheerp");
  const [draftPythonGui, setDraftPythonGui] = useState<PythonGuiProvider>("aws_screenshot");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("code_execution_settings")
      .select("id, provider, java_gui_provider, python_gui_provider, is_active")
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar la configuración."));
      setLoading(false);
      return;
    }
    if (data) {
      const row = data as ProviderRow;
      setActiveRow(row);
      setDraftProvider(row.provider);
      setDraftJavaGui((row.java_gui_provider as JavaGuiProvider) ?? "cheerp");
      setDraftPythonGui((row.python_gui_provider as PythonGuiProvider) ?? "aws_screenshot");
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const dirty =
    !activeRow ||
    draftProvider !== activeRow.provider ||
    draftJavaGui !== (activeRow.java_gui_provider ?? "cheerp") ||
    draftPythonGui !== (activeRow.python_gui_provider ?? "aws_screenshot");

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      // Desactivar todas las activas
      const { error: deactErr } = await db
        .from("code_execution_settings")
        .update({ is_active: false, updated_by: user.id })
        .eq("is_active", true);
      if (deactErr) {
        toast.error(friendlyError(deactErr));
        return;
      }

      // Insertar nueva activa
      const { error: insErr } = await db.from("code_execution_settings").insert({
        provider: draftProvider,
        java_gui_provider: draftJavaGui,
        python_gui_provider: draftPythonGui,
        is_active: true,
        updated_by: user.id,
      });
      if (insErr) {
        toast.error(friendlyError(insErr));
        return;
      }

      void logEvent({
        action: "code_execution.provider_changed",
        category: "system",
        severity: "warning",
        entityType: "code_execution_settings",
        entityName: `${draftProvider} / ${draftJavaGui} / ${draftPythonGui}`,
        metadata: {
          previous_provider: activeRow?.provider ?? null,
          new_provider: draftProvider,
          previous_java_gui_provider: activeRow?.java_gui_provider ?? null,
          new_java_gui_provider: draftJavaGui,
          previous_python_gui_provider: activeRow?.python_gui_provider ?? null,
          new_python_gui_provider: draftPythonGui,
        },
      });

      toast.success("Configuración de ejecución actualizada");
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="md" /> Cargando configuración…
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <ErrorState
        message="No pudimos cargar la configuración de ejecución de código"
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Code2 className="h-4 w-4 text-indigo-500" />
            Proveedor de ejecución de código
            {activeRow && (
              <Badge variant="secondary" className="text-[10px]">
                {PROVIDER_LABELS[activeRow.provider]}
              </Badge>
            )}
            <HelpHint>{t("help.defaultCodeProviderHelp")}</HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Configuración global para toda la plataforma. Si un proveedor falla, cambia aquí sin
            redeployar.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={draftProvider}
            onValueChange={(v) => setDraftProvider(v as CodeProvider)}
            className="space-y-3"
          >
            {(["aws_lambda", "onlinecompiler", "cheerp", "jdoodle"] as CodeProvider[]).map((p) => (
              <div
                key={p}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  draftProvider === p
                    ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/20"
                    : "hover:bg-muted/50"
                }`}
                onClick={() => setDraftProvider(p)}
              >
                <RadioGroupItem value={p} id={`provider-${p}`} className="mt-0.5" />
                <div className="space-y-0.5">
                  <Label htmlFor={`provider-${p}`} className="text-sm font-medium cursor-pointer">
                    {PROVIDER_LABELS[p]}
                  </Label>
                  <p className="text-xs text-muted-foreground">{PROVIDER_DESCRIPTION[p]}</p>
                </div>
              </div>
            ))}
          </RadioGroup>

          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-medium flex items-center gap-1.5">
              <Terminal className="h-3.5 w-3.5 text-emerald-600" />
              Tipo <code className="text-[11px]">codigo</code> (texto / consola)
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Usa el proveedor configurado arriba. Para Java: corre en{" "}
              <strong>{PROVIDER_LABELS[draftProvider]}</strong>. Para otros lenguajes (Python, JS,
              C++…) cae a OnlineCompiler.io.
            </p>
          </div>

          {/* Selector separado para preguntas java_gui (Swing/AWT/JavaFX) */}
          <div className="space-y-2">
            <Label className="text-sm font-medium flex items-center gap-1.5">
              <MonitorPlay className="h-4 w-4 text-amber-600" />
              Proveedor para preguntas <code className="text-[11px]">java_gui</code>
              <HelpHint>{t("help.javaGuiProviderHelp")}</HelpHint>
            </Label>
            <RadioGroup
              value={draftJavaGui}
              onValueChange={(v) => setDraftJavaGui(v as JavaGuiProvider)}
              className="space-y-2"
            >
              {(["cheerp", "aws_screenshot"] as JavaGuiProvider[]).map((p) => (
                <div
                  key={p}
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    draftJavaGui === p
                      ? "border-amber-500 bg-amber-50 dark:bg-amber-950/20"
                      : "hover:bg-muted/50"
                  }`}
                  onClick={() => setDraftJavaGui(p)}
                >
                  <RadioGroupItem value={p} id={`java-gui-${p}`} className="mt-0.5" />
                  <div className="space-y-0.5">
                    <Label htmlFor={`java-gui-${p}`} className="text-sm font-medium cursor-pointer">
                      {JAVA_GUI_LABELS[p]}
                    </Label>
                    <p className="text-xs text-muted-foreground">{JAVA_GUI_DESCRIPTION[p]}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* Selector para python_gui (tkinter). Solo un provider posible
              hoy (aws_screenshot) — lo dejamos como RadioGroup igual para
              que la UX sea consistente con java_gui y para que extender
              en el futuro sea solo añadir un valor al array. */}
          <div className="space-y-2">
            <Label className="text-sm font-medium flex items-center gap-1.5">
              <MonitorPlay className="h-4 w-4 text-sky-600" />
              Proveedor para preguntas <code className="text-[11px]">python_gui</code>
              <HelpHint>{t("help.pythonGuiProviderHelp")}</HelpHint>
            </Label>
            <RadioGroup
              value={draftPythonGui}
              onValueChange={(v) => setDraftPythonGui(v as PythonGuiProvider)}
              className="space-y-2"
            >
              {(["aws_screenshot"] as PythonGuiProvider[]).map((p) => (
                <div
                  key={p}
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    draftPythonGui === p
                      ? "border-sky-500 bg-sky-50 dark:bg-sky-950/20"
                      : "hover:bg-muted/50"
                  }`}
                  onClick={() => setDraftPythonGui(p)}
                >
                  <RadioGroupItem value={p} id={`python-gui-${p}`} className="mt-0.5" />
                  <div className="space-y-0.5">
                    <Label
                      htmlFor={`python-gui-${p}`}
                      className="text-sm font-medium cursor-pointer"
                    >
                      {PYTHON_GUI_LABELS[p]}
                    </Label>
                    <p className="text-xs text-muted-foreground">{PYTHON_GUI_DESCRIPTION[p]}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs space-y-2">
              <div>
                <p>
                  Secrets para <strong>{PROVIDER_LABELS[draftProvider]}</strong> (tipo{" "}
                  <code className="text-[11px]">codigo</code>):
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  {PROVIDER_SECRETS[draftProvider].map((s) => (
                    <li key={s}>
                      <code className="text-[11px]">{s}</code>
                    </li>
                  ))}
                </ul>
              </div>
              {JAVA_GUI_SECRETS[draftJavaGui].length > 0 && (
                <div>
                  <p>
                    Secrets para <strong>{JAVA_GUI_LABELS[draftJavaGui]}</strong> (tipo{" "}
                    <code className="text-[11px]">java_gui</code>):
                  </p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {JAVA_GUI_SECRETS[draftJavaGui].map((s) => (
                      <li key={s}>
                        <code className="text-[11px]">{s}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {PYTHON_GUI_SECRETS[draftPythonGui].length > 0 && (
                <div>
                  <p>
                    Secrets para <strong>{PYTHON_GUI_LABELS[draftPythonGui]}</strong> (tipo{" "}
                    <code className="text-[11px]">python_gui</code>):
                  </p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {PYTHON_GUI_SECRETS[draftPythonGui].map((s) => (
                      <li key={s}>
                        <code className="text-[11px]">{s}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="pt-1">
                Configúralos en Admin → Edge Function Secrets antes de activar.
              </p>
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2 justify-end pt-1">
            {dirty && activeRow && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraftProvider(activeRow.provider);
                  setDraftJavaGui((activeRow.java_gui_provider as JavaGuiProvider) ?? "cheerp");
                  setDraftPythonGui(
                    (activeRow.python_gui_provider as PythonGuiProvider) ?? "aws_screenshot",
                  );
                }}
                disabled={saving}
              >
                Cancelar
              </Button>
            )}
            <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? <Spinner size="md" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Guardar configuración
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
