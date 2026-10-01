import { useTranslation } from "react-i18next";

/**
 * Va debajo del selector de estado de un formulario cuando todos sus cursos
 * están en borrador: dice por qué «Publicado» no se ofrece (mig 20262690000000,
 * regla en `curso-borrador.ts`). `cursos` es cuántos cursos tiene el formulario,
 * para el singular/plural.
 */
export function AvisoCursoEnBorrador({ cursos }: { cursos: number }) {
  const { t } = useTranslation();
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {t("publicacion.cursoEnBorradorForm", { count: Math.max(1, cursos) })}
    </p>
  );
}
