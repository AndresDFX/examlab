/**
 * Designar al VOCERO (representante) de un curso.
 *
 * Es una ETIQUETA INFORMATIVA: no otorga permisos. Está dicho en la migración,
 * en el comentario de la columna, en un test que lo vigila, y también acá arriba
 * — porque el lugar donde alguien va a estar tentado de colgarle un permiso es
 * justo el archivo donde ya está el dato a mano.
 *
 * ── Por qué se elige desde el CURSO y no desde el estudiante ───────────
 * Un estudiante puede estar matriculado en varios cursos, así que "marcar a esta
 * persona como vocero" desde una fila de la lista de estudiantes es ambiguo: no
 * dice de qué curso. Desde el curso, el conjunto de candidatos es exactamente su
 * matrícula y no hay nada que preguntar.
 *
 * ── Un solo vocero, y el cambio es atómico ────────────────────────────
 * Lo garantiza un índice único parcial en la base. Por eso el cambio pasa por la
 * RPC `set_course_vocero` y no por un UPDATE del cliente: marcar a B mientras A
 * sigue marcado daría un 23505.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";
import { normalizeForSearch } from "@/modules/reports/template-engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Matriculado {
  user_id: string;
  full_name: string;
  institutional_email: string | null;
  codigo: string | null;
  vocero_marcado_at: string | null;
  /** Teléfono de contacto del vocero PARA ESTE acuerdo. */
  vocero_telefono: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  courseId: string | null;
  courseName?: string;
  /** Se llama tras designar o quitar, para que el listado del caller se refresque. */
  onChanged?: () => void;
}

export function SetCourseVoceroDialog({
  open,
  onOpenChange,
  courseId,
  courseName,
  onChanged,
}: Props) {
  const { t } = useTranslation();
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState<string | null>(null);
  /** Lo tipeado en el campo del teléfono del vocero. */
  const [telefono, setTelefono] = useState("");
  const [lista, setLista] = useState<Matriculado[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!courseId) return;
    setCargando(true);
    setError(null);
    try {
      // Dos consultas a propósito: `course_enrollments.user_id` apunta a
      // `auth.users`, NO a `profiles`, así que el embed de PostgREST falla en
      // silencio (convención documentada del proyecto).
      const enr = await db
        .from("course_enrollments")
        .select("user_id, vocero_marcado_at, vocero_telefono")
        .eq("course_id", courseId);
      if (enr.error) throw enr.error;
      const filas = (enr.data ?? []) as Array<{
        user_id: string;
        vocero_marcado_at: string | null;
        vocero_telefono: string | null;
      }>;
      if (filas.length === 0) {
        setLista([]);
        return;
      }
      const perfiles = await db
        .from("profiles")
        .select("id, full_name, institutional_email, codigo")
        .in(
          "id",
          filas.map((f) => f.user_id),
        );
      if (perfiles.error) throw perfiles.error;
      const porId = new Map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (perfiles.data ?? []).map((p: any) => [p.id, p]),
      );
      setLista(
        filas
          .map((f) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const p = porId.get(f.user_id) as any;
            return {
              user_id: f.user_id,
              full_name: p?.full_name ?? "—",
              institutional_email: p?.institutional_email ?? null,
              codigo: p?.codigo ?? null,
              vocero_marcado_at: f.vocero_marcado_at,
              vocero_telefono: f.vocero_telefono,
            };
          })
          .sort((a, b) => a.full_name.localeCompare(b.full_name, "es-CO")),
      );
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setCargando(false);
    }
  }, [courseId]);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      if (!open || !courseId) return;
      if (cancelado) return;
      await cargar();
    })();
    return () => {
      cancelado = true;
    };
  }, [open, courseId, cargar]);

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const vocero = useMemo(() => lista.find((m) => m.vocero_marcado_at), [lista]);

  // Sincroniza el campo con el vocero cargado: si arrancara vacío teniendo
  // teléfono guardado, el docente lo re-escribiría creyendo que se perdió.
  useEffect(() => {
    setTelefono(vocero?.vocero_telefono ?? "");
  }, [vocero?.user_id, vocero?.vocero_telefono]);
  const filtrada = useMemo(() => {
    const n = normalizeForSearch(q);
    if (!n) return lista;
    return lista.filter(
      (m) =>
        normalizeForSearch(m.full_name).includes(n) ||
        normalizeForSearch(m.institutional_email ?? "").includes(n) ||
        normalizeForSearch(m.codigo ?? "").includes(n),
    );
  }, [lista, q]);

  /**
   * Guarda el teléfono del vocero. Va por su propio RPC en vez de reescribir
   * `set_course_vocero`: esa función ya tiene su autorización probada, y
   * reemplazarla entera para sumarle un campo es la clase de cambio que rompe lo
   * que ya andaba.
   */
  const guardarTelefono = async (userId: string) => {
    if (!courseId) return;
    setGuardando(userId);
    try {
      const { data, error } = await db.rpc("set_course_vocero_telefono", {
        _course_id: courseId,
        _user_id: userId,
        _telefono: telefono,
      });
      const r = data as { ok?: boolean } | null;
      if (error || !r?.ok) {
        toast.error(friendlyError(error, t("vocero.phoneError")));
        return;
      }
      toast.success(t("vocero.phoneOk"));
      await cargar();
      onChanged?.();
    } finally {
      setGuardando(null);
    }
  };

  const designar = async (userId: string | null) => {
    if (!courseId) return;
    setGuardando(userId ?? "__quitar__");
    try {
      const { error: e } = await db.rpc("set_course_vocero", {
        _course_id: courseId,
        _user_id: userId,
      });
      if (e) throw e;
      toast.success(userId ? t("vocero.setOk") : t("vocero.clearOk"));
      await cargar();
      onChanged?.();
    } catch (e) {
      toast.error(friendlyError(e), { duration: 10000 });
    } finally {
      setGuardando(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Mic className="h-4 w-4 text-primary" />
            {t("vocero.dialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {courseName
              ? t("vocero.dialogDescWithCourse", { course: courseName })
              : t("vocero.dialogDesc")}
          </DialogDescription>
        </DialogHeader>

        {/* La aclaración va DONDE se designa, no en la documentación: es el
            momento en que alguien podría suponer que esto da permisos. */}
        <p className="text-2xs text-muted-foreground rounded-md border border-dashed p-2">
          {t("vocero.disclaimer")}
        </p>

        {cargando ? (
          <div className="py-8 flex justify-center">
            <Spinner size="lg" />
          </div>
        ) : error ? (
          <EmptyState title={t("vocero.loadError")} hint={error} />
        ) : lista.length === 0 ? (
          <EmptyState title={t("vocero.noStudents")} hint={t("vocero.noStudentsHint")} />
        ) : (
          <div className="space-y-2">
            {vocero && (
              <div className="rounded-md border bg-muted/40 p-2 flex items-center justify-between gap-2">
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs font-medium truncate">{vocero.full_name}</p>
                  <p className="text-2xs text-muted-foreground">
                    {t("vocero.markedOn", {
                      date: formatDateTime(vocero.vocero_marcado_at as string),
                    })}
                  </p>
                  {/* El teléfono se pide ACÁ y no antes: recién con el vocero
                      designado se sabe de quién es. Lo usa la casilla "Teléfono"
                      del Acuerdo Pedagógico, que hasta ahora salía en blanco
                      porque el dato no existía en ninguna tabla. */}
                  <div className="flex items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="vocero-tel" className="text-2xs">
                        {t("vocero.phoneLabel")}
                      </Label>
                      <Input
                        id="vocero-tel"
                        className="h-7 text-xs"
                        inputMode="tel"
                        value={telefono}
                        onChange={(e) => setTelefono(e.target.value)}
                        placeholder={t("vocero.phonePlaceholder")}
                        disabled={guardando !== null}
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs shrink-0"
                      onClick={() => void guardarTelefono(vocero.user_id)}
                      disabled={
                        guardando !== null || telefono === (vocero.vocero_telefono ?? "")
                      }
                    >
                      {t("common.save")}
                    </Button>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs shrink-0"
                  onClick={() => void designar(null)}
                  disabled={guardando !== null}
                >
                  {t("vocero.clear")}
                </Button>
              </div>
            )}

            {lista.length > 8 && (
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("vocero.searchPlaceholder")}
                  className="h-8 pl-7 text-xs"
                />
              </div>
            )}

            <div className="max-h-[45dvh] overflow-y-auto -mx-1 px-1 space-y-1">
              {filtrada.length === 0 ? (
                <p className="text-2xs text-muted-foreground py-3 text-center">
                  {t("vocero.searchEmpty")}
                </p>
              ) : (
                filtrada.map((m) => {
                  const esVocero = !!m.vocero_marcado_at;
                  return (
                    <div
                      key={m.user_id}
                      className="flex items-center justify-between gap-2 rounded-md border p-2"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate flex items-center gap-1.5">
                          {m.full_name}
                          {esVocero && (
                            <Badge variant="secondary" className="text-3xs shrink-0 gap-1">
                              <Mic className="h-2.5 w-2.5" />
                              {t("vocero.badge")}
                            </Badge>
                          )}
                        </p>
                        <p className="text-2xs text-muted-foreground truncate">
                          {m.institutional_email ?? "—"}
                          {m.codigo ? ` · ${m.codigo}` : ""}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={esVocero ? "outline" : "default"}
                        className="h-7 text-xs shrink-0"
                        onClick={() => void designar(esVocero ? null : m.user_id)}
                        disabled={guardando !== null}
                      >
                        {guardando === m.user_id ? (
                          <Spinner size="xs" />
                        ) : esVocero ? (
                          t("vocero.clear")
                        ) : (
                          t("vocero.set")
                        )}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close", { defaultValue: "Cerrar" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
