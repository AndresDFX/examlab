/**
 * Tipo/modalidad de una sesión de clase (`attendance_sessions.session_type`).
 *
 *  - presencial — clase en el aula (check-in por QR rotativo).
 *  - virtual    — clase por videollamada (meeting_url). DEFAULT de los históricos.
 *  - autonoma   — el alumno revisa el material por su cuenta; al llegar la fecha/
 *                 hora de inicio se le notifica, y "asiste" marcando el material
 *                 como revisado (RPC student_review_autonomous_session).
 *
 * Metadata compartida (label i18n + ícono + color) para que docente, estudiante
 * y calendarios pinten el badge de forma consistente. Badge PLANO + ícono (no
 * StatusBadge — precedente: la modalidad de horarios usa span + ícono).
 */
import { MapPin, Video, BookOpen, type LucideIcon } from "lucide-react";

export type SessionType = "presencial" | "virtual" | "autonoma";

/** Orden canónico para los <Select> y para iterar. */
export const SESSION_TYPES: SessionType[] = ["presencial", "virtual", "autonoma"];

/** Default de negocio (backfill de históricos + fallback cuando falta el dato). */
export const DEFAULT_SESSION_TYPE: SessionType = "virtual";

export function isSessionType(v: unknown): v is SessionType {
  return v === "presencial" || v === "virtual" || v === "autonoma";
}

/** Normaliza un valor crudo de DB (posible null/undefined) a un SessionType. */
export function coerceSessionType(v: unknown): SessionType {
  return isSessionType(v) ? v : DEFAULT_SESSION_TYPE;
}

interface SessionTypeMeta {
  /** Clave i18n de la etiqueta legible. */
  labelKey: string;
  icon: LucideIcon;
  /** Clases Tailwind para el ícono/acento del badge. */
  colorClass: string;
}

const META: Record<SessionType, SessionTypeMeta> = {
  presencial: {
    labelKey: "sessionType.presencial",
    icon: MapPin,
    colorClass: "text-emerald-600 dark:text-emerald-400",
  },
  virtual: {
    labelKey: "sessionType.virtual",
    icon: Video,
    colorClass: "text-sky-600 dark:text-sky-400",
  },
  autonoma: {
    labelKey: "sessionType.autonoma",
    icon: BookOpen,
    colorClass: "text-violet-600 dark:text-violet-400",
  },
};

export function sessionTypeMeta(type: unknown): SessionTypeMeta {
  return META[coerceSessionType(type)];
}
