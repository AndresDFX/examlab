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
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { Award, Save, Info, ImageIcon, FileSignature, Upload } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { resizeImageForLogo } from "@/modules/tenants/image-resize";

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
  const { user, profile } = useAuth();
  const [row, setRow] = useState<CertSettings | null>(null);
  const [draft, setDraft] = useState<CertSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Upload del logo/firma: validamos+resize+subimos al bucket `tenant-logos`
  // (mismo bucket que el branding de la institución, distintos path
  // prefix `cert-logo.*` / `cert-signature.*` para no colisionar con
  // `logo.*` que usa el SuperAdmin para el branding del tenant). El path
  // queda como `${tenant_id}/cert-{kind}.{ext}` para satisfacer la RLS
  // del bucket que exige `(storage.foldername(name))[1] = tenant_id`.
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingSignature, setUploadingSignature] = useState(false);
  const logoFileRef = useRef<HTMLInputElement>(null);
  const signatureFileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db.from("certificate_settings").select("*").maybeSingle();
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar la configuración."));
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
  }, [retryNonce]);

  const dirty = !!draft && !!row && JSON.stringify(draft) !== JSON.stringify(row);

  /**
   * Sube una imagen (logo institucional o firma) al bucket tenant-logos
   * usando el tenant_id del Admin. Devuelve la URL pública o null si
   * falla (con toast). El draft se actualiza con la URL — todavía hay
   * que pulsar "Guardar configuración" para persistirla en
   * `certificate_settings`.
   */
  const uploadImage = async (file: File, kind: "logo" | "signature") => {
    if (!draft) return;
    const tenantId = profile?.tenant_id;
    if (!tenantId) {
      toast.error("No se pudo determinar el tenant para subir la imagen.");
      return;
    }
    // Validaciones tipo + tamaño (idénticas a las del logo del tenant).
    const validTypes = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
    if (!validTypes.includes(file.type)) {
      toast.error("Formato no soportado. Usa PNG, JPG, SVG o WebP.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("La imagen no puede pesar más de 2 MB.");
      return;
    }
    const setBusy = kind === "logo" ? setUploadingLogo : setUploadingSignature;
    const fileRef = kind === "logo" ? logoFileRef : signatureFileRef;
    setBusy(true);
    try {
      const { file: finalFile } = await resizeImageForLogo(file);
      const ext =
        finalFile.type === "image/png"
          ? "png"
          : finalFile.type === "image/jpeg"
            ? "jpg"
            : finalFile.type === "image/svg+xml"
              ? "svg"
              : "webp";
      const path = `${tenantId}/cert-${kind}.${ext}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await (supabase.storage as any)
        .from("tenant-logos")
        .upload(path, finalFile, { upsert: true, contentType: finalFile.type });
      if (upErr) {
        toast.error(friendlyError(upErr, "No se pudo subir la imagen"));
        return;
      }
      // Cache-bust con timestamp: el path es upsert (mismo path) así que
      // el browser cachearía la imagen vieja sin esto.
      const { data: pub } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      const cacheBustedUrl = `${pub?.publicUrl ?? ""}?v=${Date.now()}`;
      if (kind === "logo") {
        setDraft({ ...draft, institution_logo_url: cacheBustedUrl });
      } else {
        setDraft({ ...draft, signature_image_url: cacheBustedUrl });
      }
      toast.success("Imagen subida. Recuerda 'Guardar configuración' para aplicarla.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

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
        toast.error(friendlyError(error));
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

  if (loadError) {
    return (
      <ErrorState
        message="No pudimos cargar la configuración de certificados"
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

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
                Logo institucional
              </Label>
              {/* Upload + URL como alternativas. La URL se llena
                  automáticamente cuando subís un archivo; el input
                  queda editable por si preferís alojar el logo en
                  un CDN externo. */}
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <input
                  ref={logoFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadImage(f, "logo");
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => logoFileRef.current?.click()}
                  disabled={uploadingLogo || !profile?.tenant_id}
                >
                  {uploadingLogo ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Upload className="h-3.5 w-3.5 mr-1" />
                  )}
                  Subir imagen
                </Button>
                {draft.institution_logo_url && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDraft({ ...draft, institution_logo_url: "" })}
                  >
                    Quitar
                  </Button>
                )}
              </div>
              <Input
                value={draft.institution_logo_url ?? ""}
                onChange={(e) => setDraft({ ...draft, institution_logo_url: e.target.value })}
                placeholder="…o pegá una URL pública: https://…/logo.png"
                className="mt-2"
              />
              {draft.institution_logo_url && (
                <div className="mt-2 inline-block rounded border bg-muted/30 p-2 max-w-full">
                  <img
                    src={draft.institution_logo_url}
                    alt="preview"
                    className="h-12 w-auto max-w-full object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-1">
                PNG/SVG/JPG/WebP, hasta 2 MB. Resolución mínima 192×192, fondo transparente
                preferido.
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
              <Label>Imagen de la firma (opcional)</Label>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <input
                  ref={signatureFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadImage(f, "signature");
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => signatureFileRef.current?.click()}
                  disabled={uploadingSignature || !profile?.tenant_id}
                >
                  {uploadingSignature ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Upload className="h-3.5 w-3.5 mr-1" />
                  )}
                  Subir imagen
                </Button>
                {draft.signature_image_url && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDraft({ ...draft, signature_image_url: "" })}
                  >
                    Quitar
                  </Button>
                )}
              </div>
              <Input
                value={draft.signature_image_url ?? ""}
                onChange={(e) => setDraft({ ...draft, signature_image_url: e.target.value })}
                placeholder="…o pegá una URL pública: https://…/signature.png"
                className="mt-2"
              />
              {draft.signature_image_url && (
                <div className="mt-2 inline-block rounded border bg-muted/30 p-2 max-w-full">
                  <img
                    src={draft.signature_image_url}
                    alt="signature preview"
                    className="h-10 w-auto max-w-full object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-1">
                PNG con fondo transparente recomendado. Si está vacío, solo aparece la línea +
                nombre.
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
