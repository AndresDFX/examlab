/**
 * Panel global de configuración de certificaciones (Admin).
 *
 * Settings que aparecen en el PDF de cada certificado emitido:
 *   - Nombre + logo de la institución
 *   - Firma (nombre, cargo, imagen)
 *   - Mensaje principal del certificado (con placeholders {student}, {course}, {grade})
 *   - Pie de página
 *
 * El docente puede sobrescribir cualquiera de estos valores por curso en
 * la sección "Configuración de certificaciones" dentro del detalle del curso.
 * El RPC `resolve_certificate_settings(course_id)` hace el merge
 * course override → global → legacy content_brand_config → defaults.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { Award, Save, Info, ImageIcon, FileSignature } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface CertSettings {
  id: string;
  institution_name: string | null;
  institution_logo_url: string | null;
  signature_name: string | null;
  signature_title: string | null;
  signature_image_url: string | null;
  certificate_message: string | null;
  footer_text: string | null;
  updated_at: string;
}

export function AdminCertificateSettingsPanel() {
  const { user } = useAuth();
  const [row, setRow] = useState<CertSettings | null>(null);
  const [draft, setDraft] = useState<CertSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db.from("certificate_settings").select("*").maybeSingle();
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    if (data) {
      setRow(data);
      setDraft(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = !!draft && !!row && JSON.stringify(draft) !== JSON.stringify(row);

  const save = async () => {
    if (!user || !draft || !row) return;
    setSaving(true);
    try {
      const { error } = await db
        .from("certificate_settings")
        .update({
          institution_name: draft.institution_name?.trim() || null,
          institution_logo_url: draft.institution_logo_url?.trim() || null,
          signature_name: draft.signature_name?.trim() || null,
          signature_title: draft.signature_title?.trim() || null,
          signature_image_url: draft.signature_image_url?.trim() || null,
          certificate_message: draft.certificate_message?.trim() || null,
          footer_text: draft.footer_text?.trim() || null,
          updated_by: user.id,
        })
        .eq("id", row.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      void logEvent({
        action: "certificate_settings.updated",
        category: "system",
        severity: "warning",
        metadata: { previous: row, new: draft },
      });
      toast.success("Configuración guardada");
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading || !draft) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="sm" /> Cargando configuración…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Award className="h-4 w-4 text-amber-500" />
            Configuración global de certificaciones
            <HelpHint>
              Estos valores se usan al emitir certificados. Cada docente puede sobrescribirlos por
              curso desde el detalle del curso. Lo que el alumno descarga es un snapshot inmutable
              al momento de emisión.
            </HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Cambios aquí afectan certificados que se emitan a partir de ahora. Los certificados ya
            emitidos preservan los datos con los que fueron creados.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Institución */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Institución</h3>
            <div>
              <Label>Nombre institucional</Label>
              <Input
                value={draft.institution_name ?? ""}
                onChange={(e) => setDraft({ ...draft, institution_name: e.target.value })}
                placeholder="Ej: Universidad X"
              />
            </div>
            <div>
              <Label>
                <ImageIcon className="h-3.5 w-3.5 inline mr-1" />
                URL del logo institucional
              </Label>
              <Input
                value={draft.institution_logo_url ?? ""}
                onChange={(e) => setDraft({ ...draft, institution_logo_url: e.target.value })}
                placeholder="https://…/logo.png"
              />
              {draft.institution_logo_url && (
                <div className="mt-2 inline-block rounded border bg-muted/30 p-2">
                  <img
                    src={draft.institution_logo_url}
                    alt="preview"
                    className="h-12 w-auto"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-1">
                PNG/SVG/JPG. Resolución mínima 192×192, fondo transparente preferido.
              </p>
            </div>
          </div>

          {/* Firma */}
          <div className="space-y-3 pt-2 border-t">
            <h3 className="text-sm font-medium flex items-center gap-1.5">
              <FileSignature className="h-3.5 w-3.5" />
              Firma del certificado
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Nombre de quien firma</Label>
                <Input
                  value={draft.signature_name ?? ""}
                  onChange={(e) => setDraft({ ...draft, signature_name: e.target.value })}
                  placeholder="Ej: Juan Pérez"
                />
              </div>
              <div>
                <Label>Cargo</Label>
                <Input
                  value={draft.signature_title ?? ""}
                  onChange={(e) => setDraft({ ...draft, signature_title: e.target.value })}
                  placeholder="Ej: Decano de Ingeniería"
                />
              </div>
            </div>
            <div>
              <Label>URL de la imagen de la firma (opcional)</Label>
              <Input
                value={draft.signature_image_url ?? ""}
                onChange={(e) => setDraft({ ...draft, signature_image_url: e.target.value })}
                placeholder="https://…/signature.png"
              />
              {draft.signature_image_url && (
                <div className="mt-2 inline-block rounded border bg-muted/30 p-2">
                  <img
                    src={draft.signature_image_url}
                    alt="signature preview"
                    className="h-10 w-auto"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-1">
                PNG con fondo transparente. Si está vacío, solo aparece la línea + nombre.
              </p>
            </div>
          </div>

          {/* Mensaje + footer */}
          <div className="space-y-3 pt-2 border-t">
            <h3 className="text-sm font-medium">Texto del certificado</h3>
            <div>
              <Label>
                Mensaje principal{" "}
                <HelpHint>
                  Puedes usar placeholders: <code>{"{student}"}</code>, <code>{"{course}"}</code>,{" "}
                  <code>{"{grade}"}</code>, <code>{"{period}"}</code>, <code>{"{teacher}"}</code>,{" "}
                  <code>{"{date}"}</code>. Si está vacío, se usa el texto por defecto.
                </HelpHint>
              </Label>
              <Textarea
                value={draft.certificate_message ?? ""}
                onChange={(e) => setDraft({ ...draft, certificate_message: e.target.value })}
                rows={4}
                placeholder="Por la presente certificamos que {student} ha aprobado el curso {course} con una nota final de {grade}/{scale_max}."
              />
            </div>
            <div>
              <Label>Pie de página (opcional)</Label>
              <Input
                value={draft.footer_text ?? ""}
                onChange={(e) => setDraft({ ...draft, footer_text: e.target.value })}
                placeholder="Ej: Verifica la autenticidad escaneando el QR o visitando examlab.io/verify"
              />
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Los valores en blanco caen al default del PDF. Si configuras solo algunos campos, los
              demás conservan el comportamiento original.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2 justify-end pt-1">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(row)} disabled={saving}>
                Cancelar
              </Button>
            )}
            <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Guardar configuración
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
