/**
 * Editor de grupos para un taller (modo teacher_assigned).
 *
 * Lista los estudiantes matriculados (sin asignar) y los grupos creados,
 * permite crear/eliminar grupos y mover estudiantes con checkboxes.
 *
 * Restricción de DB (trigger): un user solo puede estar en UN grupo por
 * taller. La UI fuerza esto del lado cliente moviendo en lugar de
 * permitir asignar a múltiples.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, UserMinus, Loader2, Users } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Student = { id: string; full_name: string; institutional_email: string };
type Group = { id: string; name: string; signup_code: string };
type Member = { group_id: string; user_id: string };

interface Props {
  workshopId: string;
  courseId: string;
}

export function WorkshopGroupsEditor({ workshopId, courseId }: Props) {
  const confirm = useConfirm();
  const [students, setStudents] = useState<Student[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [newGroupName, setNewGroupName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: enr } = await supabase
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", courseId);
      const userIds = (enr ?? []).map((e: { user_id: string }) => e.user_id);
      let profs: Student[] = [];
      if (userIds.length > 0) {
        const { data } = await supabase
          .from("profiles")
          .select("id, full_name, institutional_email")
          .in("id", userIds);
        profs = ((data ?? []) as Student[]).sort((a, b) =>
          a.full_name.localeCompare(b.full_name),
        );
      }
      setStudents(profs);

      const { data: gs } = await db
        .from("workshop_groups")
        .select("id, name, signup_code")
        .eq("workshop_id", workshopId)
        .order("name");
      setGroups((gs ?? []) as Group[]);

      const groupIds = ((gs ?? []) as Group[]).map((g) => g.id);
      if (groupIds.length > 0) {
        const { data: ms } = await db
          .from("workshop_group_members")
          .select("group_id, user_id")
          .in("group_id", groupIds);
        setMembers((ms ?? []) as Member[]);
      } else {
        setMembers([]);
      }
    } finally {
      setLoading(false);
    }
  }, [workshopId, courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const memberByUser = useMemo(() => {
    const m = new Map<string, string>(); // user_id -> group_id
    for (const x of members) m.set(x.user_id, x.group_id);
    return m;
  }, [members]);

  const studentsByGroup = useMemo(() => {
    const m = new Map<string, Student[]>();
    for (const g of groups) m.set(g.id, []);
    for (const s of students) {
      const gid = memberByUser.get(s.id);
      if (gid) m.get(gid)?.push(s);
    }
    return m;
  }, [students, groups, memberByUser]);

  const unassigned = useMemo(
    () => students.filter((s) => !memberByUser.has(s.id)),
    [students, memberByUser],
  );

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) {
      toast.error("Ponle un nombre al grupo");
      return;
    }
    setCreating(true);
    try {
      const { error } = await db
        .from("workshop_groups")
        .insert({ workshop_id: workshopId, name });
      if (error) {
        toast.error(error.message);
        return;
      }
      setNewGroupName("");
      await load();
    } finally {
      setCreating(false);
    }
  };

  const deleteGroup = async (g: Group) => {
    const memberCount = (studentsByGroup.get(g.id) ?? []).length;
    const ok = await confirm({
      title: `Eliminar grupo "${g.name}"`,
      description:
        memberCount > 0
          ? `Tiene ${memberCount} miembro(s). Quedarán sin grupo. La entrega del grupo (si existe) se mantiene pero perderá la asociación. Esta acción no se puede deshacer.`
          : "Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("workshop_groups").delete().eq("id", g.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await load();
  };

  const addToGroup = async (userId: string, groupId: string) => {
    const { error } = await db
      .from("workshop_group_members")
      .insert({ group_id: groupId, user_id: userId });
    if (error) {
      toast.error(error.message);
      return;
    }
    await load();
  };

  const removeFromGroup = async (userId: string, groupId: string) => {
    const { error } = await db
      .from("workshop_group_members")
      .delete()
      .eq("group_id", groupId)
      .eq("user_id", userId);
    if (error) {
      toast.error(error.message);
      return;
    }
    await load();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            Grupos del taller
            <Badge variant="secondary" className="text-[10px]">
              {groups.length}
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Crea grupos y asigna estudiantes. Cada estudiante puede pertenecer a un solo grupo del
            taller. Cuando entreguen, todos los miembros editarán la misma entrega y recibirán la
            misma nota.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Nombre del grupo (ej. Grupo 1)"
              onKeyDown={(e) => e.key === "Enter" && void createGroup()}
              className="flex-1"
            />
            <Button onClick={createGroup} disabled={creating || !newGroupName.trim()}>
              {creating ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-1" />
              )}
              Crear grupo
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Sin asignar */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                Estudiantes sin grupo
                <Badge variant="outline" className="text-[10px]">
                  {unassigned.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {unassigned.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  Todos los estudiantes están en algún grupo.
                </p>
              ) : (
                unassigned.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 rounded border p-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm truncate">{s.full_name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{s.institutional_email}</div>
                    </div>
                    {groups.length > 0 ? (
                      <select
                        className="text-xs border rounded px-1.5 py-1 bg-background"
                        value=""
                        onChange={(e) => {
                          if (e.target.value) void addToGroup(s.id, e.target.value);
                        }}
                      >
                        <option value="" disabled>
                          Asignar a…
                        </option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        Crea un grupo primero
                      </span>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Grupos */}
          <div className="space-y-3">
            {groups.length === 0 && (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground text-center">
                  Sin grupos creados. Empieza creando uno arriba.
                </CardContent>
              </Card>
            )}
            {groups.map((g) => {
              const ms = studentsByGroup.get(g.id) ?? [];
              return (
                <Card key={g.id}>
                  <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-sm flex items-center gap-2">
                      {g.name}
                      <Badge variant="outline" className="text-[10px]">
                        {ms.length} miembro{ms.length === 1 ? "" : "s"}
                      </Badge>
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => deleteGroup(g)}
                      title="Eliminar grupo"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    {ms.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">
                        Sin miembros. Asigna estudiantes desde el panel de la izquierda.
                      </p>
                    ) : (
                      ms.map((s) => (
                        <div
                          key={s.id}
                          className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1.5"
                        >
                          <div className="min-w-0">
                            <div className="text-sm truncate">{s.full_name}</div>
                            <div className="text-[10px] text-muted-foreground truncate">
                              {s.institutional_email}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => removeFromGroup(s.id, g.id)}
                            title="Quitar del grupo"
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
