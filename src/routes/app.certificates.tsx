/**
 * Vista unificada de certificados emitidos para Docente / Admin.
 *
 * RLS de `public.certificates` ya filtra por rol:
 *   - Estudiante: ve los suyos (esa vista vive aparte en app.student.certificates).
 *   - Docente: ve los emitidos en cursos donde es teacher (`course_teachers`).
 *   - Admin: ve todos.
 *
 * Acá NO hay filtro `user_id` — la RLS hace el trabajo. Acciones por
 * fila: descargar PDF, copiar link de verificación, ver pública, y
 * REVOCAR (solo si el cert no está revocado). La RPC
 * `revoke_certificate(_id, _reason)` (mig 20260518140000) chequea
 * autorización (Admin tenant O docente del curso) y notifica al
 * estudiante automáticamente.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SortableHead,
} from "@/components/ui/table";
import { DateCell } from "@/components/ui/date-cell";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Award, Download, Copy, ExternalLink, Ban } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { downloadCertificate, buildVerifyUrl } from "@/modules/certificates/certificate-pdf";
import { friendlyError } from "@/shared/lib/db-errors";
import { usePagination } from "@/hooks/use-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { DataPagination } from "@/components/ui/data-pagination";
import i18n from "@/i18n";

export const Route = createFileRoute("/app/certificates")({ component: CertificatesAdmin });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface CertificateRow {
  id: string;
  short_code: string;
  student_full_name: string;
  student_identification: string | null;
  course_id: string;
  course_name: string;
  course_period: string | null;
  final_grade: number;
  grade_scale_max: number;
  teacher_names: string[];
  university_name: string | null;
  university_logo_url: string | null;
  certificate_message: string | null;
  signature_name: string | null;
  signature_title: string | null;
  signature_image_url: string | null;
  footer_text: string | null;
  issued_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  payload_hash: string;
  user_id: string;
}

function CertificatesAdmin() {
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const activeRole = useActiveRole();
  const confirm = useConfirm();
  const [items, setItems] = useState<CertificateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // SuperAdmin se cuenta como Admin para módulos compartidos — accede
  // con filtro cross-tenant adicional renderizado más abajo.
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");
  const isDocente = roles.includes("Docente");
  // Solo true cuando actúa como SuperAdmin (no por solo tener el rol).
  // Ver comentario en app.admin.users.
  const isSuperAdminCaller = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  // Filtros UI (mismo patrón que otros módulos): selector de curso +
  // search por nombre/email/código + toggle "mostrar revocados".
  const [filterCourseId, setFilterCourseId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [showRevoked, setShowRevoked] = useState(false);
  // SuperAdmin: filtro funcional por institución. Como `certificates`
  // NO tiene tenant_id directo, lo resolvemos en 2 pasos: primero los
  // course_ids del tenant elegido, luego `.in('course_id', ...)` en
  // la query de certificados. Para Admin normal el filtro no se
  // renderiza (RLS ya lo acota a su tenant).
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);

  // Cargar tenants para el Select cuando es SuperAdmin.
  useEffect(() => {
    if (!isSuperAdminCaller) return;
    let cancelled = false;
    void (async () => {
      const { data } = await db
        .from("tenants")
        .select("id, slug, name")
        .is("deleted_at", null)
        .order("name");
      if (cancelled) return;
      setTenants((data ?? []) as Array<{ id: string; slug: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdminCaller]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      // Filtro tenant del SuperAdmin: 2-step query porque certificates
      // no tiene tenant_id propio (vive en el course).
      let courseIdsFilter: string[] | null = null;
      if (isSuperAdminCaller && tenantFilter !== "all") {
        const { data: courseRows } = await db
          .from("courses")
          .select("id")
          .eq("tenant_id", tenantFilter);
        courseIdsFilter = ((courseRows ?? []) as Array<{ id: string }>).map((r) => r.id);
        // Caso edge: el tenant elegido NO tiene cursos. Cortar el query
        // a corto antes de pegarle a certificates (un `.in('course_id', [])`
        // devuelve todos los certificados según PostgREST — peligroso).
        if (courseIdsFilter.length === 0) {
          if (cancelled) return;
          setItems([]);
          setLoading(false);
          return;
        }
      }
      let q = db.from("certificates").select("*").order("issued_at", { ascending: false });
      if (courseIdsFilter) q = q.in("course_id", courseIdsFilter);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) {
        setLoadError(friendlyError(error, t("hc_routesAppCertificates.loadError")));
      } else {
        setItems((data ?? []) as CertificateRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, retryNonce, isSuperAdminCaller, tenantFilter]);

  // Lista derivada (course_id, nombre) para alimentar el selector. Como
  // los certificados ya están filtrados por RLS al alcance del usuario,
  // los cursos disponibles son justo los que tiene certificados emitidos.
  const courseOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of items) {
      if (!map.has(c.course_id)) map.set(c.course_id, c.course_name);
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((c) => {
      if (!showRevoked && c.revoked_at) return false;
      if (filterCourseId && c.course_id !== filterCourseId) return false;
      if (q) {
        const hay = [
          c.student_full_name,
          c.short_code,
          c.course_name,
          c.student_identification ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, filterCourseId, search, showRevoked]);
  const sort = useTableSort(filtered, {
    columns: {
      student: (c) => c.student_full_name,
      course: (c) => c.course_name,
      grade: (c) => Number(c.final_grade),
      issued_at: (c) => c.issued_at,
      short_code: (c) => c.short_code,
    },
    defaultSort: { key: "issued_at", dir: "desc" },
    storageKey: "examlab_sort:certificates",
  });
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:certificates",
    resetKey: `${search}|${filterCourseId}|${showRevoked}|${tenantFilter}|${sort.resetKey}`,
  });

  const handleDownload = async (cert: CertificateRow) => {
    try {
      await downloadCertificate({
        shortCode: cert.short_code,
        studentFullName: cert.student_full_name,
        studentIdentification: cert.student_identification,
        courseName: cert.course_name,
        coursePeriod: cert.course_period,
        finalGrade: Number(cert.final_grade),
        gradeScaleMax: Number(cert.grade_scale_max),
        teacherNames: cert.teacher_names,
        universityName: cert.university_name,
        universityLogoUrl: cert.university_logo_url,
        certificateMessage: cert.certificate_message,
        signatureName: cert.signature_name,
        signatureTitle: cert.signature_title,
        signatureImageUrl: cert.signature_image_url,
        footerText: cert.footer_text,
        issuedAt: cert.issued_at,
        payloadHash: cert.payload_hash,
        revokedAt: cert.revoked_at,
      });
    } catch (e) {
      toast.error(friendlyError(e, t("hc_routesAppCertificates.pdfError")));
    }
  };

  const handleCopyLink = (cert: CertificateRow) => {
    void navigator.clipboard.writeText(buildVerifyUrl(cert.short_code));
    toast.success(i18n.t("toast.routes_app_certificates.verifyLinkCopied", { defaultValue: "Link de verificación copiado" }));
  };

  /**
   * Revoca un certificado emitido. La RPC `revoke_certificate(_id, _reason)`
   * (mig 20260518140000) chequea autorización: Admin del tenant o docente
   * del curso. Setea `revoked_at = now()`, `revoked_by = auth.uid()`,
   * `revoke_reason` + notifica al estudiante. La vista pública de
   * verificación marca el certificado como inválido a partir de ahí.
   */
  const handleRevoke = async (cert: CertificateRow) => {
    const reasonInput = window.prompt(
      i18n.t("toast.routes_app_certificates.revokeReasonPrompt", {
        defaultValue:
          "Motivo de revocación (opcional, se muestra en la página pública):",
      }),
      "",
    );
    // prompt() retorna null si el user cancela; "" si confirma sin texto.
    if (reasonInput === null) return;
    const ok = await confirm({
      tone: "destructive",
      title: i18n.t("toast.routes_app_certificates.revokeTitle", {
        defaultValue: "Revocar certificado",
      }),
      description: i18n.t("toast.routes_app_certificates.revokeDescription", {
        defaultValue:
          "El certificado quedará marcado como NO VÁLIDO en la verificación pública. El estudiante recibirá una notificación. Esta acción no se puede deshacer desde la UI.",
      }),
      confirmLabel: i18n.t("toast.routes_app_certificates.revokeConfirm", {
        defaultValue: "Revocar",
      }),
    });
    if (!ok) return;
    const { error } = await db.rpc("revoke_certificate", {
      _certificate_id: cert.id,
      _reason: reasonInput.trim() || null,
    });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.routes_app_certificates.revokedOk", {
        defaultValue: "Certificado revocado",
      }),
    );
    // Refrescar la lista — bumpear `retryNonce` re-corre el useEffect de load.
    setRetryNonce((n) => n + 1);
  };

  if (!isAdmin && !isDocente) {
    return <p className="text-muted-foreground p-6">{t("hc_routesAppCertificates.needRole")}</p>;
  }

  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        title={t("hc_routesAppCertificates.pageTitle")}
        subtitle={
          isAdmin
            ? t("hc_routesAppCertificates.subtitleAdmin")
            : t("hc_routesAppCertificates.subtitleDocente")
        }
        icon={<Award className="h-6 w-6 text-amber-500" />}
      />

      {/* Filtros: mismo patrón que talleres/proyectos/exámenes. */}
      {!loading && (items.length > 0 || tenantFilter !== "all") && (
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t("hc_routesAppCertificates.searchPlaceholder")}
            className="w-full sm:w-72"
          />
          {/* Filtro de institución (solo SuperAdmin con >1 tenant).
              Funcional: aplica `.in('course_id', courseIdsDelTenant)` a
              la query principal. Mismo patrón que app.admin.users y
              app.admin.courses pero adaptado al schema sin tenant_id
              en certificates (resuelto via cursos del tenant). */}
          {/* Antes gateado a `tenants.length > 1` (escondía el filtro en
              deploys con un solo tenant). Bajado a `> 0` para coincidir
              con Usuarios/Cursos/Errores/Cola — el filtro queda visible
              siempre que el SuperAdmin tenga ≥1 institución. */}
          {isSuperAdminCaller && tenants.length > 0 && (
            <Select value={tenantFilter} onValueChange={setTenantFilter}>
              <SelectTrigger className="w-full sm:w-48 h-9 text-xs">
                <SelectValue placeholder={t("tenant.filterTenantPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("tenant.filterAllTenants")}</SelectItem>
                {tenants.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={filterCourseId || "__all"}
            onValueChange={(v) => setFilterCourseId(v === "__all" ? "" : v)}
          >
            <SelectTrigger className="w-full sm:w-64 h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">{t("hc_routesAppCertificates.allCourses")}</SelectItem>
              {courseOptions.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={showRevoked ? "default" : "outline"}
            size="sm"
            onClick={() => setShowRevoked((v) => !v)}
          >
            {showRevoked
              ? t("hc_routesAppCertificates.hideRevoked")
              : t("hc_routesAppCertificates.showRevoked")}
          </Button>
          {(filterCourseId || search || showRevoked) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilterCourseId("");
                setSearch("");
                setShowRevoked(false);
              }}
            >
              {t("hc_routesAppCertificates.clear")}
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto">
            {filtered.length} / {items.length}
          </span>
        </div>
      )}

      {loading ? (
        <div className="p-4 sm:p-8 flex items-center justify-center text-sm text-muted-foreground">
          <Spinner size="sm" className="mr-2" /> {t("hc_routesAppCertificates.loading")}
        </div>
      ) : loadError ? (
        <ErrorState
          message={t("hc_routesAppCertificates.loadErrorTitle")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : items.length === 0 ? (
        <TableEmpty
          icon={Award}
          title={t("hc_routesAppCertificates.emptyTitle")}
          description={
            isAdmin
              ? t("hc_routesAppCertificates.emptyDescAdmin")
              : t("hc_routesAppCertificates.emptyDescDocente")
          }
        />
      ) : filtered.length === 0 ? (
        <TableEmpty
          icon={Award}
          title={t("hc_routesAppCertificates.noResultsTitle")}
          description={t("hc_routesAppCertificates.noResultsDesc")}
        />
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="student" sort={sort} className="min-w-40">
                    {t("hc_routesAppCertificates.colStudent")}
                  </SortableHead>
                  <SortableHead sortKey="course" sort={sort} className="hidden md:table-cell w-56">
                    {t("hc_routesAppCertificates.colCourse")}
                  </SortableHead>
                  <SortableHead
                    sortKey="grade"
                    sort={sort}
                    className="text-right hidden sm:table-cell w-24"
                  >
                    {t("hc_routesAppCertificates.colGrade")}
                  </SortableHead>
                  <SortableHead sortKey="issued_at" sort={sort} className="hidden sm:table-cell w-28">
                    {t("hc_routesAppCertificates.colIssued")}
                  </SortableHead>
                  <SortableHead
                    sortKey="short_code"
                    sort={sort}
                    className="hidden lg:table-cell w-32"
                  >
                    {t("hc_routesAppCertificates.colCode")}
                  </SortableHead>
                  <TableHead className="text-right w-12">{t("hc_routesAppCertificates.colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableEmpty
                    colSpan={6}
                    icon={Award}
                    title={t("hc_routesAppCertificates.noResultsTitle")}
                    description={t("hc_routesAppCertificates.noResultsDesc")}
                  />
                ) : (
                  pagination.paginatedItems.map((c) => (
                    <TableRow
                      key={c.id}
                      data-state={c.revoked_at ? "selected" : undefined}
                      className={c.revoked_at ? "bg-destructive/5" : undefined}
                    >
                      <TableCell className="font-medium">
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <span className="truncate" title={c.student_full_name}>
                              {c.student_full_name}
                            </span>
                            {c.revoked_at && (
                              <Badge variant="destructive" className="text-[10px]">
                                {t("hc_routesAppCertificates.revokedBadge")}
                              </Badge>
                            )}
                          </div>
                          <div className="md:hidden text-xs text-muted-foreground truncate">
                            {c.course_name}
                            {c.course_period ? ` · ${c.course_period}` : ""}
                          </div>
                          <div className="sm:hidden text-[11px] text-muted-foreground tabular-nums">
                            {Number(c.final_grade).toFixed(2)} / {c.grade_scale_max}
                          </div>
                          {c.revoked_at && c.revoke_reason && (
                            <div className="text-[11px] text-destructive">
                              {t("hc_routesAppCertificates.reasonLabel")} {c.revoke_reason}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden md:table-cell">
                        <div className="truncate" title={c.course_name}>
                          {c.course_name}
                        </div>
                        {c.course_period && (
                          <div className="text-[10px] text-muted-foreground">{c.course_period}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden sm:table-cell">
                        {Number(c.final_grade).toFixed(2)}
                        <span className="text-[10px] text-muted-foreground ml-1">
                          / {c.grade_scale_max}
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <DateCell value={c.issued_at} variant="date" />
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <code className="text-[10px] text-muted-foreground">{c.short_code}</code>
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            {
                              label: t("hc_routesAppCertificates.actionDownloadPdf"),
                              icon: Download,
                              onClick: () => void handleDownload(c),
                            },
                            {
                              label: t("hc_routesAppCertificates.actionCopyVerifyLink"),
                              icon: Copy,
                              onClick: () => handleCopyLink(c),
                            },
                            {
                              label: t("hc_routesAppCertificates.actionOpenPublicVerify"),
                              icon: ExternalLink,
                              href: buildVerifyUrl(c.short_code),
                            },
                            // Revocar: solo si NO está revocado ya.
                            // La RPC chequea autorización del lado server.
                            !c.revoked_at && {
                              label: i18n.t("toast.routes_app_certificates.revokeAction", {
                                defaultValue: "Revocar",
                              }),
                              icon: Ban,
                              tone: "destructive" as const,
                              separatorBefore: true,
                              onClick: () => void handleRevoke(c),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <DataPagination state={pagination} entityNamePlural={t("hc_routesAppCertificates.entityPlural")} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
