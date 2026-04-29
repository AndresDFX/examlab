import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Upload, Download, Trash2, FileText, RefreshCcw } from "lucide-react";

export const Route = createFileRoute("/app/storage-test")({
  component: StorageTestPage,
});

const BUCKET = "workshop-files";

interface StorageItem {
  name: string;
  size: number;
  updated_at: string;
}

function StorageTestPage() {
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<StorageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const userPrefix = user?.id ?? "anonymous";

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase.storage.from(BUCKET).list(userPrefix, {
      limit: 100,
      sortBy: { column: "updated_at", order: "desc" },
    });
    setLoading(false);
    if (error) {
      toast.error(`Error al listar: ${error.message}`);
      return;
    }
    setItems(
      (data ?? []).map((d) => ({
        name: d.name,
        size: (d.metadata as { size?: number } | null)?.size ?? 0,
        updated_at: d.updated_at ?? "",
      })),
    );
  };

  useEffect(() => {
    refresh();
  }, [user?.id]);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setUploading(true);
    const path = `${userPrefix}/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
      cacheControl: "3600",
      upsert: false,
    });
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (error) {
      toast.error(`Error al subir: ${error.message}`);
      return;
    }
    toast.success(`Subido: ${file.name}`);
    refresh();
  };

  const onDownload = async (name: string) => {
    const path = `${userPrefix}/${name}`;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      toast.error(`No se pudo generar URL: ${error?.message}`);
      return;
    }
    window.open(data.signedUrl, "_blank");
  };

  const onDelete = async (name: string) => {
    if (!confirm(`¿Eliminar ${name}?`)) return;
    const path = `${userPrefix}/${name}`;
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) {
      toast.error(`Error al eliminar: ${error.message}`);
      return;
    }
    toast.success("Eliminado");
    refresh();
  };

  const fmtSize = (b: number) =>
    b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

  if (!user) {
    return (
      <div className="p-8">
        <Card>
          <CardContent className="p-6">
            <p>Debes iniciar sesión para probar el storage.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileText className="w-6 h-6" /> Storage Test
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Bucket: <code className="bg-muted px-1 rounded">{BUCKET}</code> · Carpeta:{" "}
          <code className="bg-muted px-1 rounded">{userPrefix}/</code>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Subir archivo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={fileRef}
            type="file"
            onChange={onUpload}
            disabled={uploading}
            className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-primary file:text-primary-foreground hover:file:opacity-90"
          />
          {uploading && (
            <Badge variant="secondary" className="gap-1">
              <Upload className="w-3 h-3 animate-pulse" /> Subiendo…
            </Badge>
          )}
          <p className="text-xs text-muted-foreground">
            Límite: 50 MB · Persistido en Supabase Storage (S3 backend si está configurado).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Tus archivos</CardTitle>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {loading ? "Cargando…" : "No hay archivos. Sube uno arriba."}
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.name} className="py-3 flex items-center gap-3">
                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtSize(item.size)} · {item.updated_at && new Date(item.updated_at).toLocaleString()}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => onDownload(item.name)}>
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onDelete(item.name)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
