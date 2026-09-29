/**
 * Pendientes de una sesión (Asistencia, rol docente).
 *
 * Un solo diálogo por sesión con las DOS caras de «para la próxima»:
 *  - arriba, lo que quedó abierto de clases anteriores y le toca a ESTA;
 *  - abajo, lo que se anota ahora para la que viene.
 * Se abre igual desde el aviso de la columna y desde el menú de la sesión, así
 * que no importa por dónde entre el docente: ve las dos cosas.
 *
 * Este diálogo es del docente (Asistencia). El estudiante lee los mismos datos
 * desde el tablero del curso (`PendientesProximaSesionCard`), por la política
 * `session_pending_items_student_read`, solo si la institución activó la función.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ListTodo, Pencil, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RowAction } from "@/components/ui/row-action";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { formatDateShort } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import {
  MAX_CARACTERES_PENDIENTE,
  pendientesAnotadosEn,
  pendientesPorSesionDestino,
  sesionSiguiente,
  type PendienteSesion,
  type SesionOrdenable,
} from "./pendientes-sesion";
import type { PendientesDeSesiones } from "./use-pendientes-sesion";

const fechaCorta = (d: string) => formatDateShort(`${d}T12:00:00`);

export function PendientesSesionDialog({
  session,
  sesiones,
  pendientes,
  hoy,
  onClose,
}: {
  /** La sesión cuyo diálogo está abierto; null = cerrado. */
  session: SesionOrdenable | null;
  /** Todas las sesiones del curso (fuera de la papelera). */
  sesiones: readonly SesionOrdenable[];
  pendientes: PendientesDeSesiones;
  /** `yyyy-MM-dd` local. */
  hoy: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [texto, setTexto] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [textoEditado, setTextoEditado] = useState("");
  // Los que tocaban acá al ABRIR. Se congelan para que tachar uno no lo haga
  // desaparecer bajo el cursor: queda tachado hasta cerrar el diálogo.
  const [idsParaEsta, setIdsParaEsta] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const abierto = session !== null;
  const sessionId = session?.id ?? null;

  useEffect(() => {
    if (!sessionId) return;
    const mapa = pendientesPorSesionDestino(sesiones, pendientes.items, hoy);
    setIdsParaEsta(new Set((mapa.get(sessionId) ?? []).map((p) => p.id)));
    setTexto("");
    setEditandoId(null);
    // Al abrir otra sesión, o cuando termina de cargar con el diálogo ya
    // abierto. NO con cada cambio de `items`: recalcular con cada tachado es
    // justo lo que la congelación evita.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pendientes.cargando]);

  const fechaDe = useMemo(() => new Map(sesiones.map((s) => [s.id, s.session_date])), [sesiones]);
  const paraEsta = pendientes.items.filter((p) => idsParaEsta.has(p.id));
  const anotados = sessionId ? pendientesAnotadosEn(pendientes.items, sessionId) : [];
  const siguiente = sessionId ? sesionSiguiente(sesiones, sessionId) : null;

  const informar = (err: string | null) => {
    if (err) toast.error(err);
  };

  const agregar = async () => {
    if (!sessionId || !texto.trim()) return;
    setGuardando(true);
    const err = await pendientes.agregar(sessionId, texto);
    setGuardando(false);
    if (err) {
      toast.error(err);
      return;
    }
    setTexto("");
    inputRef.current?.focus();
  };

  // Enter guarda y desmonta el campo, y el desmontaje dispara el blur: sin
  // esta marca la misma edición se mandaría dos veces.
  const edicionEnCurso = useRef<string | null>(null);
  const guardarEdicion = async (item: PendienteSesion) => {
    if (edicionEnCurso.current === item.id) return;
    edicionEnCurso.current = item.id;
    const nuevo = textoEditado;
    setEditandoId(null);
    informar(await pendientes.editar(item, nuevo));
    edicionEnCurso.current = null;
  };

  const fila = (item: PendienteSesion, origen: boolean) => {
    const hecho = !!item.done_at;
    const editando = editandoId === item.id;
    return (
      <li key={item.id} className="flex items-start gap-2 rounded-md px-1 py-1.5 hover:bg-accent/50">
        <Checkbox
          checked={hecho}
          onCheckedChange={() => void pendientes.alternar(item).then(informar)}
          aria-label={hecho ? t("pendientesSesion.markOpen") : t("pendientesSesion.markDone")}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          {editando ? (
            <Input
              autoFocus
              value={textoEditado}
              maxLength={MAX_CARACTERES_PENDIENTE}
              onChange={(e) => setTextoEditado(e.target.value)}
              onBlur={() => void guardarEdicion(item)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void guardarEdicion(item);
                }
                if (e.key === "Escape") {
                  // Esc cancela la edición, no cierra el diálogo.
                  e.preventDefault();
                  e.stopPropagation();
                  setEditandoId(null);
                }
              }}
              className="h-8"
            />
          ) : (
            <p className={cn("text-sm break-words", hecho && "line-through text-muted-foreground")}>
              {item.body}
            </p>
          )}
          {!origen && fechaDe.get(item.session_id) && (
            <p className="text-2xs text-muted-foreground">
              {t("pendientesSesion.fromSession", { date: fechaCorta(fechaDe.get(item.session_id)!) })}
            </p>
          )}
        </div>
        {origen && !editando && (
          <div className="flex shrink-0 items-center">
            <RowAction
              label={t("common.edit")}
              icon={Pencil}
              onClick={() => {
                setEditandoId(item.id);
                setTextoEditado(item.body);
              }}
            />
            <RowAction
              label={t("common.delete")}
              icon={Trash2}
              tone="destructive"
              onClick={() => void pendientes.borrar(item).then(informar)}
            />
          </div>
        )}
      </li>
    );
  };

  return (
    <Dialog open={abierto} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTodo className="h-5 w-5 text-primary" />
            {session
              ? t("pendientesSesion.title", { date: fechaCorta(session.session_date) })
              : t("pendientesSesion.menuItem")}
          </DialogTitle>
          <DialogDescription>{t("pendientesSesion.description")}</DialogDescription>
        </DialogHeader>

        {pendientes.error ? (
          <ErrorState
            message={t("pendientesSesion.loadError")}
            hint={pendientes.error}
            onRetry={pendientes.recargar}
            className="py-6"
          />
        ) : (
          <div className="space-y-4">
            {paraEsta.length > 0 && (
              <section className="rounded-md border border-warning/40 bg-warning/10 p-3 space-y-1">
                <h3 className="text-sm font-medium">{t("pendientesSesion.forThisSession")}</h3>
                <p className="text-2xs text-muted-foreground">
                  {t("pendientesSesion.forThisSessionHint")}
                </p>
                <ul className="space-y-0.5 pt-1">{paraEsta.map((p) => fila(p, false))}</ul>
              </section>
            )}

            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-medium">{t("pendientesSesion.forNextSession")}</h3>
                <p className="text-2xs text-muted-foreground">
                  {siguiente
                    ? t("pendientesSesion.appearsOn", { date: fechaCorta(siguiente.session_date) })
                    : t("pendientesSesion.noNextSession")}
                </p>
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void agregar();
                }}
              >
                <Input
                  ref={inputRef}
                  value={texto}
                  maxLength={MAX_CARACTERES_PENDIENTE}
                  onChange={(e) => setTexto(e.target.value)}
                  placeholder={t("pendientesSesion.placeholder")}
                  aria-label={t("pendientesSesion.placeholder")}
                  className="flex-1 min-w-0"
                />
                <Button type="submit" disabled={guardando || !texto.trim()}>
                  {guardando ? <Spinner size="sm" /> : t("pendientesSesion.add")}
                </Button>
              </form>
              {pendientes.cargando && anotados.length === 0 ? (
                <div className="flex justify-center py-3">
                  <Spinner size="sm" />
                </div>
              ) : anotados.length === 0 ? (
                <p className="py-2 text-2xs text-muted-foreground">{t("pendientesSesion.empty")}</p>
              ) : (
                <ul className="space-y-0.5">{anotados.map((p) => fila(p, true))}</ul>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
