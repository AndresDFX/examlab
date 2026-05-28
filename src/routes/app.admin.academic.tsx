/**
 * Módulo Académico (Admin).
 *
 * Gestión de la estructura académica de la institución, separada de la
 * tab "Institución" de Configuración para darle visibilidad propia en el
 * sidebar (es la pieza que el Admin toca al armar la oferta del periodo).
 *
 * Jerarquía: Carrera/Programa → Asignatura → Curso (versión puntual en un
 * periodo). Aquí se administran los tres primeros niveles; el Curso se
 * crea en /app/admin/courses y se asocia a una asignatura existente.
 *
 * Tabs:
 *   - Resumen:     vista integral programa → asignaturas → cursos.
 *   - Carreras:    programas/niveles (ej. "Ingeniería de Sistemas").
 *   - Asignaturas: materias asociadas a una carrera (ej. "Programación II").
 *   - Periodos:    periodos académicos (ej. "2026-1").
 *
 * El branding y los certificados siguen en Configuración → Institución;
 * acá vive solo lo estrictamente académico.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride } from "@/modules/tenants/use-tenant";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { GraduationCap, Layers, BookMarked, CalendarRange, LayoutList } from "lucide-react";
import { AdminAcademicProgramsPanel } from "@/modules/admin/AdminAcademicProgramsPanel";
import { AdminAcademicPeriodsPanel } from "@/modules/admin/AdminAcademicPeriodsPanel";
import { AdminAcademicSubjectsPanel } from "@/modules/admin/AdminAcademicSubjectsPanel";
import { AdminProgramOverviewPanel } from "@/modules/admin/AdminProgramOverviewPanel";

export const Route = createFileRoute("/app/admin/academic")({ component: AdminAcademic });

function AdminAcademic() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");
  // SuperAdmin cross-tenant: la estructura académica pertenece a UNA
  // institución. Sin un tenant elegido vía "Ver como X", redirige a
  // Instituciones (mismo patrón que Configuración).
  const isSuperAdminCrossTenant =
    roles.includes("SuperAdmin") && activeRole === "SuperAdmin" && readTenantOverride() === null;

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  if (isSuperAdminCrossTenant) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<GraduationCap className="h-6 w-6 text-indigo-500" />}
          title="Académico"
          subtitle="Estructura académica por institución."
        />
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-sm font-medium">{t("superAdmin.crossTenantTitle")}</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              {t("superAdmin.crossTenantSettingsHint")}
            </p>
            <Link
              to="/app/superadmin/tenants"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("superAdmin.goToTenants")}
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<GraduationCap className="h-6 w-6 text-indigo-500" />}
        title="Académico"
        subtitle="Carreras, asignaturas y periodos de tu institución."
      />

      <Tabs defaultValue="overview">
        <TabsList className="flex flex-wrap h-auto justify-start gap-1">
          <TabsTrigger value="overview" className="gap-1.5">
            <LayoutList className="h-3.5 w-3.5" />
            Resumen
          </TabsTrigger>
          <TabsTrigger value="programs" className="gap-1.5">
            <Layers className="h-3.5 w-3.5" />
            Carreras
          </TabsTrigger>
          <TabsTrigger value="subjects" className="gap-1.5">
            <BookMarked className="h-3.5 w-3.5" />
            Asignaturas
          </TabsTrigger>
          <TabsTrigger value="periods" className="gap-1.5">
            <CalendarRange className="h-3.5 w-3.5" />
            Periodos
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-4 mt-4">
          <AdminProgramOverviewPanel />
        </TabsContent>
        <TabsContent value="programs" className="space-y-4 mt-4">
          <AdminAcademicProgramsPanel />
        </TabsContent>
        <TabsContent value="subjects" className="space-y-4 mt-4">
          <AdminAcademicSubjectsPanel />
        </TabsContent>
        <TabsContent value="periods" className="space-y-4 mt-4">
          <AdminAcademicPeriodsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
