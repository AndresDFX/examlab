/**
 * "Faltan por responder", por curso. Lo usan los DOS diálogos de resultados.
 *
 * ── Por qué un componente y no el bloque repetido ─────────────────────
 * Estaba solo en el diálogo de encuestas por OPCIÓN. El de encuestas con preguntas
 * propias no lo tenía, así que en una encuesta de inicio de semestre el docente
 * veía "38 respuestas" sin saber si faltaban 3 o 44, ni a quién recordarle — y esa
 * es justo la encuesta donde el dato importa, porque de ella salen consolidados que
 * se entregan.
 *
 * Copiarlo habría dejado dos versiones divergiendo: se arregla el conteo en una y
 * la otra sigue mintiendo.
 *
 * ── El desglose es POR CURSO ──────────────────────────────────────────
 * Una encuesta se comparte con varios cursos. Una lista plana de 44 nombres no dice
 * a qué grupo escribirle; por curso, cada fila es una acción posible.
 */
import { useTranslation } from "react-i18next";
import { UserX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ResumenPendientes } from "./pending-respondents";

export function PendingRespondentsCard({ pendientes }: { pendientes: ResumenPendientes | null }) {
  const { t } = useTranslation();
  if (!pendientes || pendientes.totalUnico === 0) return null;

  return (
    <div className="rounded-md border p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <UserX className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <p className="text-xs font-medium">
          {pendientes.faltanUnico === 0
            ? t("teacherPolls.pendingNone", { total: pendientes.totalUnico })
            : t("teacherPolls.pendingTitle", {
                count: pendientes.faltanUnico,
                total: pendientes.totalUnico,
              })}
        </p>
      </div>
      {pendientes.faltanUnico > 0 &&
        pendientes.porCurso.map((c) => (
          <div key={c.courseId} className="space-y-1">
            {/* El encabezado del curso se muestra SIEMPRE que haya más de uno,
                incluso si ese curso ya respondió completo: sin él, no se distingue
                "este curso está al día" de "este curso no está en la encuesta". */}
            {pendientes.porCurso.length > 1 && (
              <p className="text-2xs font-medium text-muted-foreground">
                {c.courseName}{" "}
                <span className="tabular-nums">
                  ({c.faltan.length}/{c.total})
                </span>
              </p>
            )}
            {c.faltan.length === 0 ? (
              <p className="text-2xs text-emerald-600 dark:text-emerald-400">
                {t("teacherPolls.pendingCourseComplete")}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {c.faltan.map((f) => (
                  <li key={`${c.courseId}:${f.userId}`}>
                    <Badge variant="outline" className="text-3xs font-normal">
                      {f.fullName}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
    </div>
  );
}
