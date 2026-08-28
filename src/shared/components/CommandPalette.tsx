/**
 * Paleta de comandos (⌘K / Ctrl+K) — buscador GLOBAL.
 *
 * Nació como mitigación del sidebar de 22 ítems planos: en vez de escanear una
 * lista monocroma se escribe el nombre y se llega. Pero mientras solo ofreció
 * los destinos del sidebar fue un conmutador de módulos, no un buscador: el
 * usuario escribía el nombre de un examen y no encontraba nada, tenía que
 * entrar al módulo y volver a buscar adentro.
 *
 * Ahora, con 2+ caracteres, consulta el servidor y ofrece la ENTIDAD concreta
 * (curso, examen, taller, proyecto, contenido, pizarra, usuario). Toda la
 * lógica de qué se busca, con qué alcance y a dónde lleva vive en
 * `@/modules/search/global-search` — acá queda solo el orquestado de la UI.
 *
 * Este componente NO decide qué MÓDULOS puede ver el usuario: los recibe ya
 * filtrados por rol y por `module_visibility` desde `AppLayout` (que es donde
 * vive esa lógica). Duplicar el filtro acá habría creado dos fuentes de verdad
 * que se desincronizan en el primer módulo nuevo.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  FileText,
  FolderKanban,
  Hammer,
  Palette,
  Presentation,
  Search,
  Users,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { isStaffActive } from "@/shared/lib/roles";
import { scopedCourseIds } from "@/modules/courses/course-scope";
import {
  PALETTE_KIND_ORDER,
  loadSearchScope,
  searchGlobal,
  type PaletteHit,
  type PaletteKind,
  type SearchScope,
} from "@/modules/search/global-search";
import { MIN_QUERY_LENGTH, matchesQuery } from "@/modules/search/search-text";

/** Destino ya resuelto (label traducido) que la paleta puede ofrecer. */
export type PaletteDestination = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

type CourseOption = { id: string; name: string; period: string | null };

/** Tope de cursos precargados (estado sin consulta). Es un buscador, no un listado. */
const MAX_COURSES = 50;

/**
 * Espera antes de consultar. Suficiente para que escribir "matematicas" no
 * dispare once búsquedas, corto para que no se sienta lento.
 */
const SEARCH_DEBOUNCE_MS = 280;

/**
 * Un ícono por concepto, el MISMO que usan el sidebar y los PageHeader de cada
 * módulo: si el buscador inventara íconos propios, el resultado no se
 * reconocería como "eso que está en el menú".
 */
const KIND_ICON: Record<PaletteKind, React.ComponentType<{ className?: string }>> = {
  course: BookOpen,
  exam: FileText,
  workshop: Hammer,
  project: FolderKanban,
  content: Presentation,
  whiteboard: Palette,
  user: Users,
};

const KIND_LABEL_KEY: Record<PaletteKind, string> = {
  course: "palette.groupCourses",
  exam: "palette.groupExams",
  workshop: "palette.groupWorkshops",
  project: "palette.groupProjects",
  content: "palette.groupContents",
  whiteboard: "palette.groupWhiteboards",
  user: "palette.groupUsers",
};

export function CommandPalette({ destinations }: { destinations: readonly PaletteDestination[] }) {
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const activeRole = useActiveRole();
  const navigate = useNavigate();
  // Los cursos precargados solo se ofrecen a quien tiene un destino REAL por
  // curso: el tablero `/app/teacher/board/$courseId` (permitido en rbac.ts para
  // Docente/Admin/SuperAdmin). El estudiante no tiene ruta por curso — el curso
  // seleccionado es estado local, no va en la URL —, así que ofrecerle un curso
  // lo dejaría en la lista sin seleccionar nada: una acción a medias es peor
  // que no tenerla.
  //
  // Se gatea por rol ACTIVO (no por roles poseídos): un usuario multi-rol
  // actuando como Estudiante no debe ver atajos de staff.
  const staff = isStaffActive(activeRole, roles);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  // Rol con el que se cargó la lista. Sin esto, un usuario multi-rol que pasa de
  // Admin a Docente seguía viendo la lista cacheada del tenant completo: el
  // cambio de rol tiene que invalidarla.
  const fetchedForRole = useRef<string | null>(null);
  // El alcance (cursos que dicta, asignaciones del alumno, permisos por rol) no
  // depende del texto: se resuelve una vez y se reusa entre pulsaciones. La
  // clave incluye el rol ACTIVO, así que cambiar de rol lo invalida.
  const scopeRef = useRef<{ key: string; scope: SearchScope } | null>(null);
  // El atajo se ANUNCIA segun la plataforma: mostrar "⌘K" en Windows manda al
  // usuario a buscar una tecla Cmd que no existe. Arranca en false
  // (deterministico) y se resuelve post-mount: leer `navigator` en el
  // initializer de useState rompe la hidratacion (React #418).
  const [isMac, setIsMac] = useState(false);

  // `roles` es un array nuevo en cada render de `useAuth`; si entrara crudo en
  // las deps del efecto de búsqueda, el debounce se reiniciaría solo y la
  // consulta no saldría nunca. Se usa una clave estable + un ref con el valor.
  const rolesKey = roles.join("|");
  const rolesRef = useRef(roles);
  rolesRef.current = roles;

  // Atajo global. El listener se registra en un effect (no en el render) y se
  // limpia al desmontar; `metaKey` cubre macOS y `ctrlKey` el resto.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // El MODIFICADOR se comprueba primero, y `key` se lee con guarda. Las dos
      // cosas son por el mismo bug de producción: este listener está montado en
      // todo `/app/*`, corría en CADA tecla, y `e.key` puede llegar `undefined` —
      // eventos sintéticos de un gestor de contraseñas, composición de un IME—.
      // Ahí `e.key.toLowerCase()` tiraba un TypeError NO capturado, que además no
      // pasa por el ErrorBoundary porque no ocurre en un render. Aparecía en los
      // registros como "Cannot read properties of undefined (reading
      // 'toLowerCase')" en /app y en /app/admin/users, que son justo las pantallas
      // donde más se teclea y donde el gestor de contraseñas se activa (el
      // diálogo de usuarios tiene campo de contraseña). Se repitió en tres builds
      // distintos entre el 23 y el 27 de agosto.
      if (!e.metaKey && !e.ctrlKey) return;
      if (typeof e.key !== "string" || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const ua = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
    setIsMac(/mac|iphone|ipad|ipod/i.test(ua));
  }, []);

  // Al cerrar se limpia todo: reabrir con la búsqueda anterior ya escrita
  // (y sus resultados, quizá obsoletos) es desconcertante.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setHits([]);
    setSearching(false);
    setSearchFailed(false);
  }, [open]);

  // Los cursos se cargan al ABRIR, no al montar: son un dato secundario y no
  // deben costarle una query a cada carga de página.
  useEffect(() => {
    if (!open || !user || !staff) return;
    if (fetchedForRole.current === (activeRole ?? "")) return;
    let cancelled = false;
    void (async () => {
      try {
        // El comentario que había acá decía que "la RLS acota lo que cada rol ve".
        // Es FALSO para `courses`: su policy deja ver todos los cursos del
        // tenant a cualquier autenticado, así que un docente veía en el buscador
        // cursos que no dicta — y podía navegar a su tablero. El scoping por rol
        // ACTIVO tiene que hacerlo el cliente (ver course-scope.ts).
        const ids = await scopedCourseIds(activeRole, roles, user.id);
        if (cancelled) return;
        if (ids && ids.length === 0) {
          // Docente sin cursos: lista vacía SIN consultar. Un `.in("id", [])` en
          // PostgREST devuelve TODAS las filas, no ninguna.
          setCourses([]);
          fetchedForRole.current = activeRole ?? "";
          return;
        }
        let q = supabase
          .from("courses")
          .select("id, name, period")
          .is("deleted_at", null)
          .order("name")
          .limit(MAX_COURSES);
        if (ids) q = q.in("id", ids);
        const { data } = await q;
        if (cancelled) return;
        setCourses((data as CourseOption[]) ?? []);
        fetchedForRole.current = activeRole ?? "";
      } catch {
        // Sin cursos la paleta sigue sirviendo para los módulos.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user, staff, activeRole, roles]);

  // Búsqueda de ENTIDADES contra el servidor, con debounce.
  //
  // El guard `cancelled` no es ceremonia: el usuario sigue tecleando y las
  // respuestas llegan fuera de orden — sin él, la respuesta lenta de "mat"
  // pisaría a la de "matematicas".
  useEffect(() => {
    // Se depende del ID y no del objeto `user`: si alguna vez cambia de
    // identidad por render, el debounce se reiniciaría solo y no buscaría nunca.
    const userId = user?.id;
    if (!open || !userId) return;
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setHits([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // El rol ACTIVO y los roles poseídos entran en la clave: cambiar de
          // rol tiene que invalidar el alcance cacheado, no reusarlo.
          const key = `${userId}:${activeRole ?? ""}:${rolesKey}`;
          let cached = scopeRef.current;
          if (!cached || cached.key !== key) {
            const scope = await loadSearchScope(userId, activeRole, rolesRef.current);
            if (cancelled) return;
            cached = { key, scope };
            scopeRef.current = cached;
          }
          const res = await searchGlobal(q, cached.scope);
          if (cancelled) return;
          setHits(res.hits);
          setSearchFailed(res.failed);
        } catch {
          if (cancelled) return;
          // Un error de red no puede romper la paleta: se avisa y los módulos
          // (que no dependen del servidor) siguen navegables.
          setHits([]);
          setSearchFailed(true);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, user?.id, activeRole, rolesKey]);

  const shortcut = isMac ? "⌘K" : "Ctrl+K";
  const trimmed = query.trim();
  const isSearching = trimmed.length >= MIN_QUERY_LENGTH;

  const go = (to: string) => {
    setOpen(false);
    // `as never`: los destinos vienen del NAV, que son rutas válidas, pero el
    // tipo de `to` de TanStack es una unión literal que un string no satisface.
    void navigate({ to: to as never });
  };

  const goCourse = (courseId: string) => {
    setOpen(false);
    // Ruta con parámetro: NUNCA interpolar la URL a mano. El router no matchea
    // el patrón `$courseId` contra un path ya resuelto y la navegación falla en
    // silencio (era lo que hacía esta lista antes).
    void navigate({
      to: "/app/teacher/board/$courseId" as never,
      params: { courseId } as never,
    });
  };

  const goHit = (hit: PaletteHit) => {
    setOpen(false);
    // Params y search se pasan por separado: una URL interpolada a mano NO
    // matchea el patrón `$examId` del router y falla en silencio.
    void navigate({
      to: hit.to as never,
      params: hit.params as never,
      search: hit.search as never,
    });
  };

  // cmdk filtra en cliente con un `includes` crudo, que no ignora acentos ni
  // sirve para resultados que YA vienen filtrados del servidor. Con
  // `shouldFilter={false}` el filtro de los módulos lo hacemos acá, con la
  // normalización de `search-text` (así "matematicas" encuentra "Matemáticas").
  const moduleItems = useMemo(
    () =>
      trimmed.length === 0
        ? destinations
        : destinations.filter((d) => matchesQuery(d.label, trimmed)),
    [destinations, trimmed],
  );

  const courseItems = useMemo(() => {
    // Con búsqueda activa mandan los resultados del servidor (que además están
    // acotados igual): mostrar las dos listas duplicaría cada curso.
    if (isSearching) return [];
    return courses
      .filter((c) => matchesQuery(`${c.name} ${c.period ?? ""}`, trimmed))
      .map((c) => ({ ...c }));
  }, [courses, trimmed, isSearching]);

  const groups = useMemo(
    () =>
      PALETTE_KIND_ORDER.map((kind) => ({
        kind,
        items: hits.filter((h) => h.kind === kind),
      })).filter((g) => g.items.length > 0),
    [hits],
  );

  const hasAnything = moduleItems.length > 0 || courseItems.length > 0 || groups.length > 0;

  return (
    <>
      {/* Los colores salen de los tokens del SIDEBAR, no de los de página.
          `text-muted-foreground` está calculado contra `--background`; sobre el
          sidebar —que TenantThemeProvider pinta con el color de la institución—
          queda casi ilegible (con una marca naranja, gris claro sobre naranja).
          Los ítems del nav de al lado ya usan `text-sidebar-foreground`, así que
          esto además los desalineaba visualmente. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-sidebar-foreground/25 bg-sidebar-foreground/5 px-2 py-1.5 text-2xs text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        aria-label={t("palette.openLabel", { shortcut })}
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">{t("palette.trigger")}</span>
        {/* El atajo se muestra en el disparador: si no se anuncia, nadie lo
            descubre y la paleta no existe para el usuario. */}
        {/* Oculto en movil a proposito: ahi no hay teclado que anunciar. */}
        <kbd className="hidden rounded border border-sidebar-foreground/25 px-1 font-mono text-3xs text-sidebar-foreground/70 sm:inline">
          {shortcut}
        </kbd>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
        <CommandInput
          placeholder={t("palette.placeholder")}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {/* Vacío HONESTO: distingue "todavía estoy buscando" de "no hay nada
              que coincida" de "escribí algo". Sin eso el usuario no sabe si
              esperar o cambiar la consulta. */}
          <CommandEmpty>
            {searching
              ? t("palette.searching")
              : isSearching
                ? t("palette.noMatches", { query: trimmed })
                : t("palette.empty")}
          </CommandEmpty>

          {searching && hasAnything ? (
            <div className="flex items-center gap-2 px-3 py-2 text-2xs text-muted-foreground">
              <Spinner size="xs" />
              <span>{t("palette.searching")}</span>
            </div>
          ) : null}

          {searchFailed && !searching ? (
            <div className="px-3 py-2 text-2xs text-destructive">{t("palette.searchError")}</div>
          ) : null}

          {moduleItems.length > 0 && (
            <CommandGroup heading={t("palette.groupModules")}>
              {moduleItems.map((d) => (
                <CommandItem key={d.to} value={d.to} onSelect={() => go(d.to)}>
                  <d.icon className="mr-2 h-4 w-4" />
                  {d.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {courseItems.length > 0 && (
            <CommandGroup heading={t("palette.groupCourses")}>
              {courseItems.map((c) => (
                <CommandItem key={c.id} value={`course:${c.id}`} onSelect={() => goCourse(c.id)}>
                  <BookOpen className="mr-2 h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.period ? (
                    <span className="ml-2 max-w-[45%] shrink truncate text-3xs text-muted-foreground">
                      {c.period}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {groups.map((g) => {
            const Icon = KIND_ICON[g.kind];
            return (
              <CommandGroup key={g.kind} heading={t(KIND_LABEL_KEY[g.kind])}>
                {g.items.map((h) => (
                  <CommandItem key={h.key} value={h.key} onSelect={() => goHit(h)}>
                    <Icon className="mr-2 h-4 w-4" />
                    {/* El identificador manda: es la única celda con `flex-1`,
                        y el dato secundario puede encogerse (NO `shrink-0`, o un
                        título largo empujaría la fila). */}
                    <span className="min-w-0 flex-1 truncate">{h.title}</span>
                    {/* El dato secundario desambigua: dos talleres se pueden
                        llamar igual en cursos distintos. */}
                    {h.subtitle ? (
                      <span className="ml-2 max-w-[45%] shrink truncate text-3xs text-muted-foreground">
                        {h.subtitle}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
      </CommandDialog>
    </>
  );
}
