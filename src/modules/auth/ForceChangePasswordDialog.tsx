/**
 * ForceChangePasswordDialog — diálogo BLOQUEANTE que obliga al usuario a
 * cambiar su contraseña en el primer inicio de sesión.
 *
 * Se monta en AppLayout cuando `profile.must_change_password === true`
 * (el Admin creó/reseteó la cuenta con una contraseña temporal). A
 * diferencia de `ChangePasswordDialog`:
 *   - NO se puede cerrar (sin botón Cancelar, sin X, sin cerrar al click
 *     afuera ni con Escape) — `onOpenChange` no-op + `hideCloseButton`.
 *   - Al guardar, además de `auth.updateUser({password})`, pone
 *     `profiles.must_change_password = false` y refresca el perfil, lo
 *     que desmonta el diálogo y libera la app.
 *   - Ofrece "Cerrar sesión" como única salida alternativa.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { KeyRound, ShieldAlert } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { logEvent } from "@/shared/lib/audit";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

interface Props {
  userId: string;
  /** Refresca el perfil tras el cambio para desmontar el diálogo. */
  onChanged: () => void | Promise<void>;
  /** Cerrar sesión (escape alternativo). */
  onSignOut: () => void;
}

export function ForceChangePasswordDialog({ userId, onChanged, onSignOut }: Props) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  // Username del user actual — necesario para que el password manager
  // asocie el cambio con la cuenta guardada y ofrezca "Actualizar contraseña".
  const { profile, user } = useAuth();
  const username = profile?.institutional_email || user?.email || "";

  const handleSave = async () => {
    if (!newPassword || !confirmPassword) {
      toast.error(i18n.t("toast.modules_auth_ForceChangePasswordDialog.completeBothFields", { defaultValue: "Completa ambos campos." }));
      return;
    }
    if (newPassword.length < 8) {
      toast.error(i18n.t("toast.modules_auth_ForceChangePasswordDialog.passwordTooShort", { defaultValue: "La nueva contraseña debe tener al menos 8 caracteres." }));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(i18n.t("toast.modules_auth_ForceChangePasswordDialog.passwordsDoNotMatch", { defaultValue: "Las contraseñas no coinciden." }));
      return;
    }
    setSaving(true);
    try {
      // 1) Cambiar la contraseña en Auth.
      const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword });
      if (pwErr) {
        void logEvent({
          action: "user.password_change_failed",
          category: "user",
          severity: "error",
          metadata: { reason: pwErr.message, forced: true },
        });
        toast.error(friendlyError(pwErr));
        return;
      }
      // 2) Bajar el flag must_change_password (RLS: el user edita su fila).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: profErr } = await (supabase as any)
        .from("profiles")
        .update({ must_change_password: false })
        .eq("id", userId);
      if (profErr) {
        // La contraseña YA cambió; si esto falla el diálogo reaparecerá.
        // Avisamos pero no bloqueamos — el próximo refresh lo reintenta.
        toast.error(friendlyError(profErr));
        return;
      }
      void logEvent({
        action: "user.password_changed",
        category: "user",
        severity: "warning",
        metadata: { self: true, forced: true },
      });
      toast.success(i18n.t("toast.modules_auth_ForceChangePasswordDialog.passwordUpdated", { defaultValue: "Contraseña actualizada. ¡Bienvenido!" }));
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="max-w-[calc(100vw-2rem)] sm:max-w-sm"
        hideCloseButton
        // Bloqueante: no cerrar al click afuera ni con Escape.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            Cambia tu contraseña
          </DialogTitle>
        </DialogHeader>
        {/* <form> + hidden username + autocomplete=new-password permite
            que el password manager detecte el cambio y ofrezca
            "Actualizar contraseña guardada" al hacer submit. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          className="space-y-3"
        >
          <input
            type="text"
            name="username"
            value={username}
            autoComplete="username"
            readOnly
            hidden
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">
            Por seguridad, debes cambiar la contraseña temporal antes de continuar.
          </p>
          <div>
            <Label required>Nueva contraseña</Label>
            <PasswordInput
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Mínimo 8 caracteres"
              wrapperClassName="mt-1"
              autoFocus
              autoComplete="new-password"
              name="new-password"
            />
          </div>
          <div>
            <Label required>Confirmar contraseña</Label>
            <PasswordInput
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repite la nueva contraseña"
              wrapperClassName="mt-1"
              autoComplete="new-password"
              name="confirm-password"
            />
            {confirmPassword && newPassword !== confirmPassword && (
              <p className="text-xs text-destructive mt-1">Las contraseñas no coinciden.</p>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onSignOut} disabled={saving}>
              Cerrar sesión
            </Button>
            <Button
              type="submit"
              disabled={saving || !newPassword || !confirmPassword || newPassword !== confirmPassword}
            >
              {saving ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <KeyRound className="h-4 w-4 mr-1" />
              )}
              Guardar y continuar
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
