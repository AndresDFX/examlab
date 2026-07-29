/**
 * Paleta de comandos (⌘K / Ctrl+K).
 *
 * Mitigación inmediata del sidebar de 22 ítems planos: en vez de escanear una
 * lista monocroma —cuyos últimos ítems quedan bajo el pliegue en pantallas de
 * 768px de alto— se escribe el nombre y se llega.
 *
 * NO decide qué puede ver el usuario: recibe los destinos YA filtrados por rol
 * y por `module_visibility` desde `AppLayout` (que es donde vive esa lógica).
 * Duplicar el filtro acá habría creado dos fuentes de verdad que se
 * desincronizan en el primer módulo nuevo.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { GraduationCap, Search } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { isStaffActive } from "@/shared/lib/roles";

/** Destino ya resuelto (label traducido) que la paleta puede ofrecer. */
export type PaletteDestination = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

type CourseOption = { id: string; name: string; period: string | null };

/** Tope de cursos en la paleta: es un buscador, no un listado. */
const MAX_COURSES = 50;

export function CommandPalette({
  destinations,
}: {
  destinations: readonly PaletteDestination[];
}) {
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const activeRole = useActiveRole();
  const navigate = useNavigate();
  // Los cursos solo se ofrecen a quien tiene un destino REAL por curso: el
  // tablero `/app/teacher/board/$courseId` (ya permitido en rbac.ts para
  // Docente/Admin/SuperAdmin). El estudiante no tiene ruta por curso — el
  // curso seleccionado es estado local, no va en la URL —, así que ofrecerle
  // un curso lo dejaría en la lista sin seleccionar nada: una acción a medias
  // es peor que no tenerla. Cuando la ruta del alumno acepte el curso por
  // search param, se le habilita acá.
  //
  // Se gatea por rol ACTIVO (no por roles poseídos): un usuario multi-rol
  // actuando como Estudiante no debe ver atajos de staff.
  const staff = isStaffActive(activeRole, roles);
  const [open, setOpen] = useState(false);
  const [courses, setCourses] = useState<CourseOption[]>([]);

  // Atajo global. El listener se registra en un effect (no en el render) y se
  // limpia al desmontar; `metaKey` cubre macOS y `ctrlKey` el resto.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k") return;
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Los cursos se cargan al ABRIR, no al montar: son un dato secundario y no
  // deben costarle una query a cada carga de página.
  useEffect(() => {
    if (!open || !user || !staff || courses.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        // La RLS acota lo que cada rol ve; acá solo se excluye la papelera.
        const { data } = await supabase
          .from("courses")
          .select("id, name, period")
          .is("deleted_at", null)
          .order("name")
          .limit(MAX_COURSES);
        if (cancelled) return;
        setCourses((data as CourseOption[]) ?? []);
      } catch {
        // Sin cursos la paleta sigue sirviendo para los módulos.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user, staff, courses.length]);

  const go = (to: string) => {
    setOpen(false);
    // `as never`: los destinos vienen del NAV, que son rutas válidas, pero el
    // tipo de `to` de TanStack es una unión literal que un string no satisface.
    void navigate({ to: to as never });
  };

  const courseItems = useMemo(
    () =>
      courses.map((c) => ({
        ...c,
        // El periodo entra al texto buscable: "Paradigmas 2026" debe encontrar
        // el curso aunque el nombre no lleve el año.
        searchable: `${c.name} ${c.period ?? ""}`.trim(),
      })),
    [courses],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-sidebar-border/60 px-2 py-1.5 text-2xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50"
        aria-label={t("palette.openLabel")}
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">{t("palette.trigger")}</span>
        {/* El atajo se muestra en el disparador: si no se anuncia, nadie lo
            descubre y la paleta no existe para el usuario. */}
        <kbd className="hidden rounded border border-sidebar-border/60 px-1 font-mono text-3xs sm:inline">
          ⌘K
        </kbd>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder={t("palette.placeholder")} />
        <CommandList>
          <CommandEmpty>{t("palette.empty")}</CommandEmpty>
          <CommandGroup heading={t("palette.groupModules")}>
            {destinations.map((d) => (
              <CommandItem
                key={d.to}
                value={d.label}
                onSelect={() => go(d.to)}
              >
                <d.icon className="mr-2 h-4 w-4" />
                {d.label}
              </CommandItem>
            ))}
          </CommandGroup>
          {courseItems.length > 0 && (
            <CommandGroup heading={t("palette.groupCourses")}>
              {courseItems.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.searchable}
                  onSelect={() => go(`/app/teacher/board/${c.id}`)}
                >
                  <GraduationCap className="mr-2 h-4 w-4" />
                  <span className="truncate">{c.name}</span>
                  {c.period ? (
                    <span className="ml-2 shrink-0 text-3xs text-muted-foreground">
                      {c.period}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
