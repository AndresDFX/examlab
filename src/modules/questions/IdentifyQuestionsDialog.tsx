/**
 * «Identificar preguntas desde un texto» — el docente PEGA un parcial ya
 * escrito y la IA identifica, para cada pregunta, cuál de los tipos de la
 * plataforma le corresponde y qué necesita ese tipo (las opciones y la
 * correcta si es de selección, la rúbrica si es abierta, el lenguaje si es de
 * código, el esquema de partida si es de SQL).
 *
 * ── Por qué la revisión es obligatoria ────────────────────────────────
 * La clasificación automática se equivoca. Insertar directo sería el peor
 * resultado posible: preguntas con el tipo mal puesto que el alumno recibe en
 * el examen. Así que el borrador vive ACÁ, en memoria, hasta que el docente
 * confirma; puede cambiar el tipo, editar el enunciado y las opciones, y
 * descartar filas sueltas. Nada toca la base hasta «Agregar N preguntas».
 *
 * ── Por qué se escribe una vez y se monta cuatro ──────────────────────
 * El flujo de «Generar con IA» está copiado casi verbatim en examen, taller y
 * proyecto, y ya divergió entre las tres (filtrado de opciones vacías,
 * cálculo de `position`, `targetTable` omitido en una). Replicar este diálogo
 * por superficie fabricaría la cuarta y la quinta copia; en cambio recibe
 * `destino` y el armado de la fila vive en `identify-types.ts`.
 *
 * ── Por qué los lotes son secuenciales ────────────────────────────────
 * El cupo de IA (30 llamadas/hora por usuario) es COMPARTIDO con toda la
 * generación existente. En paralelo, un `429` en el segundo lote llegaría
 * cuando el tercero y el cuarto ya se quemaron. Secuencial, el primer error
 * corta la secuencia y conserva lo ya clasificado.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, FileUp, Plus, RefreshCw, ScanText, Trash2, Wand2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HelpHint } from "@/components/ui/help-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RowAction } from "@/components/ui/row-action";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { logEvent } from "@/shared/lib/audit";
import { questionTypeLabel, questionTypeLabelKey } from "@/shared/lib/question-type-label";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import { MAX_DOCX_BYTES, parseDocxToText } from "@/modules/reports/docx-import";
import {
  MAX_FILAS_BORRADOR,
  MAX_PREGUNTAS_POR_LOTE,
  MAX_TEXTO_CHARS,
  MAX_TEXTO_TOTAL_CHARS,
  agruparEnLotes,
  emparejarConSegmentos,
  segmentarPreguntas,
} from "./identify-text";
import {
  TABLA_POR_DESTINO,
  TIPOS_ACEPTADOS_POR_DESTINO,
  construirFilaPregunta,
  validarBorrador,
  type BorradorPregunta,
  type Confianza,
  type DestinoIdentificacion,
  type JavaFramework,
  type LenguajeCodigo,
  type TipoAceptado,
} from "./identify-types";

// `question_bank` no está en `src/integrations/supabase/types.ts`; la pantalla
// del banco convive con eso vía el mismo cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const LENGUAJES: LenguajeCodigo[] = ["java", "python", "javascript"];

/** Extensiones que el navegador puede leer sin dependencias nuevas. */
const EXTENSIONES = ".docx,.txt,.md";

/** Ids locales del borrador. No son ids de base: solo `key` de React. */
let secuencia = 0;
const nuevoId = () => `bq-${++secuencia}`;

interface RespuestaEdge {
  ok?: boolean;
  error?: string;
  truncated?: boolean;
  questions?: unknown[];
  discarded?: { reason?: string }[];
}

export interface IdentifyQuestionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destino: DestinoIdentificacion;
  /** examId | workshopId | projectId | courseId, según el destino. */
  targetId: string;
  courseId: string | null;
  courseLanguage?: "es" | "en";
  /** `Math.max(-1, ...positions) + 1` de la superficie que monta el diálogo. */
  nextPosition: number;
  onInserted?: (n: number) => void;
}

/** Clave del espejo en localStorage, para no perder la revisión al recargar. */
const claveBorrador = (destino: string, targetId: string) => `examlab_ident:${destino}:${targetId}`;

function comoTexto(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function comoLenguaje(v: unknown, fallback: LenguajeCodigo): LenguajeCodigo {
  return LENGUAJES.includes(v as LenguajeCodigo) ? (v as LenguajeCodigo) : fallback;
}

function comoConfianza(v: unknown): Confianza {
  return v === "alta" || v === "media" || v === "baja" ? v : "baja";
}

/** Traduce un item del edge a una fila del borrador. */
function aBorrador(
  crudo: unknown,
  destino: DestinoIdentificacion,
  lenguajeFallback: LenguajeCodigo,
): BorradorPregunta {
  const q = (crudo ?? {}) as Record<string, unknown>;
  const aceptados = TIPOS_ACEPTADOS_POR_DESTINO[destino] as readonly string[];
  const propuesto = comoTexto(q.type);
  const tipo = (aceptados.includes(propuesto) ? propuesto : "abierta") as TipoAceptado;
  const options = (q.options ?? null) as Record<string, unknown> | null;
  const choices = Array.isArray(options?.choices)
    ? (options?.choices as unknown[]).map((c) => comoTexto(c)).filter((c) => c.trim())
    : [];
  const correctIndices = Array.isArray(options?.correct_indices)
    ? (options?.correct_indices as unknown[]).filter(
        (i): i is number => typeof i === "number" && Number.isInteger(i),
      )
    : [];
  const db_ = (options?.db ?? null) as Record<string, unknown> | null;
  const puntosCrudos = Number(q.points);
  return {
    id: nuevoId(),
    tipo,
    tipoPropuesto: propuesto || tipo,
    enunciado: comoTexto(q.statement).trim(),
    rubrica: comoTexto(q.rubric),
    puntos:
      Number.isFinite(puntosCrudos) && puntosCrudos >= 1
        ? Math.min(100, Math.round(puntosCrudos))
        : 1,
    incluida: true,
    confianza: comoConfianza(q.confidence),
    motivo: comoTexto(q.reason),
    fragmento: comoTexto(q.source_excerpt),
    degradadoDe: comoTexto(q.degraded_from) || null,
    opciones: choices,
    correcta:
      typeof options?.correct_index === "number" && Number.isInteger(options.correct_index)
        ? (options.correct_index as number)
        : null,
    correctas: correctIndices,
    minSelecciones:
      typeof options?.min_selections === "number" ? (options.min_selections as number) : null,
    maxSelecciones:
      typeof options?.max_selections === "number" ? (options.max_selections as number) : null,
    setupSql: comoTexto(db_?.setupSql),
    lenguaje: comoLenguaje(q.language, lenguajeFallback),
    javaFramework: "swing",
  };
}

/** Fila nueva a partir de un bloque de texto que la IA no clasificó. */
function abiertaDesdeTexto(texto: string): BorradorPregunta {
  return {
    id: nuevoId(),
    tipo: "abierta",
    tipoPropuesto: "",
    enunciado: texto.trim(),
    rubrica: "",
    puntos: 1,
    incluida: true,
    confianza: "baja",
    motivo: "",
    fragmento: texto.trim(),
    degradadoDe: null,
    opciones: [],
    correcta: null,
    correctas: [],
    minSelecciones: null,
    maxSelecciones: null,
    setupSql: "",
    lenguaje: "java",
    javaFramework: "swing",
  };
}

export function IdentifyQuestionsDialog({
  open,
  onOpenChange,
  destino,
  targetId,
  courseId,
  courseLanguage,
  nextPosition,
  onInserted,
}: IdentifyQuestionsDialogProps) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const aiGate = useAiAuthorizationGate();

  const [fase, setFase] = useState<"pegar" | "clasificando" | "revisar">("pegar");
  const [texto, setTexto] = useState("");
  const [pegadoTotal, setPegadoTotal] = useState(0);
  const [lenguajeCodigo, setLenguajeCodigo] = useState<LenguajeCodigo>("java");
  const [leyendoArchivo, setLeyendoArchivo] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);

  const [borradores, setBorradores] = useState<BorradorPregunta[]>([]);
  const [detectadas, setDetectadas] = useState(0);
  const [clasificadas, setClasificadas] = useState(0);
  const [huerfanos, setHuerfanos] = useState<string[]>([]);
  const [truncado, setTruncado] = useState(false);
  const [descartadas, setDescartadas] = useState<string[]>([]);
  const [errorLote, setErrorLote] = useState<{ texto: string; mensaje: string } | null>(null);
  const [progreso, setProgreso] = useState({ hechos: 0, total: 0, preguntas: 0 });
  const [soloRevision, setSoloRevision] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  // `true` cuando ya escribimos el espejo en esta sesión. Sin esta marca, el
  // effect de guardado corría con `borradores` vacío en el MISMO commit en que
  // el de restauración acaba de leer, y borraba lo que se estaba restaurando.
  const espejoEscritoRef = useRef(false);
  const clave = claveBorrador(destino, targetId);

  // Espejo del borrador. Se lee en un effect (NUNCA en el initializer de
  // useState: leer localStorage ahí produce hidratación #418).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    try {
      const crudo = window.localStorage.getItem(clave);
      if (!crudo) return;
      const guardado = JSON.parse(crudo) as { borradores?: BorradorPregunta[] };
      if (cancelled || !Array.isArray(guardado.borradores) || !guardado.borradores.length) return;
      // Los ids se RE-GENERAN al restaurar. `secuencia` es de módulo y arranca en
      // 0 en cada carga de página, pero los ids viajan dentro del espejo: la
      // primera fila nueva de la sesión recibía `bq-1`, que ya existía, y a
      // partir de ahí editar o descartar una fila tocaba la otra. Son solo
      // `key` de React, no identifican nada persistido.
      setBorradores(guardado.borradores.map((b) => ({ ...b, id: nuevoId() })));
      setDetectadas(guardado.borradores.length);
      setClasificadas(guardado.borradores.length);
      setFase("revisar");
    } catch {
      // Un espejo corrupto no debe impedir usar el diálogo.
    }
    return () => {
      cancelled = true;
    };
  }, [open, clave]);

  useEffect(() => {
    if (!open) return;
    try {
      if (borradores.length) {
        window.localStorage.setItem(clave, JSON.stringify({ borradores }));
        espejoEscritoRef.current = true;
      } else if (espejoEscritoRef.current) {
        window.localStorage.removeItem(clave);
        espejoEscritoRef.current = false;
      }
    } catch {
      // Modo privado / almacenamiento bloqueado: el borrador sigue en memoria.
    }
  }, [open, clave, borradores]);

  const limpiarTodo = useCallback(() => {
    setFase("pegar");
    setTexto("");
    setPegadoTotal(0);
    setBorradores([]);
    setDetectadas(0);
    setClasificadas(0);
    setHuerfanos([]);
    setTruncado(false);
    setDescartadas([]);
    setErrorLote(null);
    setProgreso({ hechos: 0, total: 0, preguntas: 0 });
    setSoloRevision(false);
    espejoEscritoRef.current = false;
    try {
      window.localStorage.removeItem(clave);
    } catch {
      /* sin espejo */
    }
  }, [clave]);

  const cerrar = async (siguiente: boolean) => {
    if (siguiente) {
      onOpenChange(true);
      return;
    }
    if (fase === "clasificando") {
      abortRef.current?.abort();
    }
    if (borradores.length) {
      const ok = await confirm({
        title: t("identifyQuestions.discardTitle"),
        description: t("identifyQuestions.discardBody", { count: borradores.length }),
        tone: "warning",
        confirmLabel: t("identifyQuestions.discardConfirm"),
      });
      if (!ok) return;
    }
    limpiarTodo();
    onOpenChange(false);
  };

  // ── Segmentación en vivo, sin gastar cuota ──────────────────────────
  const segmentosDelTexto = useMemo(() => segmentarPreguntas(texto), [texto]);

  const validaciones = useMemo(() => {
    const mapa = new Map<string, string | null>();
    for (const fila of borradores) {
      const r = validarBorrador(destino, fila);
      mapa.set(fila.id, r.ok ? null : r.motivo);
    }
    return mapa;
  }, [borradores, destino]);

  const requierenRevision = useMemo(
    () => borradores.filter((b) => validaciones.get(b.id) != null || b.confianza !== "alta").length,
    [borradores, validaciones],
  );

  const visibles = useMemo(
    () =>
      soloRevision
        ? borradores.filter((b) => validaciones.get(b.id) != null || b.confianza !== "alta")
        : borradores,
    [borradores, soloRevision, validaciones],
  );

  const seleccionadas = useMemo(
    () => borradores.filter((b) => b.incluida && validaciones.get(b.id) == null),
    [borradores, validaciones],
  );

  const actualizar = (id: string, cambios: Partial<BorradorPregunta>) => {
    setBorradores((prev) => prev.map((b) => (b.id === id ? { ...b, ...cambios } : b)));
  };

  // ── Lectura de archivo ──────────────────────────────────────────────
  const cargarArchivo = async (archivo: File) => {
    setLeyendoArchivo(true);
    try {
      const nombre = archivo.name.toLowerCase();
      if (nombre.endsWith(".pdf")) {
        toast.error(t("identifyQuestions.pdfNotSupported"));
        return;
      }
      let contenido = "";
      if (nombre.endsWith(".docx")) {
        if (archivo.size > MAX_DOCX_BYTES) {
          toast.error(t("identifyQuestions.fileTooBig"));
          return;
        }
        const bytes = new Uint8Array(await archivo.arrayBuffer());
        contenido = parseDocxToText(bytes);
      } else if (nombre.endsWith(".txt") || nombre.endsWith(".md")) {
        contenido = await archivo.text();
      } else {
        toast.error(t("identifyQuestions.fileTypeNotSupported"));
        return;
      }
      if (!contenido.trim()) {
        toast.error(t("identifyQuestions.fileEmpty"));
        return;
      }
      setTexto((prev) => (prev.trim() ? `${prev}\n\n${contenido}` : contenido));
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setLeyendoArchivo(false);
    }
  };

  // ── Clasificación por lotes ─────────────────────────────────────────
  const pedirLote = async (
    textoLote: string,
    signal: AbortSignal,
  ): Promise<{ items: unknown[]; truncated: boolean; discarded: string[] } | { error: string }> => {
    const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
      body: {
        questionIdentification: true,
        text: textoLote,
        target: destino,
        courseId,
        // Este valor decide el idioma de TODO el texto que el edge redacta y el
        // diálogo pinta sin traducir (motivos de degradación, descartes, el
        // `reason` por pregunta). Con un default fijo en "es", un curso en inglés
        // mostraba la interfaz traducida y los motivos en español. Si el caller
        // no lo pasa, se deriva del idioma activo de la app.
        courseLanguage: courseLanguage ?? (i18n.language?.startsWith("en") ? "en" : "es"),
        codeLanguage: lenguajeCodigo,
        maxItems: 12,
      },
      signal,
    });
    // 429 y 402 llegan con status 200 y `{ ok:false, error }` (el frontend
    // desplegado no lee el body de un no-2xx), así que el error del BODY se
    // mira ANTES del error del transporte.
    const resp = (data ?? null) as RespuestaEdge | null;
    if (resp?.error) return { error: resp.error };
    // La version ASINCRONA: la sincrona no puede leer el body de un Response,
    // y en todo no-2xx `functions.invoke` devuelve `data: null`, asi que
    // devolvia el generico EN INGLES "Edge Function returned a non-2xx status
    // code" — que se pintaba tal cual en el banner de error del dialogo. El
    // caso mas probable de esta funcionalidad es justo uno de esos: el limite
    // de uso de IA responde 429.
    if (error) return { error: await extractEdgeError(error, data) };
    if (!resp?.ok || !Array.isArray(resp.questions) || resp.questions.length === 0) {
      return { error: t("identifyQuestions.noResult") };
    }
    return {
      items: resp.questions,
      truncated: Boolean(resp.truncated),
      discarded: (resp.discarded ?? [])
        .map((d) => comoTexto(d?.reason))
        .filter((r) => r.trim().length > 0),
    };
  };

  const clasificar = async (textoAClasificar: string, acumular: boolean) => {
    const limpio = textoAClasificar.trim();
    if (!limpio) {
      toast.error(t("identifyQuestions.emptyText"));
      return;
    }
    if (limpio.length > MAX_TEXTO_CHARS) {
      toast.error(t("identifyQuestions.textTooLong", { max: MAX_TEXTO_CHARS }));
      return;
    }
    const segmentos = segmentarPreguntas(limpio);
    if (!segmentos.length) {
      toast.error(t("identifyQuestions.noQuestionsDetected"));
      return;
    }

    const decision = await aiGate.ensureAuthorized({ allowQueue: false });
    if (decision === "cancel") return;
    if (decision === "proceed-async") {
      // La cola devuelve «insertado», no un borrador: no hay dónde revisar.
      toast.info(t("identifyQuestions.queueNotSupported"));
      return;
    }

    const lotes = agruparEnLotes(segmentos, MAX_PREGUNTAS_POR_LOTE);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setFase("clasificando");
    setErrorLote(null);
    if (!acumular) {
      setBorradores([]);
      setDescartadas([]);
      setHuerfanos([]);
      setClasificadas(0);
      setDetectadas(0);
      setTruncado(false);
    }
    setProgreso({ hechos: 0, total: lotes.length, preguntas: 0 });
    setPegadoTotal((prev) => prev + limpio.length);
    setDetectadas((prev) => (acumular ? prev : 0) + segmentos.length);

    const nuevos: BorradorPregunta[] = [];
    const yaEnLista = acumular ? borradores.length : 0;

    for (let i = 0; i < lotes.length; i++) {
      if (ctrl.signal.aborted) break;
      if (yaEnLista + nuevos.length >= MAX_FILAS_BORRADOR) {
        // El tope existe porque más de esto no se revisa, se hojea. Se avisa:
        // descartar filas en silencio sería perder el texto del docente.
        toast.info(t("identifyQuestions.rowCapReached", { max: MAX_FILAS_BORRADOR }));
        break;
      }
      let r: Awaited<ReturnType<typeof pedirLote>>;
      try {
        r = await pedirLote(lotes[i].texto, ctrl.signal);
      } catch (e) {
        if (ctrl.signal.aborted) break;
        r = { error: friendlyError(e) };
      }
      if ("error" in r) {
        // Se corta la secuencia y se conserva lo ya clasificado: el cupo de IA
        // es compartido y seguir quemaría las tandas siguientes con el mismo
        // error. El PRIMER error real queda a la vista, con «Reintentar».
        setErrorLote({ texto: lotes[i].texto, mensaje: r.error });
        break;
      }
      const filas = r.items
        .map((q) => aBorrador(q, destino, lenguajeCodigo))
        .filter((f) => f.enunciado.length > 0);
      const caben = filas.slice(0, Math.max(0, MAX_FILAS_BORRADOR - yaEnLista - nuevos.length));
      nuevos.push(...caben);
      if (r.truncated) setTruncado(true);
      if (r.discarded.length) setDescartadas((prev) => [...prev, ...r.discarded]);
      setBorradores((prev) => [...prev, ...caben]);
      setClasificadas((prev) => prev + caben.length);
      setProgreso({ hechos: i + 1, total: lotes.length, preguntas: nuevos.length });
    }

    abortRef.current = null;
    const { huerfanos: sinClasificar } = emparejarConSegmentos(
      segmentos,
      nuevos.map((n) => n.enunciado),
    );
    setHuerfanos((prev) => [
      ...(acumular ? prev : []),
      ...sinClasificar.map((i) => segmentos[i].texto),
    ]);
    setTexto("");
    // Sin NADA clasificado (ni de antes ni de ahora) no hay qué revisar: se
    // queda en «pegar», donde el mensaje de la tanda fallida está a la vista.
    setFase(yaEnLista + nuevos.length > 0 ? "revisar" : "pegar");
  };

  const reintentarLote = async () => {
    if (!errorLote) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setFase("clasificando");
    setProgreso({ hechos: 0, total: 1, preguntas: 0 });
    let r: Awaited<ReturnType<typeof pedirLote>>;
    try {
      r = await pedirLote(errorLote.texto, ctrl.signal);
    } catch (e) {
      r = { error: friendlyError(e) };
    }
    abortRef.current = null;
    if ("error" in r) {
      setErrorLote({ ...errorLote, mensaje: r.error });
      setFase(borradores.length ? "revisar" : "pegar");
      return;
    }
    const filas = r.items
      .map((q) => aBorrador(q, destino, lenguajeCodigo))
      .filter((f) => f.enunciado.length > 0);
    setBorradores((prev) => [...prev, ...filas].slice(0, MAX_FILAS_BORRADOR));
    setClasificadas((prev) => prev + filas.length);
    // Los bloques que el reintento SÍ clasificó dejan de ser «texto sin
    // clasificar». Sin esto el panel seguía listándolos —el panel existe para
    // que el docente confíe en que no se perdió nada— y su botón «Agregar como
    // abierta» insertaba DUPLICADOS, además degradados a `abierta`.
    const clasificadosAhora = filas.map((f) => f.enunciado.trim().toLowerCase());
    setHuerfanos((prev) =>
      prev.filter((bloque) => {
        const b = bloque.trim().toLowerCase();
        return !clasificadosAhora.some((e) => e.length > 0 && (b.includes(e) || e.includes(b)));
      }),
    );
    setErrorLote(null);
    setFase("revisar");
  };

  // ── Inserción ───────────────────────────────────────────────────────
  const agregar = async () => {
    if (!seleccionadas.length) return;
    setGuardando(true);
    try {
      let createdBy: string | null = null;
      if (destino === "bank") {
        const { data } = await supabase.auth.getUser();
        createdBy = data?.user?.id ?? null;
      }
      const filas = seleccionadas.map((fila, i) =>
        construirFilaPregunta(destino, fila, nextPosition + i, { targetId, createdBy }),
      );
      const { error } = await db.from(TABLA_POR_DESTINO[destino]).insert(filas);
      if (error) {
        // El diálogo QUEDA ABIERTO con la lista intacta: perder una revisión
        // de 30 preguntas por un error de red sería el peor resultado.
        toast.error(friendlyError(error));
        return;
      }
      const corregidos = seleccionadas.filter(
        (f) => f.tipoPropuesto && f.tipoPropuesto !== f.tipo,
      ).length;
      void logEvent({
        // Alineado con su hermana `ai_questions.generated` (examen, taller y
        // proyecto): misma categoría —si no, dos eventos de la misma familia
        // caen en filtros distintos— y con `entityId`, sin el cual no se puede
        // saber a QUÉ examen/taller le entraron las preguntas, que es lo único
        // que hace útil el registro.
        action: "ai_questions.identified",
        category: "grading",
        entityType: destino === "bank" ? "question_bank" : destino,
        entityId: targetId,
        courseId: courseId ?? null,
        metadata: {
          destino,
          propuestas: clasificadas,
          insertadas: filas.length,
          tipos_corregidos: corregidos,
          degradadas: seleccionadas.filter((f) => f.degradadoDe).length,
        },
      });
      toast.success(t("identifyQuestions.added", { count: filas.length }));
      onInserted?.(filas.length);
      limpiarTodo();
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setGuardando(false);
    }
  };

  const tiposDelDestino = TIPOS_ACEPTADOS_POR_DESTINO[destino] as readonly string[];
  const excedeTotal = pegadoTotal + texto.length > MAX_TEXTO_TOTAL_CHARS;
  const excedeLote = texto.length > MAX_TEXTO_CHARS;
  const topeFilas = borradores.length >= MAX_FILAS_BORRADOR;

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => void cerrar(o)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ScanText className="h-5 w-5" />
              {t("identifyQuestions.title")}
            </DialogTitle>
            <DialogDescription>
              {fase === "revisar"
                ? t("identifyQuestions.reviewSubtitle", { count: borradores.length })
                : t("identifyQuestions.pasteSubtitle")}
            </DialogDescription>
          </DialogHeader>

          {/* ── Fase 1 · pegar ─────────────────────────────────────── */}
          {fase === "pegar" && (
            <div className="space-y-3">
              <div
                className={`rounded-md border border-dashed p-4 text-center text-sm ${
                  arrastrando ? "border-primary bg-accent" : "border-muted-foreground/30"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setArrastrando(true);
                }}
                onDragLeave={() => setArrastrando(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setArrastrando(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) void cargarArchivo(f);
                }}
              >
                <FileUp className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                <p className="text-muted-foreground">{t("identifyQuestions.dropZone")}</p>
                <p className="text-2xs text-muted-foreground mt-1">
                  {t("identifyQuestions.dropZoneHint")}
                </p>
                <label className="mt-2 inline-flex">
                  <input
                    type="file"
                    accept={EXTENSIONES}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void cargarArchivo(f);
                      e.target.value = "";
                    }}
                  />
                  <span className="inline-flex h-8 items-center rounded-md border px-3 text-xs cursor-pointer hover:bg-accent">
                    {leyendoArchivo ? (
                      <Spinner size="xs" className="mr-1" />
                    ) : (
                      <FileUp className="h-3.5 w-3.5 mr-1" />
                    )}
                    {t("identifyQuestions.chooseFile")}
                  </span>
                </label>
              </div>

              <div>
                <Label required htmlFor="identify-text">
                  {t("identifyQuestions.textLabel")}{" "}
                  <HelpHint>{t("identifyQuestions.formatHint")}</HelpHint>
                </Label>
                <Textarea
                  id="identify-text"
                  autoFocus
                  rows={12}
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                  placeholder={t("identifyQuestions.textPlaceholder")}
                  className="font-mono text-xs"
                />
                <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
                  <span className="text-2xs text-muted-foreground">
                    {texto.trim()
                      ? t("identifyQuestions.detected", { count: segmentosDelTexto.length })
                      : t("identifyQuestions.detectedNone")}
                  </span>
                  <span
                    className={`text-2xs tabular-nums ${
                      excedeLote || excedeTotal ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {t("identifyQuestions.counter", {
                      n: texto.length,
                      max: MAX_TEXTO_CHARS,
                    })}
                  </span>
                </div>
                {(excedeLote || excedeTotal) && (
                  <p className="text-xs text-destructive mt-1">
                    {t("identifyQuestions.tooLongHint")}
                  </p>
                )}
              </div>

              <div className="sm:max-w-xs">
                <Label htmlFor="identify-lang">
                  {t("identifyQuestions.codeLanguageLabel")}{" "}
                  <HelpHint>{t("identifyQuestions.codeLanguageHint")}</HelpHint>
                </Label>
                <Select
                  value={lenguajeCodigo}
                  onValueChange={(v) => setLenguajeCodigo(v as LenguajeCodigo)}
                >
                  <SelectTrigger id="identify-lang">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LENGUAJES.map((l) => (
                      <SelectItem key={l} value={l}>
                        {t(`identifyQuestions.lang.${l}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <p className="text-2xs text-muted-foreground">
                {t("identifyQuestions.providerNotice")}
              </p>

              {errorLote && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-2">
                  <p className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                    <span className="break-words">{errorLote.mensaje}</span>
                  </p>
                  <Button size="sm" variant="outline" onClick={() => void reintentarLote()}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    {t("identifyQuestions.retryBatch")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ── Clasificando ───────────────────────────────────────── */}
          {fase === "clasificando" && (
            <div className="space-y-3 py-2">
              <Progress
                value={progreso.total ? Math.round((progreso.hechos / progreso.total) * 100) : 0}
              />
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Spinner size="sm" />
                {t("identifyQuestions.progress", {
                  lote: Math.min(progreso.hechos + 1, progreso.total),
                  lotes: progreso.total,
                  n: progreso.preguntas,
                })}
              </p>
              <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()}>
                {t("identifyQuestions.stop")}
              </Button>
              {borradores.length > 0 && (
                <p className="text-2xs text-muted-foreground">
                  {t("identifyQuestions.partialKept", { count: borradores.length })}
                </p>
              )}
            </div>
          )}

          {/* ── Fase 2 · revisar ───────────────────────────────────── */}
          {fase === "revisar" && (
            <div className="space-y-3">
              {(detectadas > clasificadas || truncado) && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs space-y-2">
                  <p className="flex items-start gap-2">
                    {/* `text-warning` para el ícono y color heredado para el
                        texto: `--warning-foreground` es el mismo valor oscuro en
                        los dos temas porque está pensado para ir sobre
                        `bg-warning` opaco, no sobre el 10% — en tema oscuro el
                        contraste quedaba ~1:1. */}
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                    <span>
                      {t("identifyQuestions.reconcile", {
                        detected: detectadas,
                        classified: clasificadas,
                      })}
                    </span>
                  </p>
                  {huerfanos.length > 0 && (
                    <details>
                      <summary className="cursor-pointer">
                        {t("identifyQuestions.unclassified", { count: huerfanos.length })}
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {huerfanos.map((h, i) => (
                          <li
                            key={`${i}-${h.slice(0, 12)}`}
                            className="rounded border bg-background p-2 space-y-1"
                          >
                            <p className="whitespace-pre-wrap break-words">{h}</p>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={topeFilas}
                              onClick={() => {
                                setBorradores((prev) => [...prev, abiertaDesdeTexto(h)]);
                                setHuerfanos((prev) => prev.filter((x) => x !== h));
                              }}
                            >
                              <Plus className="h-3.5 w-3.5 mr-1" />
                              {t("identifyQuestions.addAsOpen")}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              {descartadas.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    {t("identifyQuestions.discardedByAi", { count: descartadas.length })}
                  </summary>
                  <ul className="mt-1 list-disc pl-5 space-y-0.5">
                    {descartadas.map((d, i) => (
                      <li key={`${i}-${d.slice(0, 12)}`}>{d}</li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="flex flex-wrap items-end gap-2">
                {requierenRevision > 0 && (
                  <Button
                    size="sm"
                    variant={soloRevision ? "secondary" : "outline"}
                    onClick={() => setSoloRevision((v) => !v)}
                  >
                    {t("identifyQuestions.filterNeedsReview", { count: requierenRevision })}
                  </Button>
                )}
                <div>
                  <Label htmlFor="identify-points" className="text-2xs">
                    {t("identifyQuestions.pointsForAll")}
                  </Label>
                  <Input
                    id="identify-points"
                    type="number"
                    min={1}
                    max={100}
                    className="h-8 w-24"
                    onChange={(e) => {
                      const n = Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1)));
                      setBorradores((prev) => prev.map((b) => ({ ...b, puntos: n })));
                    }}
                  />
                </div>
                {borradores.some((b) => validaciones.get(b.id) != null) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setBorradores((prev) =>
                        prev.map((b) =>
                          validaciones.get(b.id) != null
                            ? { ...b, tipo: "abierta", incluida: true }
                            : b,
                        ),
                      )
                    }
                  >
                    <Wand2 className="h-3.5 w-3.5 mr-1" />
                    {t("identifyQuestions.fixAsOpen")}
                  </Button>
                )}
              </div>

              <ScrollArea className="flex-1 min-h-0 pr-2">
                <div className="space-y-3">
                  {visibles.map((fila) => (
                    <FilaBorrador
                      key={fila.id}
                      fila={fila}
                      tipos={tiposDelDestino}
                      motivoInvalido={validaciones.get(fila.id) ?? null}
                      onCambiar={(cambios) => actualizar(fila.id, cambios)}
                      onDescartar={() =>
                        setBorradores((prev) => prev.filter((b) => b.id !== fila.id))
                      }
                    />
                  ))}
                </div>
              </ScrollArea>

              {errorLote && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-2">
                  <p className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                    <span className="break-words">{errorLote.mensaje}</span>
                  </p>
                  <Button size="sm" variant="outline" onClick={() => void reintentarLote()}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    {t("identifyQuestions.retryBatch")}
                  </Button>
                </div>
              )}

              <p className="text-2xs text-muted-foreground">
                {t("identifyQuestions.notProposedNotice")}
              </p>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <span className="text-xs text-muted-foreground self-center">
              {fase === "revisar"
                ? t("identifyQuestions.selectedOf", {
                    m: seleccionadas.length,
                    n: borradores.length,
                  })
                : ""}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => void cerrar(false)} disabled={guardando}>
                {t("common.cancel")}
              </Button>
              {fase === "revisar" && (
                <Button
                  variant="outline"
                  onClick={() => setFase("pegar")}
                  disabled={guardando || topeFilas}
                >
                  {t("identifyQuestions.pasteMore")}
                </Button>
              )}
              {fase !== "clasificando" &&
                (fase === "pegar" ? (
                  <Button
                    onClick={() => void clasificar(texto, borradores.length > 0)}
                    disabled={
                      !texto.trim() ||
                      excedeLote ||
                      excedeTotal ||
                      leyendoArchivo ||
                      !segmentosDelTexto.length
                    }
                  >
                    <ScanText className="h-4 w-4 mr-1" />
                    {t("identifyQuestions.identify")}
                  </Button>
                ) : (
                  <Button
                    onClick={() => void agregar()}
                    disabled={guardando || seleccionadas.length === 0}
                  >
                    {guardando ? (
                      <Spinner size="sm" className="mr-1" />
                    ) : (
                      <Plus className="h-4 w-4 mr-1" />
                    )}
                    {/* Cuando hay filas inválidas el rótulo dice «Agregar 8 de
                        10»: insertar no es todo-o-nada por confusión. */}
                    {seleccionadas.length === borradores.length
                      ? t("identifyQuestions.addAll", { count: seleccionadas.length })
                      : t("identifyQuestions.addSome", {
                          m: seleccionadas.length,
                          n: borradores.length,
                        })}
                  </Button>
                ))}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sin este montaje, `ensureAuthorized()` queda colgada. */}
      <aiGate.GateDialog />
    </>
  );
}

const TONO_CONFIANZA: Record<Confianza, string> = {
  alta: "",
  media: "border-warning/40 bg-warning/10",
  baja: "border-destructive/40 bg-destructive/10 text-destructive",
};

/** Una fila del borrador: tipo, motivo, enunciado, rúbrica y campos del tipo. */
function FilaBorrador({
  fila,
  tipos,
  motivoInvalido,
  onCambiar,
  onDescartar,
}: {
  fila: BorradorPregunta;
  tipos: readonly string[];
  motivoInvalido: string | null;
  onCambiar: (cambios: Partial<BorradorPregunta>) => void;
  onDescartar: () => void;
}) {
  const { t } = useTranslation();
  const [verOriginal, setVerOriginal] = useState(false);

  const cambiarOpcion = (i: number, valor: string) => {
    const opciones = [...fila.opciones];
    opciones[i] = valor;
    onCambiar({ opciones });
  };

  const quitarOpcion = (i: number) => {
    const opciones = fila.opciones.filter((_, j) => j !== i);
    onCambiar({
      opciones,
      correcta:
        fila.correcta == null
          ? null
          : fila.correcta === i
            ? null
            : fila.correcta > i
              ? fila.correcta - 1
              : fila.correcta,
      correctas: fila.correctas.filter((c) => c !== i).map((c) => (c > i ? c - 1 : c)),
    });
  };

  return (
    <div
      className={`rounded-md border p-3 space-y-2 ${motivoInvalido ? "border-destructive/50" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          checked={fila.incluida}
          disabled={!!motivoInvalido}
          onCheckedChange={(v) => onCambiar({ incluida: v === true })}
          aria-label={t("identifyQuestions.includeRow")}
        />
        <Select value={fila.tipo} onValueChange={(v) => onCambiar({ tipo: v as TipoAceptado })}>
          <SelectTrigger className="h-8 w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tipos.map((tipo) => (
              <SelectItem key={tipo} value={tipo}>
                {questionTypeLabel(tipo, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge
          variant={fila.confianza === "alta" ? "secondary" : "outline"}
          className={TONO_CONFIANZA[fila.confianza]}
        >
          {t(`identifyQuestions.confidence.${fila.confianza}`)}
        </Badge>
        {fila.degradadoDe && (
          <Badge variant="outline" className={TONO_CONFIANZA.media}>
            {t("identifyQuestions.degraded")}{" "}
            <HelpHint>
              {t("identifyQuestions.degradedFrom", {
                // El tipo se pinta con su etiqueta, nunca crudo: cuando el
                // modelo inventa un tipo (`multiple_choice`), `degradadoDe` es
                // un identificador en inglés y el badge lo mostraba tal cual.
                type: questionTypeLabelKey(fila.degradadoDe)
                  ? questionTypeLabel(fila.degradadoDe, t)
                  : t("identifyQuestions.degradedFromUnknown"),
              })}
            </HelpHint>
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={100}
            value={fila.puntos}
            onChange={(e) =>
              onCambiar({
                puntos: Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))),
              })
            }
            className="h-8 w-16"
            aria-label={t("identifyQuestions.pointsRow")}
          />
          <RowAction
            label={t("identifyQuestions.discardRow")}
            icon={Trash2}
            tone="destructive"
            onClick={onDescartar}
          />
        </div>
      </div>

      {fila.motivo && <p className="text-xs text-muted-foreground">{fila.motivo}</p>}
      {motivoInvalido && <p className="text-xs text-destructive">{t(motivoInvalido)}</p>}

      <Textarea
        rows={2}
        value={fila.enunciado}
        onChange={(e) => onCambiar({ enunciado: e.target.value })}
        placeholder={t("identifyQuestions.statementPlaceholder")}
      />

      {(fila.tipo === "cerrada" || fila.tipo === "cerrada_multi") && (
        <div className="rounded-md border p-3 space-y-2">
          <Label className="text-2xs">{t("identifyQuestions.optionsLabel")}</Label>
          {fila.tipo === "cerrada" ? (
            <RadioGroup
              value={fila.correcta == null ? "" : String(fila.correcta)}
              onValueChange={(v) => onCambiar({ correcta: Number(v) })}
              className="space-y-2"
            >
              {fila.opciones.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <RadioGroupItem value={String(i)} id={`${fila.id}-o${i}`} />
                  <Input
                    value={o}
                    onChange={(e) => cambiarOpcion(i, e.target.value)}
                    className="h-8"
                  />
                  <RowAction
                    label={t("identifyQuestions.removeOption")}
                    icon={Trash2}
                    tone="destructive"
                    onClick={() => quitarOpcion(i)}
                  />
                </div>
              ))}
            </RadioGroup>
          ) : (
            <div className="space-y-2">
              {fila.opciones.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Checkbox
                    checked={fila.correctas.includes(i)}
                    onCheckedChange={(v) =>
                      onCambiar({
                        correctas:
                          v === true
                            ? [...new Set([...fila.correctas, i])].sort((a, b) => a - b)
                            : fila.correctas.filter((c) => c !== i),
                      })
                    }
                    aria-label={t("identifyQuestions.markCorrect")}
                  />
                  <Input
                    value={o}
                    onChange={(e) => cambiarOpcion(i, e.target.value)}
                    className="h-8"
                  />
                  <RowAction
                    label={t("identifyQuestions.removeOption")}
                    icon={Trash2}
                    tone="destructive"
                    onClick={() => quitarOpcion(i)}
                  />
                </div>
              ))}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <Label className="text-2xs">{t("identifyQuestions.minSelections")}</Label>
                  <Input
                    type="number"
                    min={1}
                    className="h-8"
                    value={fila.minSelecciones ?? ""}
                    onChange={(e) =>
                      onCambiar({
                        minSelecciones: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div>
                  <Label className="text-2xs">{t("identifyQuestions.maxSelections")}</Label>
                  <Input
                    type="number"
                    min={1}
                    className="h-8"
                    value={fila.maxSelecciones ?? ""}
                    onChange={(e) =>
                      onCambiar({
                        maxSelecciones: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </div>
              </div>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onCambiar({ opciones: [...fila.opciones, ""] })}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("identifyQuestions.addOption")}
          </Button>
        </div>
      )}

      {fila.tipo === "bd_sql" && (
        <div>
          <Label required className="text-2xs">
            {t("bdSql.setupSqlLabel")} <HelpHint>{t("bdSql.setupSqlHint")}</HelpHint>
          </Label>
          <Textarea
            rows={4}
            value={fila.setupSql}
            onChange={(e) => onCambiar({ setupSql: e.target.value })}
            placeholder={t("identifyQuestions.setupSqlPlaceholder")}
            className="font-mono text-xs"
          />
        </div>
      )}

      {fila.tipo === "codigo" && (
        <div className="sm:max-w-xs">
          <Label className="text-2xs">{t("identifyQuestions.codeLanguageLabel")}</Label>
          <Select
            value={fila.lenguaje}
            onValueChange={(v) => onCambiar({ lenguaje: v as LenguajeCodigo })}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LENGUAJES.map((l) => (
                <SelectItem key={l} value={l}>
                  {t(`identifyQuestions.lang.${l}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {fila.tipo === "java_gui" && (
        <div>
          <Label className="text-2xs">{t("hc_routesAppTeacherExamsExamId.fieldFramework")}</Label>
          <RadioGroup
            value={fila.javaFramework}
            onValueChange={(v) => onCambiar({ javaFramework: v as JavaFramework })}
            className="flex gap-4"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="swing" id={`${fila.id}-swing`} />
              <Label htmlFor={`${fila.id}-swing`} className="font-normal">
                {t("hc_routesAppTeacherExamsExamId.frameworkSwing")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="javafx" id={`${fila.id}-javafx`} />
              <Label htmlFor={`${fila.id}-javafx`} className="font-normal">
                JavaFX
              </Label>
            </div>
          </RadioGroup>
        </div>
      )}

      <div>
        <Label className="text-2xs">{t("identifyQuestions.rubricLabel")}</Label>
        <Textarea
          rows={2}
          value={fila.rubrica}
          onChange={(e) => onCambiar({ rubrica: e.target.value })}
          placeholder={t("identifyQuestions.rubricPlaceholder")}
        />
      </div>

      {fila.fragmento && (
        <div className="text-2xs">
          <button
            type="button"
            className="text-muted-foreground underline"
            onClick={() => setVerOriginal((v) => !v)}
          >
            {t("identifyQuestions.toggleSource")}
          </button>
          {verOriginal && (
            <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2">
              {fila.fragmento}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
