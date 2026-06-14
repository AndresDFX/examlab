/**
 * Selector "Asociar a sesión (opcional)" para exámenes / talleres / proyectos.
 *
 * Carga las sesiones de asistencia del curso dado y permite asociar la
 * actividad a una de ellas (attendance_session_id). Si no se asocia, la
 * actividad aparece en "General" del tablero. Mismo patrón que el selector
 * de sesión de las encuestas.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Label } from "@/components/ui/label";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateOnly } from "@/shared/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const NONE = "__none__";

interface SessionRow {
  id: string;
  title: string | null;
  session_date: string;
}

export function ActivitySessionSelect({
  courseId,
  value,
  onChange,
  disabled,
}: {
  /** Curso ancla de la actividad. Sin curso → el selector queda deshabilitado. */
  courseId: string | null | undefined;
  value: string | null;
  onChange: (sessionId: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  useEffect(() => {
    if (!courseId) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await db
        .from("attendance_sessions")
        .select("id, title, session_date")
        .eq("course_id", courseId)
        .is("deleted_at", null)
        .order("session_date", { ascending: true });
      if (cancelled) return;
      setSessions((data ?? []) as SessionRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  return (
    <div>
      <Label>
        {t("activitySession.label", { defaultValue: "Asociar a sesión (opcional)" })}{" "}
        <HelpHint>
          {t("activitySession.hint", {
            defaultValue:
              "Si la asocias a una sesión, aparece bajo esa clase en el tablero del docente y del estudiante. Si no, aparece en la sección General del curso.",
          })}
        </HelpHint>
      </Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
        disabled={disabled || !courseId}
      >
        <SelectTrigger className="mt-1">
          <SelectValue
            placeholder={t("activitySession.placeholder", { defaultValue: "General (sin sesión)" })}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            {t("activitySession.none", { defaultValue: "General (sin sesión)" })}
          </SelectItem>
          {sessions.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {formatDateOnly(s.session_date)}
              {s.title ? ` · ${s.title}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
