import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { KeyRound, Eye, EyeOff } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { logEvent } from "@/shared/lib/audit";
import { friendlyError } from "@/shared/lib/db-errors";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  // El form ya no pide "contraseña actual" — Supabase Auth no la requiere
  // para auth.updateUser({password}) sobre la sesión activa. State y
  // toggle de visibilidad de ese input quedaron como código muerto.
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [showNew, setShowNew] = useState(false);
  // Username del usuario actual — se pasa como hidden input para que el
  // browser asocie el cambio de password con la cuenta correcta y ofrezca
  // "Actualizar contraseña guardada" del password manager. Sin esto,
  // Chrome/Safari NO disparan el prompt aunque el form tenga
  // autocomplete="new-password". Es el patrón documentado de
  // https://www.chromium.org/developers/design-documents/create-amazing-password-forms/
  const { profile, user } = useAuth();
  const username = profile?.institutional_email || user?.email || "";

  const reset = () => {
    setNewPassword("");
    setConfirmPassword("");
    setShowNew(false);
  };

  const handleSave = async () => {
    if (!newPassword || !confirmPassword) {
      toast.error("Completa todos los campos");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("La nueva contraseña debe tener al menos 8 caracteres");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Las contraseñas no coinciden");
      return;
    }

    setSaving(true);
    try {
      // Supabase allows the logged-in user to update their own password
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        void logEvent({
          action: "user.password_change_failed",
          category: "user",
          severity: "error",
          metadata: { reason: error.message },
        });
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "user.password_changed",
        category: "user",
        severity: "warning",
        metadata: { self: true },
      });
      toast.success("Contraseña actualizada correctamente");
      reset();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm" hideCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Cambiar contraseña
          </DialogTitle>
        </DialogHeader>
        {/* Envolvemos en <form> semántico para que los password managers
            (Chrome, Safari, 1Password, Bitwarden) detecten el cambio y
            ofrezcan "Actualizar contraseña guardada" tras un submit
            exitoso. Sin <form> + hidden username + autocomplete=new-password,
            el browser NO sabe que esto es un cambio asociado a una cuenta
            guardada y el prompt no aparece. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          className="space-y-3"
        >
          {/* Hidden username — link entre password viejo guardado y nuevo. */}
          <input
            type="text"
            name="username"
            value={username}
            autoComplete="username"
            readOnly
            hidden
            aria-hidden="true"
          />
          <div>
            <Label required>Nueva contraseña</Label>
            <div className="relative mt-1">
              <Input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                className="pr-9"
                autoComplete="new-password"
                name="new-password"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
              >
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div>
            <Label required>Confirmar contraseña</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repite la nueva contraseña"
              className="mt-1"
              autoComplete="new-password"
              name="confirm-password"
            />
            {confirmPassword && newPassword !== confirmPassword && (
              <p className="text-xs text-destructive mt-1">Las contraseñas no coinciden</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={saving || !newPassword || !confirmPassword || newPassword !== confirmPassword}
            >
              {saving && <Spinner size="md" className="mr-1" />}
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
