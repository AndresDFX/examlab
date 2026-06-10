/**
 * BulkPasswordDialog — cambiar la MISMA contraseña a varios estudiantes a la
 * vez (rol Docente / Admin / SuperAdmin). Lo consumen el grid de Usuarios
 * (Admin) y la vista de Estudiantes (Docente) sobre una selección múltiple.
 *
 * El operador elige UNA contraseña (o la genera) y decide si los estudiantes
 * deben cambiarla en su próximo inicio de sesión. Invoca el edge
 * `bulk-set-passwords`, que autoriza por tenant (Admin) o por matrícula en
 * cursos del docente (Docente) — defensa en profundidad server-side.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { PasswordInput } from "@/components/ui/password-input";
import { HelpHint } from "@/components/ui/help-hint";
import { KeyRound, Wand2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ids de los estudiantes seleccionados. */
  userIds: string[];
  /** Se llama tras aplicar con éxito (para limpiar la selección, etc.). */
  onDone?: () => void;
}

/** Contraseña legible pero razonablemente fuerte: 10 chars sin ambiguos. */
function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  const arr = new Uint32Array(10);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 10; i++) out += chars[arr[i] % chars.length];
  return out;
}

export function BulkPasswordDialog({ open, onOpenChange, userIds, onDone }: Props) {
  const [password, setPassword] = useState("");
  const [requireChange, setRequireChange] = useState(true);
  const [saving, setSaving] = useState(false);

  const count = userIds.length;
  const tooShort = password.length > 0 && password.length < 8;

  const reset = () => {
    setPassword("");
    setRequireChange(true);
    setSaving(false);
  };

  const handleApply = async () => {
    if (password.length < 8) {
      toast.error("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (count === 0) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("bulk-set-passwords", {
        body: { userIds, newPassword: password, requireChange },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const edgeErr = error ?? (data as any)?.error;
      if (edgeErr) {
        toast.error(friendlyError(edgeErr, "No se pudo cambiar la contraseña."));
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = data as { updated?: number; failed?: Array<{ userId: string; error: string }> };
      const updated = res.updated ?? 0;
      const failed = res.failed ?? [];
      if (failed.length > 0) {
        toast.warning(
          `${updated} actualizada(s), ${failed.length} con error. Primero: ${friendlyError(
            failed[0].error,
          )}`,
          { duration: 12000 },
        );
      } else {
        toast.success(
          updated === 1
            ? "Contraseña actualizada para 1 estudiante."
            : `Contraseña actualizada para ${updated} estudiantes.`,
        );
      }
      onDone?.();
      onOpenChange(false);
      reset();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Cambiar contraseña en bloque
          </DialogTitle>
          <DialogDescription>
            Se asignará la <strong>misma contraseña</strong> a{" "}
            <strong>
              {count} estudiante{count === 1 ? "" : "s"}
            </strong>{" "}
            seleccionado{count === 1 ? "" : "s"}. Comunícales la contraseña que definas aquí.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-pwd" required>
              Nueva contraseña
            </Label>
            <div className="flex gap-2">
              <PasswordInput
                id="bulk-pwd"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                wrapperClassName="flex-1"
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setPassword(generatePassword())}
                title="Generar una contraseña aleatoria"
              >
                <Wand2 className="h-4 w-4 mr-1" />
                Generar
              </Button>
            </div>
            {tooShort && (
              <p className="text-xs text-destructive">La contraseña debe tener al menos 8 caracteres.</p>
            )}
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-1.5">
                Pedir cambio en el próximo inicio
                <HelpHint>
                  Si está activo, cada estudiante deberá definir su propia contraseña la próxima
                  vez que inicie sesión (recomendado para una contraseña temporal compartida). Si
                  lo desactivas, la contraseña queda definitiva.
                </HelpHint>
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Recomendado cuando repartes una contraseña temporal común.
              </p>
            </div>
            <Switch checked={requireChange} onCheckedChange={setRequireChange} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void handleApply()} disabled={saving || password.length < 8}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <KeyRound className="h-4 w-4 mr-1" />
            )}
            Aplicar a {count} estudiante{count === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
