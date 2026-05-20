import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Cambiar contraseña
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label required>Nueva contraseña</Label>
            <div className="relative mt-1">
              <Input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                className="pr-9"
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
            />
            {confirmPassword && newPassword !== confirmPassword && (
              <p className="text-xs text-destructive mt-1">Las contraseñas no coinciden</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !newPassword || !confirmPassword || newPassword !== confirmPassword}
          >
            {saving && <Spinner size="md" className="mr-1" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
