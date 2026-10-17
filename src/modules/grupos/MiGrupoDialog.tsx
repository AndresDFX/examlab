/**
 * «Mi grupo» del estudiante en un taller o proyecto: ver con quién está y, si
 * los grupos los arman los estudiantes, armar el suyo eligiendo compañeros de
 * su curso, sumar más o salirse. Las reglas las hace cumplir la base (ver
 * `grupos-estudiante.ts`); esta ventana solo evita ofrecer lo que va a fallar.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { UserMinus, UserPlus, UsersRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { SectionLoader } from "@/components/ui/loaders";
import { ErrorState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/hooks/use-auth";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { normalizeForSearch } from "@/modules/search/search-text";
import {
  avisarBajoElMinimo,
  cuposLibres,
  problemaDeSeleccion,
  type Companero,
  type EstadoDeGrupo,
  type TipoActividadGrupal,
} from "@/modules/grupos/grupos-estudiante";
import {
  agregarAGrupo,
  cargarEstadoDeGrupo,
  crearGrupo,
  salirDelGrupo,
} from "@/modules/grupos/grupos-estudiante-api";

interface MiGrupoDialogProps {
  tipo: TipoActividadGrupal;
  actividadId: string;
  actividadTitulo: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Algo cambió (creó, agregó, salió): quien abre la ventana recarga su grupo y su entrega. */
  onCambio: () => void;
}

export function MiGrupoDialog({
  tipo,
  actividadId,
  actividadTitulo,
  open,
  onOpenChange,
  onCambio,
}: Readonly<MiGrupoDialogProps>) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [estado, setEstado] = useState<EstadoDeGrupo | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [busqueda, setBusqueda] = useState("");
  const [nombre, setNombre] = useState("");
  const [agregando, setAgregando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  // Cada vez que se abre, la ventana arranca limpia y sin el estado viejo: el
  // grupo pudo cambiar mientras estaba cerrada. Se limpia al ABRIR y no al
  // cerrar, para que el contenido no salte mientras la ventana se desvanece.
  useEffect(() => {
    if (!open) return;
    setEstado(null);
    setError(null);
    setElegidos(new Set());
    setBusqueda("");
    setNombre("");
    setAgregando(false);
  }, [open, actividadId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCargando(true);
    setError(null);
    void (async () => {
      try {
        const e = await cargarEstadoDeGrupo(tipo, actividadId);
        if (cancelled) return;
        setEstado(e);
        // Lo elegido que dejó de estar disponible (otro lo sumó a su grupo
        // mientras tanto) se suelta: quedaría marcado, sin poder desmarcarse,
        // y «Crear» fallaría hasta cerrar la ventana.
        setElegidos((prev) => {
          const libres = new Set(
            e.companeros.filter((c) => c.estado === "disponible").map((c) => c.id),
          );
          const next = new Set([...prev].filter((id) => libres.has(id)));
          return next.size === prev.size ? prev : next;
        });
      } catch (e) {
        if (cancelled) return;
        setError(friendlyError(e));
      } finally {
        if (!cancelled) setCargando(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tipo, actividadId, nonce]);

  const recargar = () => setNonce((n) => n + 1);

  const abierto = estado?.motivo === null;
  const grupo = estado?.grupo ?? null;
  // Al agregar, los que ya son del grupo no se listan: saldrían como «En «este grupo»».
  const candidatos = (estado?.companeros ?? []).filter(
    (c) => !grupo?.integrantes.some((i) => i.id === c.id),
  );
  const actuales = grupo ? grupo.integrantes.length : 1;
  const limite = estado ? cuposLibres(estado.maximo, actuales) : 0;
  const problema = estado
    ? problemaDeSeleccion({
        modo: grupo ? "agregar" : "crear",
        minimo: estado.minimo,
        maximo: estado.maximo,
        actuales,
        elegidos: elegidos.size,
      })
    : null;

  const alternar = (id: string) =>
    setElegidos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const crear = async () => {
    if (!estado || guardando || problema) return;
    setGuardando(true);
    try {
      await crearGrupo(tipo, actividadId, nombre, [...elegidos]);
      toast.success(t("gruposEstudiante.creado"));
      setElegidos(new Set());
      setNombre("");
      onCambio();
      recargar();
    } catch (e) {
      toast.error(friendlyError(e));
      recargar();
    } finally {
      setGuardando(false);
    }
  };

  const agregar = async () => {
    if (!grupo || guardando || problema) return;
    setGuardando(true);
    try {
      const n = await agregarAGrupo(tipo, grupo.id, [...elegidos]);
      toast.success(t("gruposEstudiante.agregados", { count: n }));
      setElegidos(new Set());
      setAgregando(false);
      onCambio();
      recargar();
    } catch (e) {
      toast.error(friendlyError(e));
      recargar();
    } finally {
      setGuardando(false);
    }
  };

  const salir = async () => {
    if (!grupo || guardando) return;
    const ultimo = grupo.integrantes.length <= 1;
    const ok = await confirm({
      title: t("gruposEstudiante.salirTitulo", { nombre: grupo.nombre }),
      description: ultimo
        ? t("gruposEstudiante.salirUltimo")
        : t("gruposEstudiante.salirDescripcion"),
      confirmLabel: t("gruposEstudiante.salir"),
      tone: "warning",
    });
    if (!ok) return;
    setGuardando(true);
    try {
      await salirDelGrupo(tipo, grupo.id);
      toast.success(t("gruposEstudiante.saliste", { nombre: grupo.nombre }));
      onCambio();
      recargar();
    } catch (e) {
      toast.error(friendlyError(e));
      recargar();
    } finally {
      setGuardando(false);
    }
  };

  const textoDelProblema = (() => {
    if (!problema) return null;
    if (problema.tipo === "faltan")
      return t("gruposEstudiante.faltan", { count: problema.cuantos });
    if (problema.tipo === "sobran")
      return t("gruposEstudiante.sobran", { count: problema.cuantos });
    return null;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersRound className="h-5 w-5" />
            {t("gruposEstudiante.titulo")}
          </DialogTitle>
          <DialogDescription>{actividadTitulo}</DialogDescription>
        </DialogHeader>

        {cargando && !estado ? (
          <SectionLoader />
        ) : error ? (
          <ErrorState message={t("gruposEstudiante.errorCargar")} hint={error} onRetry={recargar} />
        ) : estado ? (
          <div className="space-y-4">
            {grupo ? (
              <section className="space-y-3">
                <div className="space-y-1">
                  <p className="font-medium">{grupo.nombre}</p>
                  <p className="text-xs text-muted-foreground">
                    {estado.arman_estudiantes
                      ? t("gruposEstudiante.integrantesDeMax", {
                          count: grupo.integrantes.length,
                          maximo: estado.maximo,
                        })
                      : t("gruposEstudiante.integrantes", { count: grupo.integrantes.length })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {grupo.integrantes.map((m) => (
                    <span
                      key={m.id}
                      className="text-xs rounded-full bg-background border px-2 py-0.5"
                    >
                      {m.nombre}
                      {m.id === user?.id && (
                        <span className="ml-1 text-muted-foreground">
                          {t("gruposEstudiante.tu")}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
                {/* En una externa no hay entrega: la nota es una fila por integrante. */}
                {!estado.externa && (
                  <p className="text-xs text-muted-foreground">
                    {t("gruposEstudiante.entregaDelGrupo")}
                  </p>
                )}
                {avisarBajoElMinimo({
                  abierto,
                  integrantes: grupo.integrantes.length,
                  minimo: estado.minimo,
                  armadoPorElDocente: grupo.armado_por_docente === true,
                }) && (
                  <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning-on-subtle">
                    {t("gruposEstudiante.bajoElMinimo", { minimo: estado.minimo })}
                  </p>
                )}
                {estado.motivo && (
                  <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                    {t(`gruposEstudiante.motivoConGrupo.${estado.motivo}`, {
                      defaultValue: t("gruposEstudiante.motivoConGrupo.otro"),
                    })}
                  </p>
                )}
                {abierto && !agregando && (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {limite > 0 && (
                      <Button variant="outline" size="sm" onClick={() => setAgregando(true)}>
                        <UserPlus className="h-4 w-4 mr-1" />
                        {t("gruposEstudiante.agregarCompaneros")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void salir()}
                      disabled={guardando}
                    >
                      <UserMinus className="h-4 w-4 mr-1" />
                      {t("gruposEstudiante.salir")}
                    </Button>
                  </div>
                )}
                {abierto && agregando && (
                  <div className="space-y-3 rounded-md border p-3">
                    <SelectorDeCompaneros
                      companeros={candidatos}
                      elegidos={elegidos}
                      limite={limite}
                      busqueda={busqueda}
                      onBusqueda={setBusqueda}
                      onAlternar={alternar}
                    />
                    {textoDelProblema && (
                      <p className="text-xs text-warning-on-subtle">{textoDelProblema}</p>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAgregando(false);
                          setElegidos(new Set());
                        }}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void agregar()}
                        disabled={!!problema || guardando}
                      >
                        {guardando && <Spinner size="xs" className="mr-1" />}
                        {t("gruposEstudiante.agregar", { count: elegidos.size })}
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            ) : abierto && !estado.individual?.entregada ? (
              <section className="space-y-3">
                <p className="text-sm">
                  {estado.modo === "group_required"
                    ? t("gruposEstudiante.introEstricto")
                    : t("gruposEstudiante.introMixto")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("gruposEstudiante.reglas", { minimo: estado.minimo, maximo: estado.maximo })}
                </p>
                {estado.individual && (
                  <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                    {t("gruposEstudiante.borradorPasaAlGrupo")}
                  </p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="grupo-nombre">{t("gruposEstudiante.nombre")}</Label>
                  <Input
                    id="grupo-nombre"
                    value={nombre}
                    maxLength={60}
                    onChange={(e) => setNombre(e.target.value)}
                    placeholder={t("gruposEstudiante.nombrePlaceholder")}
                  />
                </div>
                <SelectorDeCompaneros
                  companeros={candidatos}
                  elegidos={elegidos}
                  limite={limite}
                  busqueda={busqueda}
                  onBusqueda={setBusqueda}
                  onAlternar={alternar}
                />
                <p className="text-xs text-muted-foreground">
                  {t("gruposEstudiante.quedaDe", { count: 1 + elegidos.size })}
                </p>
                {textoDelProblema && (
                  <p className="text-xs text-warning-on-subtle">{textoDelProblema}</p>
                )}
                <div className="flex justify-end">
                  <Button onClick={() => void crear()} disabled={!!problema || guardando}>
                    {guardando ? (
                      <Spinner size="xs" className="mr-1" />
                    ) : (
                      <UsersRound className="h-4 w-4 mr-1" />
                    )}
                    {t("gruposEstudiante.crear")}
                  </Button>
                </div>
              </section>
            ) : (
              <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                {estado.individual?.entregada
                  ? t("gruposEstudiante.entregasteSolo")
                  : t(`gruposEstudiante.motivoSinGrupo.${estado.motivo ?? "otro"}`, {
                      defaultValue: t("gruposEstudiante.motivoSinGrupo.otro"),
                    })}
              </p>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Lista de compañeros con casilla. Los que no se pueden sumar se ven igual, con
 * el motivo: un compañero que «no aparece» se lee como un error de la lista.
 * Cada fila entera es la etiqueta de su casilla (se toca la fila, no el cuadrito).
 */
function SelectorDeCompaneros({
  companeros,
  elegidos,
  limite,
  busqueda,
  onBusqueda,
  onAlternar,
}: Readonly<{
  companeros: Companero[];
  elegidos: Set<string>;
  limite: number;
  busqueda: string;
  onBusqueda: (v: string) => void;
  onAlternar: (id: string) => void;
}>) {
  const { t } = useTranslation();
  const visibles = useMemo(() => {
    const q = normalizeForSearch(busqueda);
    const filtrados = q
      ? companeros.filter((c) => normalizeForSearch(c.nombre).includes(q))
      : companeros;
    // Los que se pueden elegir, primero; el orden por nombre lo trae la base.
    return [
      ...filtrados.filter((c) => c.estado === "disponible"),
      ...filtrados.filter((c) => c.estado !== "disponible"),
    ];
  }, [companeros, busqueda]);

  const motivo = (c: Companero) => {
    if (c.estado === "en_grupo")
      return t("gruposEstudiante.companeroEnGrupo", { grupo: c.grupo ?? "" });
    if (c.estado === "por_su_cuenta") return t("gruposEstudiante.companeroPorSuCuenta");
    return null;
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{t("gruposEstudiante.companeros")}</Label>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {t("gruposEstudiante.elegidos", { count: elegidos.size, limite })}
        </span>
      </div>
      <SearchInput
        value={busqueda}
        onChange={onBusqueda}
        placeholder={t("gruposEstudiante.buscar")}
      />
      <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
        {visibles.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {companeros.length === 0
              ? t("gruposEstudiante.sinCompaneros")
              : t("gruposEstudiante.sinCoincidencias")}
          </p>
        ) : (
          visibles.map((c) => {
            const marcado = elegidos.has(c.id);
            // Lo marcado siempre se puede desmarcar, aunque haya dejado de estar
            // disponible: si no, la casilla queda pegada.
            const deshabilitado =
              !marcado && (c.estado !== "disponible" || elegidos.size >= limite);
            const porque = motivo(c);
            return (
              <label
                key={c.id}
                className={`flex min-h-10 items-center gap-2 px-3 py-2 text-sm ${
                  deshabilitado ? "opacity-60" : "cursor-pointer hover:bg-accent"
                }`}
              >
                <Checkbox
                  checked={marcado}
                  disabled={deshabilitado}
                  onCheckedChange={() => onAlternar(c.id)}
                />
                <span className="min-w-0 flex-1 truncate" title={c.nombre}>
                  {c.nombre}
                </span>
                {porque && (
                  <Badge
                    variant="outline"
                    title={porque}
                    className="min-w-0 max-w-[50%] text-3xs font-normal"
                  >
                    {/* El nombre del grupo lo escribe un estudiante: se recorta acá
                        para que no se coma el nombre del compañero. */}
                    <span className="truncate">{porque}</span>
                  </Badge>
                )}
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
