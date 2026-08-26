/**
 * Crear o editar un ESTUDIANTE desde la pantalla del docente.
 *
 * ── Por qué un diálogo propio y no el del Admin ────────────────────────
 * El del Admin (`app.admin.users.tsx`) tiene selector de roles, selector de
 * institución, `estado` académico y activación de la cuenta: cuatro cosas que un
 * docente NO puede tocar (las rechaza `trg_guard_profile_self_escalation`, y el
 * edge le fuerza el rol a Estudiante). Reusarlo significaría mostrar controles
 * que fallan al guardar, que es peor que no mostrarlos.
 *
 * Lo que queda es exactamente lo que el docente sí corrige: nombre, correo
 * institucional, código, documento y cohorte.
 *
 * ── El curso es obligatorio al crear, y no es un detalle de UI ─────────
 * El permiso del docente viene de dictar ese curso: una cuenta creada "sin
 * curso" no tendría de dónde derivarlo. El edge lo exige del lado servidor
 * (`soloDocente` + `course_name` requerido) y acá se pide antes de dejar
 * guardar, para que el error no llegue después de escribir todo el formulario.
 *
 * ── La contraseña ──────────────────────────────────────────────────────
 * No se pide: es la temporal fija de la plataforma, y el primer inicio de sesión
 * obliga a cambiarla. Por eso el docente no necesita leer
 * `admin_visible_passwords` (que sigue siendo Admin/SuperAdmin).
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";

/** Clave temporal de la plataforma. El primer login obliga a cambiarla. */
const CLAVE_TEMPORAL = "Temporal#123";

export interface EstudianteEditable {
  id: string;
  full_name: string;
  institutional_email: string;
  codigo: string | null;
  documento?: string | null;
  cohorte?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** null = crear. Con valor = editar ese estudiante. */
  editing: EstudianteEditable | null;
  /** Cursos que dicta el docente. Al crear, se matricula en el elegido. */
  courses: { id: string; name: string }[];
  /** Curso preseleccionado (el del filtro activo), si hay uno. */
  defaultCourseId?: string | null;
  onSaved: () => void;
}

export function TeacherStudentDialog({
  open,
  onOpenChange,
  editing,
  courses,
  defaultCourseId,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const [nombre, setNombre] = useState("");
  const [correo, setCorreo] = useState("");
  const [codigo, setCodigo] = useState("");
  const [documento, setDocumento] = useState("");
  const [cohorte, setCohorte] = useState("");
  const [courseId, setCourseId] = useState("");
  const [guardando, setGuardando] = useState(false);

  const esEdicion = !!editing;

  useEffect(() => {
    if (!open) return;
    setNombre(editing?.full_name ?? "");
    setCorreo(editing?.institutional_email ?? "");
    setCodigo(editing?.codigo ?? "");
    setDocumento(editing?.documento ?? "");
    setCohorte(editing?.cohorte ?? "");
    setCourseId(defaultCourseId && defaultCourseId !== "all" ? defaultCourseId : "");
  }, [open, editing, defaultCourseId]);

  const cursoElegido = useMemo(
    () => courses.find((c) => c.id === courseId) ?? null,
    [courses, courseId],
  );

  const faltaAlgo = !nombre.trim() || !correo.trim() || (!esEdicion && !cursoElegido);

  const guardar = async () => {
    if (faltaAlgo || guardando) return;
    setGuardando(true);
    try {
      if (esEdicion) {
        // UPDATE directo: lo habilita `profiles_docente_manage_own_students`
        // (mig 20261890000000), acotada a estudiantes de cursos que dicta.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from("profiles")
          .update({
            full_name: nombre.trim(),
            institutional_email: correo.trim(),
            codigo: codigo.trim() || null,
            documento: documento.trim() || null,
            cohorte: cohorte.trim() || null,
          })
          .eq("id", editing!.id);
        if (error) throw error;
        toast.success(t("teacherStudents.editOk"));
      } else {
        // El edge valida del lado servidor que el curso sea uno que dicta y le
        // fuerza el rol Estudiante. Acá NO se manda `roles`: mandarlo daría la
        // impresión de que el cliente lo decide.
        const { data, error } = await supabase.functions.invoke("bulk-import-users", {
          body: {
            rows: [
              {
                full_name: nombre.trim(),
                institutional_email: correo.trim(),
                personal_email: null,
                password: CLAVE_TEMPORAL,
                course_name: cursoElegido!.name,
                student_code: codigo.trim() || null,
                documento: documento.trim() || null,
                cohorte: cohorte.trim() || null,
                codigo: codigo.trim() || null,
                force_password_change: true,
              },
            ],
          },
        });
        if (error) throw error;
        const fila = (data?.result ?? [])[0];
        if (!fila?.ok) {
          // El motivo del edge es el que sirve ("el curso no existe", "ya
          // existe este correo"): mostrarlo tal cual, no un genérico.
          toast.error(fila?.reason ?? t("teacherStudents.createError"), { duration: 12000 });
          return;
        }
        toast.success(
          t("teacherStudents.createOk", {
            course: cursoElegido!.name,
            password: CLAVE_TEMPORAL,
          }),
          { duration: 14000 },
        );
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e), { duration: 12000 });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !guardando && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <UserPlus className="h-4 w-4 text-primary" />
            {esEdicion ? t("teacherStudents.editTitle") : t("teacherStudents.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {esEdicion ? t("teacherStudents.editDesc") : t("teacherStudents.createDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!esEdicion && (
            <div className="space-y-1">
              <Label required>{t("teacherStudents.courseLabel")}</Label>
              <Select value={courseId} onValueChange={setCourseId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={t("teacherStudents.coursePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-2xs text-muted-foreground">{t("teacherStudents.courseHint")}</p>
            </div>
          )}

          <div className="space-y-1">
            <Label required>{t("teacherStudents.nameLabel")}</Label>
            <Input value={nombre} onChange={(e) => setNombre(e.target.value)} className="h-9" />
          </div>

          <div className="space-y-1">
            <Label required>{t("teacherStudents.emailLabel")}</Label>
            <Input
              type="email"
              value={correo}
              onChange={(e) => setCorreo(e.target.value)}
              className="h-9"
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t("teacherStudents.codeLabel")}</Label>
              <Input value={codigo} onChange={(e) => setCodigo(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label>{t("teacherStudents.docLabel")}</Label>
              <Input
                value={documento}
                onChange={(e) => setDocumento(e.target.value)}
                className="h-9"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label>{t("teacherStudents.cohortLabel")}</Label>
            <Input value={cohorte} onChange={(e) => setCohorte(e.target.value)} className="h-9" />
          </div>

          {!esEdicion && (
            <p className="text-2xs text-muted-foreground rounded-md border border-dashed p-2">
              {t("teacherStudents.tempPasswordNote", { password: CLAVE_TEMPORAL })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={guardando}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void guardar()} disabled={faltaAlgo || guardando}>
            {guardando && <Spinner size="sm" className="mr-1" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
