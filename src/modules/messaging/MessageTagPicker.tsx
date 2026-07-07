/**
 * MessageTagPicker — dialog para que el usuario (estudiante o docente)
 * busque contenido de la plataforma y lo etiquete dentro del mensaje.
 *
 * Flujo:
 *   1. Tabs por tipo (Taller / Examen / Proyecto). En v1 NO incluimos
 *      Contenido / Video — la mayoría de tickets de soporte son sobre
 *      entregables (taller, examen, proyecto); contenidos los agregamos
 *      cuando salgan en mensajes.
 *   2. Lista filtrable por nombre dentro de cada tab.
 *   3. Click en un item → llama `onPick(tag)` con `{type, id, label}` y
 *      cierra el dialog.
 *   4. El caller (composer del mensaje) inyecta el token
 *      `[[T:type:id:label]]` al final del body actual y manda focus de
 *      vuelta al textarea.
 *
 * RLS hace el trabajo pesado: el estudiante solo verá items de sus
 * cursos matriculados, y el docente solo los suyos. No hacemos filtros
 * client-side por matrícula — confiamos en la BD.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchInput } from "@/components/ui/search-input";
import { SectionLoader } from "@/components/ui/loaders";
import { TAG_TYPE_LABEL, type ContentTag, type TagType } from "./message-tags";
import { Hammer, FileText, FolderKanban } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface PickableItem {
  id: string;
  title: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (tag: ContentTag) => void;
}

const TYPES: Array<{ value: TagType; icon: typeof Hammer; table: string; titleCol: string }> = [
  { value: "workshop", icon: Hammer, table: "workshops", titleCol: "title" },
  { value: "exam", icon: FileText, table: "exams", titleCol: "title" },
  { value: "project", icon: FolderKanban, table: "projects", titleCol: "title" },
];

export function MessageTagPicker({ open, onOpenChange, onPick }: Props) {
  const { t } = useTranslation();
  const [activeType, setActiveType] = useState<TagType>("workshop");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<PickableItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Cargamos al abrir y al cambiar de tab. Cada tab pega a una tabla
  // distinta (workshops/exams/projects) — no es un join, solo un select
  // del título + id. RLS filtra a lo accesible por el usuario.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const def = TYPES.find((t) => t.value === activeType)!;
      // exams/workshops/projects son entidades soft-delete: no listar en el
      // picker de `#` los que estén en la papelera.
      const { data } = await db
        .from(def.table)
        .select(`id, ${def.titleCol}`)
        .is("deleted_at", null)
        .order(def.titleCol)
        .limit(200);
      if (cancelled) return;
      setItems(
        (data ?? []).map((r: Record<string, unknown>) => ({
          id: String(r.id),
          title: String(r[def.titleCol] ?? "(sin título)"),
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeType]);

  // Reset search al abrir.
  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  const filtered = items.filter((i) =>
    i.title.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Etiquetar contenido</DialogTitle>
        </DialogHeader>
        <Tabs value={activeType} onValueChange={(v) => setActiveType(v as TagType)}>
          <TabsList className="grid grid-cols-3 w-full">
            {TYPES.map((t) => {
              const Icon = t.icon;
              return (
                <TabsTrigger key={t.value} value={t.value} className="text-xs gap-1.5">
                  <Icon className="h-3.5 w-3.5" />
                  {TAG_TYPE_LABEL[t.value]}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {TYPES.map((t) => (
            <TabsContent key={t.value} value={t.value} className="space-y-2 mt-3">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={`Buscar ${TAG_TYPE_LABEL[t.value].toLowerCase()}…`}
              />
              <div className="max-h-[50dvh] overflow-y-auto rounded-md border divide-y">
                {loading ? (
                  <SectionLoader text="Cargando…" />
                ) : filtered.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    {search.trim()
                      ? "Sin coincidencias."
                      : `No hay ${TAG_TYPE_LABEL[t.value].toLowerCase()}s disponibles.`}
                  </p>
                ) : (
                  filtered.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => {
                        onPick({ type: t.value, id: it.id, label: it.title });
                        onOpenChange(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                    >
                      {it.title}
                    </button>
                  ))
                )}
              </div>
            </TabsContent>
          ))}
        </Tabs>
        <div className="flex justify-end pt-1">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
