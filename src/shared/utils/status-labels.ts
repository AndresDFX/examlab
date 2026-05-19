/**
 * Traduce los estados que viven crudos en la DB (en inglés / snake_case)
 * a etiquetas legibles en español o inglés. Antes algunos grids mostraban
 * "published" sin traducir y otros "Publicado" — esta función centraliza
 * la presentación.
 */
type Lang = "es" | "en";

const STATUS_MAP: Record<string, { es: string; en: string }> = {
  // Estados de Exam / Workshop / Project
  draft: { es: "Borrador", en: "Draft" },
  published: { es: "Publicado", en: "Published" },
  closed: { es: "Cerrado", en: "Closed" },
  archived: { es: "Archivado", en: "Archived" },

  // Estados de submissions (exam, workshop, project)
  en_progreso: { es: "En progreso", en: "In progress" },
  entregado: { es: "Entregado", en: "Submitted" },
  calificado: { es: "Calificado", en: "Graded" },
  ai_revisado: { es: "Revisado por IA", en: "AI reviewed" },
  sospechoso: { es: "Sospechoso", en: "Suspicious" },
  // Estado derivado: la submission fue marcada como sospechosa pero
  // todas las alertas (IA y plagio) fueron revisadas por el docente.
  chequeado: { es: "Chequeado", en: "Reviewed" },
  pending: { es: "Pendiente", en: "Pending" },
};

export function statusLabel(status: string | null | undefined, lang: Lang = "es"): string {
  if (!status) return "—";
  const entry = STATUS_MAP[status];
  if (entry) return entry[lang];
  // Fallback amigable: "ai_revisado" → "Ai revisado".
  const cleaned = status.replace(/_/g, " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
