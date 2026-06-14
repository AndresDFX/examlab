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
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      toast.error(t("bulkPassword.minLength"));
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
        toast.error(friendlyError(edgeErr, t("bulkPassword.applyError")));
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = data as { updated?: number; failed?: Array<{ userId: string; error: string }> };
      const updated = res.updated ?? 0;
      const failed = res.failed ?? [];
      if (failed.length > 0) {
        toast.warning(
          t("bulkPassword.partialFailure", {
            updated,
            failed: failed.length,
            error: friendlyError(failed[0].error),
          }),
          { duration: 12000 },
        );
      } else {
        toast.success(t("bulkPassword.successUpdated", { count: updated }));
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
            {t("bulkPassword.title")}
          </DialogTitle>
          <DialogDescription>{t("bulkPassword.desc", { count })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-pwd" required>
              {t("bulkPassword.newPasswordLabel")}
            </Label>
            <div className="flex gap-2">
              <PasswordInput
                id="bulk-pwd"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("bulkPassword.placeholderMin")}
                wrapperClassName="flex-1"
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setPassword(generatePassword())}
                title={t("bulkPassword.generateTitle")}
              >
                <Wand2 className="h-4 w-4 mr-1" />
                {t("bulkPassword.generate")}
              </Button>
            </div>
            {tooShort && <p className="text-xs text-destructive">{t("bulkPassword.minLength")}</p>}
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-1.5">
                {t("bulkPassword.requireChangeLabel")}
                <HelpHint>{t("bulkPassword.requireChangeHelp")}</HelpHint>
              </Label>
              <p className="text-[11px] text-muted-foreground">
                {t("bulkPassword.requireChangeHint")}
              </p>
            </div>
            <Switch checked={requireChange} onCheckedChange={setRequireChange} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleApply()} disabled={saving || password.length < 8}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <KeyRound className="h-4 w-4 mr-1" />
            )}
            {t("bulkPassword.apply", { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
