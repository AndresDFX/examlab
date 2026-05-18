/**
 * Ruta exclusiva del rol Superadmin: CRUD de tenants.
 *
 * Lista todos los tenants con su status, cuotas y métricas básicas.
 * Permite:
 *   - Crear tenant nuevo (dialog con name + slug + contacto)
 *   - Editar branding y cuotas
 *   - Suspender / reactivar
 *
 * RLS de la tabla `tenants` enforza que solo Superadmin entre acá. La
 * UI también lo valida para mostrar mensaje claro en caso de acceso
 * indebido (en vez de tabla vacía).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty } from "@/components/ui/empty-state";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "sonner";
import { Building2, Plus, Pencil, Pause, Play, ExternalLink, Search } from "lucide-react";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/app/superadmin/tenants")({ component: SuperadminTenants });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "active" | "trial" | "suspended" | string;
  contact_email: string | null;
  max_users: number | null;
  max_courses: number | null;
  max_storage_mb: number | null;
  ai_credits_remaining: number | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_domain: string | null;
  created_at: string;
  updated_at: string;
  suspended_at: string | null;
  suspension_reason: string | null;
}

function SuperadminTenants() {
  const { roles } = useAuth();
  const confirm = useConfirm();
  const isSuper = roles.includes("Superadmin");

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Tenant> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db
      .from("tenants")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    setTenants((data ?? []) as Tenant[]);
    setLoading(false);
  };

  useEffect(() => {
    if (isSuper) void load();
  }, [isSuper]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.slug.toLowerCase().includes(q) ||
        (t.contact_email ?? "").toLowerCase().includes(q),
    );
  }, [tenants, search]);

  // ── Crear / Editar ──────────────────────────────────────────────────
  const openCreate = () => {
    setEditing({
      slug: "",
      name: "",
      status: "active",
      contact_email: "",
      max_users: null,
      max_courses: null,
      max_storage_mb: null,
      ai_credits_remaining: null,
      logo_url: "",
      primary_color: "#1e40af",
      secondary_color: "#64748b",
    });
    setDialogOpen(true);
  };

  const openEdit = (t: Tenant) => {
    setEditing({ ...t });
    setDialogOpen(true);
  };

  const submit = async () => {
    if (!editing) return;
    const name = (editing.name ?? "").trim();
    const slug = (editing.slug ?? "").trim().toLowerCase();
    if (name.length < 2) {
      toast.error("Nombre del tenant requerido (min 2 chars).");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(slug)) {
      toast.error("Slug inválido. Usa minúsculas, dígitos y guiones (2-50 chars).");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        slug,
        name,
        status: editing.status ?? "active",
        contact_email: editing.contact_email ?? null,
        max_users: editing.max_users ?? null,
        max_courses: editing.max_courses ?? null,
        max_storage_mb: editing.max_storage_mb ?? null,
        ai_credits_remaining: editing.ai_credits_remaining ?? null,
        logo_url: editing.logo_url ?? null,
        primary_color: editing.primary_color ?? null,
        secondary_color: editing.secondary_color ?? null,
        custom_domain: editing.custom_domain ?? null,
      };
      if (editing.id) {
        const { error } = await db.from("tenants").update(payload).eq("id", editing.id);
        if (error) {
          toast.error(error.message);
          return;
        }
        toast.success("Tenant actualizado");
      } else {
        const { error } = await db.from("tenants").insert(payload);
        if (error) {
          toast.error(error.message);
          return;
        }
        toast.success("Tenant creado. Configuración default se sembró automáticamente.");
      }
      setDialogOpen(false);
      setEditing(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  // ── Suspender / reactivar ───────────────────────────────────────────
  const toggleSuspend = async (t: Tenant) => {
    const willSuspend = t.status !== "suspended";
    let reason: string | null = null;
    if (willSuspend) {
      const ok = await confirm({
        title: `¿Suspender "${t.name}"?`,
        description:
          "Sus usuarios no podrán loguearse, pero los datos siguen intactos. Puedes reactivar después.",
        confirmLabel: "Suspender",
        tone: "warning",
      });
      if (!ok) return;
      reason = window.prompt("Motivo (opcional)") ?? null;
    } else {
      const ok = await confirm({
        title: `¿Reactivar "${t.name}"?`,
        description: "Los usuarios podrán volver a loguearse.",
        confirmLabel: "Reactivar",
        tone: "default",
      });
      if (!ok) return;
    }
    const { error } = await db
      .from("tenants")
      .update(
        willSuspend
          ? { status: "suspended", suspended_at: new Date().toISOString(), suspension_reason: reason }
          : { status: "active", suspended_at: null, suspension_reason: null },
      )
      .eq("id", t.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(willSuspend ? "Tenant suspendido" : "Tenant reactivado");
    await load();
  };

  if (!isSuper) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Necesitas rol Superadmin.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-5 p-4 sm:p-6">
      <PageHeader
        backTo="/app"
        icon={<Building2 className="h-6 w-6 text-indigo-500" />}
        title="Tenants"
        subtitle="Gestiona instituciones / clientes. Cada tenant tiene sus propios usuarios, cursos, configuración y branding."
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            Nuevo tenant
          </Button>
        }
      />

      <Card>
        <CardContent className="p-4">
          <div className="relative max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre, slug o email…"
              className="pl-8"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground">
              <Spinner size="md" /> Cargando…
            </div>
          ) : filtered.length === 0 ? (
            <TableEmpty
              title={search ? "Sin resultados" : "Aún no hay tenants"}
              description={
                search
                  ? "Ajusta el buscador."
                  : "Crea el primer tenant para empezar a gestionar instituciones."
              }
              icon={Building2}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Cuotas</TableHead>
                  <TableHead>Creado</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-medium text-sm">{t.name}</div>
                      {t.contact_email && (
                        <div className="text-[11px] text-muted-foreground">{t.contact_email}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">{t.slug}</code>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          t.status === "active"
                            ? "text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
                            : t.status === "trial"
                              ? "text-blue-700 dark:text-blue-300 border-blue-500/40 bg-blue-500/10"
                              : "text-destructive border-destructive/40 bg-destructive/10"
                        }
                      >
                        {t.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                      {[
                        t.max_users ? `${t.max_users}u` : null,
                        t.max_courses ? `${t.max_courses}c` : null,
                        t.max_storage_mb ? `${t.max_storage_mb}MB` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "sin límite"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(t.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => openEdit(t)}
                          title="Editar"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => void toggleSuspend(t)}
                          title={t.status === "suspended" ? "Reactivar" : "Suspender"}
                        >
                          {t.status === "suspended" ? (
                            <Play className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                            <Pause className="h-3.5 w-3.5 text-amber-600" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          asChild
                          title="Abrir tenant"
                        >
                          <a
                            href={`${window.location.protocol}//${window.location.host}/?tenant=${t.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialog crear/editar */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Editar tenant" : "Nuevo tenant"}</DialogTitle>
            <DialogDescription>
              {editing?.id
                ? "Modifica branding, cuotas o información de contacto."
                : "Al crear un tenant, se siembra automáticamente la configuración default (correos, compilador, retención, branding)."}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label required>Nombre</Label>
                  <Input
                    value={editing.name ?? ""}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="Ej: Universidad X"
                    maxLength={200}
                  />
                </div>
                <div>
                  <Label required>
                    Slug{" "}
                    <HelpHint>
                      Subdomain / identificador único. Solo minúsculas, dígitos y guiones (2-50).
                    </HelpHint>
                  </Label>
                  <Input
                    value={editing.slug ?? ""}
                    onChange={(e) =>
                      setEditing({ ...editing, slug: e.target.value.toLowerCase() })
                    }
                    placeholder="ej: uni-x"
                    disabled={!!editing.id /* slug inmutable post-creación */}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Email de contacto</Label>
                  <Input
                    type="email"
                    value={editing.contact_email ?? ""}
                    onChange={(e) => setEditing({ ...editing, contact_email: e.target.value })}
                    placeholder="admin@uni-x.edu.co"
                  />
                </div>
                <div>
                  <Label>Status</Label>
                  <Select
                    value={editing.status ?? "active"}
                    onValueChange={(v) => setEditing({ ...editing, status: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Activo</SelectItem>
                      <SelectItem value="trial">Trial</SelectItem>
                      <SelectItem value="suspended">Suspendido</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="rounded border p-3 space-y-2">
                <h4 className="text-sm font-semibold">Cuotas (NULL = sin límite)</h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <Label className="text-[11px]">Usuarios máx</Label>
                    <Input
                      type="number"
                      min={1}
                      value={editing.max_users ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          max_users: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">Cursos máx</Label>
                    <Input
                      type="number"
                      min={1}
                      value={editing.max_courses ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          max_courses: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">Storage (MB)</Label>
                    <Input
                      type="number"
                      min={1}
                      value={editing.max_storage_mb ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          max_storage_mb: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">Créditos IA</Label>
                    <Input
                      type="number"
                      min={0}
                      value={editing.ai_credits_remaining ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          ai_credits_remaining:
                            e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="rounded border p-3 space-y-2">
                <h4 className="text-sm font-semibold">Branding</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="sm:col-span-3">
                    <Label className="text-[11px]">Logo URL</Label>
                    <Input
                      value={editing.logo_url ?? ""}
                      onChange={(e) => setEditing({ ...editing, logo_url: e.target.value })}
                      placeholder="https://…/logo.png"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">Color primario</Label>
                    <Input
                      type="color"
                      value={editing.primary_color ?? "#1e40af"}
                      onChange={(e) => setEditing({ ...editing, primary_color: e.target.value })}
                      className="h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">Color secundario</Label>
                    <Input
                      type="color"
                      value={editing.secondary_color ?? "#64748b"}
                      onChange={(e) => setEditing({ ...editing, secondary_color: e.target.value })}
                      className="h-9"
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <Label className="text-[11px]">Dominio personalizado (opcional)</Label>
                    <Input
                      value={editing.custom_domain ?? ""}
                      onChange={(e) => setEditing({ ...editing, custom_domain: e.target.value })}
                      placeholder="uni-x.edu.co"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? <Spinner size="sm" className="mr-1" /> : null}
              {editing?.id ? "Guardar cambios" : "Crear tenant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
