/**
 * El curso de una actividad en las listas del estudiante (exámenes, talleres y
 * proyectos), a la vista y no como texto gris, y el aviso cuando otro curso suyo
 * tiene una actividad con el MISMO nombre. Ver `actividades-homonimas.ts` para el
 * caso que lo originó: dos talleres homónimos de dos asignaturas de la misma
 * cohorte, y un estudiante que entregó el de la otra materia.
 *
 * Ícono `BookOpen`: es el de «Cursos» en el menú; el mismo concepto lleva el
 * mismo ícono en toda la plataforma.
 */
import { AlertTriangle, BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

export function CursoDeLaActividad({ curso }: { curso: string | null | undefined }) {
  if (!curso) return null;
  return (
    // Sin recortar: el nombre del curso es justo el dato que distingue dos
    // actividades homónimas, y en un teléfono no hay `title` que lo complete.
    <span className="inline-flex max-w-full items-start gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
      <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 whitespace-normal break-words">{curso}</span>
    </span>
  );
}

export function AvisoActividadHomonima({ cursos }: { cursos: readonly string[] | undefined }) {
  const { t } = useTranslation();
  if (!cursos || cursos.length === 0) return null;
  return (
    <p className="flex items-start gap-1 text-2xs text-warning-on-subtle">
      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
      <span>{t("actividadHomonima.aviso", { count: cursos.length, cursos: cursos.join(", ") })}</span>
    </p>
  );
}
