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
 * ── Al menos un curso al crear, y no es un detalle de UI ───────────────
 * El permiso del docente viene de dictar ese curso: una cuenta creada "sin
 * curso" no tendría de dónde derivarlo. El edge lo exige del lado servidor
 * (`soloDocente` + `course_name` requerido) y acá se pide antes de dejar
 * guardar, para que el error no llegue después de escribir todo el formulario.
 *
 * Pueden ser VARIOS: el estudiante que cursa dos asignaturas con el mismo
 * docente se daba de alta dos veces (la segunda apoyándose en que el edge es
 * aditivo con usuarios existentes, lo cual mostraba un toast de "cuenta creada"
 * que era mentira). Se eligieron casillas y no un Select múltiple por lo mismo
 * que el diálogo del Admin: lo marcado es justo lo que hay que revisar antes de
 * crear la cuenta, y con un Select hay que abrirlo para saberlo.
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
import { CourseCheckboxList } from "@/components/ui/course-checkbox-list";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  classifyImportOutcome,
  resolveCourseSelection,
} from "@/modules/admin/teacher-student-courses";

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
  /** Cursos que dicta el docente. Al crear, se matricula en los marcados. */
  courses: { id: string; name: string; period?: string | null }[];
  /** Curso premarcado (el del filtro activo), si hay uno. */
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
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [guardando, setGuardando] = useState(false);

  const esEdicion = !!editing;

  useEffect(() => {
    if (!open) return;
    setNombre(editing?.full_name ?? "");
    setCorreo(editing?.institutional_email ?? "");
    setCodigo(editing?.codigo ?? "");
    setDocumento(editing?.documento ?? "");
    setCohorte(editing?.cohorte ?? "");
    // "all" es el sentinel del filtro de curso de la pantalla: no premarca nada.
    setCourseIds(defaultCourseId && defaultCourseId !== "all" ? [defaultCourseId] : []);
  }, [open, editing, defaultCourseId]);

  const seleccion = useMemo(() => resolveCourseSelection(courseIds, courses), [courseIds, courses]);

  const faltaAlgo = !nombre.trim() || !correo.trim() || (!esEdicion && seleccion.problem !== null);

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
        // El edge valida del lado servidor que los cursos sean de los que dicta
        // (resuelve los nombres SOLO contra su `course_teachers`) y le fuerza el
        // rol Estudiante. Acá NO se manda `roles`: mandarlo daría la impresión de
        // que el cliente lo decide.
        //
        // Las matrículas van DENTRO de esta llamada y no en un
        // `course_enrollments.upsert` posterior desde el cliente (como sí hace el
        // diálogo del Admin, que ahí no tiene alternativa): la cuenta todavía no
        // existe, así que hacerlo aparte parte el alta en dos y deja el caso
        // "usuario creado, matrícula falló" a resolver a mano. Acá el mismo
        // servidor que crea la cuenta ya tiene el catálogo de cursos del docente
        // para resolver los nombres, y no hay una segunda autorización que
        // mantener en sincronía.
        const { data, error } = await supabase.functions.invoke("bulk-import-users", {
          body: {
            rows: [
              {
                full_name: nombre.trim(),
                institutional_email: correo.trim(),
                personal_email: null,
                password: CLAVE_TEMPORAL,
                course_name: seleccion.courseNameField,
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
        const resultado = classifyImportOutcome(fila);
        if (resultado === "error") {
          // El motivo del edge es el que sirve ("el curso no existe", "ya
          // existe este correo"): mostrarlo tal cual, no un genérico. Con varios
          // cursos, uno que no resuelva rechaza la fila COMPLETA, así que no se
          // creó nada y el diálogo queda abierto para corregir.
          toast.error(fila?.reason ?? t("teacherStudents.createError"), { duration: 12000 });
          return;
        }
        if (resultado === "duplicado") {
          // Ya existía y ya estaba en todos los cursos marcados: no hay nada que
          // corregir, así que no es un error, pero tampoco pasó nada → no se
          // recarga la lista ni se cierra.
          // El fallback NO es `createError` ("No pudimos crear la cuenta"):
          // contradice el tono del aviso, porque acá no se intentó crear nada.
          toast.warning(fila?.reason ?? t("teacherStudents.alreadyEnrolled"), {
            duration: 12000,
          });
          return;
        }
        if (resultado === "matriculado-existente") {
          // No se creó cuenta: nombrar la contraseña temporal acá sería falso.
          toast.success(t("teacherStudents.enrolledExistingOk"), { duration: 14000 });
        } else {
          toast.success(
            t("teacherStudents.createOk", {
              count: seleccion.names.length,
              courses: seleccion.names.join(", "),
              password: CLAVE_TEMPORAL,
            }),
            { duration: 14000 },
          );
        }
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
              {/* El conteo va FUERA del Label para que el asterisco de
                  obligatorio quede pegado al nombre del campo y no al número. */}
              <div className="flex items-center gap-1">
                <Label required>{t("teacherStudents.courseLabel")}</Label>
                {seleccion.names.length > 0 && (
                  <span className="text-sm text-muted-foreground tabular-nums">
                    ({seleccion.names.length})
                  </span>
                )}
              </div>
              {/* `showSelectAll` acá y no en el diálogo del Admin: estos son los
                  cursos que el docente DICTA, y dar de alta al alumno de una cohorte
                  que ve todas sus asignaturas es un caso real. Los otros dos pickers
                  multi-curso del docente (difusión y encuestas) ya lo tienen. */}
              <CourseCheckboxList
                courses={courses}
                selectedIds={courseIds}
                onChange={setCourseIds}
                showSelectAll
              />
              {/* Los dos problemas apagan Guardar, así que los dos tienen que decir
                  por qué: un botón apagado sin explicación se lee como que la
                  pantalla está rota. Se nombran TODOS los cursos con separador, no
                  el primero: con dos, renombrar uno dejaba el botón apagado y el
                  mensaje señalando al otro. */}
              {seleccion.problem === "nombre-con-separador" ? (
                <p className="text-2xs text-destructive">
                  {t("teacherStudents.courseSeparatorError", {
                    course: seleccion.namesWithSeparator.join(", "),
                  })}
                </p>
              ) : seleccion.problem === "sin-cursos" && courses.length > 0 ? (
                // Instrucción, no error: el docente todavía no eligió, no se
                // equivocó. El <Select> que esto reemplazó cumplía este rol con su
                // placeholder "Elegí el curso".
                <p className="text-2xs text-muted-foreground">
                  {t("teacherStudents.coursePickAtLeastOne")}
                </p>
              ) : (
                <p className="text-2xs text-muted-foreground">
                  {/* Defensivo: hoy la pantalla apaga el botón "Nuevo estudiante"
                      cuando el docente no dicta ningún curso
                      (app.teacher.students.tsx), así que este diálogo no abre en
                      modo crear con la lista vacía. Cubre un caller futuro. */}
                  {courses.length === 0
                    ? t("teacherStudents.noCoursesHint")
                    : t("teacherStudents.courseHint")}
                </p>
              )}
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
