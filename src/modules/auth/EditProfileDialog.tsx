/**
 * EditProfileDialog — el usuario edita su perfil personal:
 *  - Nombre completo
 *  - Email institucional (es el que también identifica al usuario en
 *    auth.users.email; un cambio dispara confirmación por correo).
 *  - Email personal (opcional, solo cosmético — no se usa para login).
 *
 * Reglas:
 *  - El UPDATE a profiles lo gobierna la RLS "Users update own profile"
 *    (auth.uid() = id) que ya existe — no requiere SECURITY DEFINER ni
 *    edge function.
 *  - Cuando cambia institutional_email, NO actualizamos auth.users.email
 *    directamente. Llamamos a la edge function `request-email-change`
 *    que genera un token y dispara un correo de confirmación por
 *    NUESTRO SMTP (en lugar del SMTP opaco de Supabase Auth). Hasta que
 *    el usuario clickee el link del correo, auth.users.email sigue
 *    siendo el anterior y profiles.institutional_email NO se cambia.
 *    Esto evita el estado desync que teníamos antes con
 *    `auth.updateUser({email})` (donde el profile se actualizaba pero
 *    el login seguía con el viejo). Ver
 *    [supabase/functions/request-email-change](supabase/functions/request-email-change/index.ts).
 *  - La contraseña sigue viviendo en ChangePasswordDialog aparte — son
 *    dos flujos distintos y combinarlos forza al usuario a re-escribir
 *    la password aun cuando solo edita su nombre.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type Profile } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { UserCog, Mail, AtSign } from "lucide-react";
import { useTranslation } from "react-i18next";
import { friendlyError } from "@/shared/lib/db-errors";

interface EditProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EditProfileDialog({ open, onOpenChange }: EditProfileDialogProps) {
  const { profile, refreshRoles } = useAuth();
  const { t } = useTranslation();
  const [fullName, setFullName] = useState("");
  const [institutional, setInstitutional] = useState("");
  const [personal, setPersonal] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-hidrata el form cada vez que el dialog se abre — útil cuando el
  // usuario cancela y vuelve a abrir; no queremos mostrar valores stale.
  useEffect(() => {
    if (!open || !profile) return;
    setFullName(profile.full_name ?? "");
    setInstitutional(profile.institutional_email ?? "");
    setPersonal(profile.personal_email ?? "");
  }, [open, profile]);

  if (!profile) return null;

  const originalInstitutional = profile.institutional_email ?? "";
  const institutionalChanged =
    institutional.trim().toLowerCase() !== originalInstitutional.trim().toLowerCase();
  const personalValid = !personal.trim() || EMAIL_RE.test(personal.trim());
  const institutionalValid = EMAIL_RE.test(institutional.trim());
  const nameValid = fullName.trim().length >= 2;
  const formValid = nameValid && institutionalValid && personalValid;

  const handleSave = async () => {
    if (!formValid) {
      if (!nameValid) toast.error(t("profile.errorNameTooShort"));
      else if (!institutionalValid) toast.error(t("profile.errorInstitutionalInvalid"));
      else if (!personalValid) toast.error(t("profile.errorPersonalInvalid"));
      return;
    }

    setSaving(true);
    try {
      // 0) Validación PROACTIVA de unicidad de email — antes de tocar DB.
      //    `check_email_taken` mira ambos columnas (institutional +
      //    personal) + auth.users.email, case-insensitive. Excluye al
      //    propio usuario para que no choque consigo mismo. Si el email
      //    ya está en uso, mostramos toast amigable y NO enviamos —
      //    evita el error técnico "duplicate key value violates ...".
      const checkEmail = async (
        email: string,
        kind: "institutional" | "personal",
      ): Promise<boolean> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any).rpc("check_email_taken", {
          p_email: email,
          p_exclude_user_id: profile.id,
        });
        if (error) {
          // RPC no disponible (migración no aplicada) → caemos al
          // comportamiento legacy. DB UNIQUE igual va a atrapar duplicados.
          console.warn("[profile] check_email_taken failed, skipping pre-check:", error.message);
          return false;
        }
        if (data === true) {
          toast.error(
            kind === "institutional"
              ? t("profile.errorInstitutionalTaken")
              : t("profile.errorPersonalTaken"),
          );
          return true;
        }
        return false;
      };
      const inst = institutional.trim().toLowerCase();
      if (inst && (await checkEmail(inst, "institutional"))) return;
      const pers = personal.trim().toLowerCase();
      if (pers && (await checkEmail(pers, "personal"))) return;

      // 1) UPDATE de profiles. NO incluimos institutional_email si
      //    cambió — ese pasa por el flujo custom de confirmación (paso 2).
      //    Hacerlo aquí desync-aría profile vs auth.users hasta que el
      //    usuario clickee el link. Los demás campos sí van.
      const profilePatch: {
        full_name: string;
        personal_email: string | null;
        institutional_email?: string;
      } = {
        full_name: fullName.trim(),
        personal_email: pers ? pers : null,
      };
      if (!institutionalChanged) {
        profilePatch.institutional_email = inst;
      }
      const { error: profErr } = await supabase
        .from("profiles")
        .update(profilePatch)
        .eq("id", profile.id);
      if (profErr) {
        toast.error(friendlyError(profErr));
        return;
      }

      // 2) Si cambió el email institucional, dispara el flujo custom de
      //    confirmación via edge `request-email-change`. La edge genera
      //    un token (1h), guarda en email_change_tokens y manda el
      //    correo por NUESTRO SMTP (no por Supabase Auth). Cuando el
      //    usuario clickee el link, auth.users.email +
      //    profiles.institutional_email se actualizan atómicamente vía
      //    `confirm-email-change` con service_role.
      if (institutionalChanged) {
        const { data, error: reqErr } = await supabase.functions.invoke(
          "request-email-change",
          { body: { newEmail: institutional.trim().toLowerCase() } },
        );
        const respError = (data as { error?: string } | null)?.error;
        if (reqErr || respError) {
          const code = respError ?? reqErr?.message ?? "unknown";
          // Mensajes amigables para los códigos esperados de la edge.
          if (code === "email_already_taken") {
            toast.error(t("profile.errorInstitutionalTaken"));
          } else if (code === "same_as_current_email") {
            // El usuario tipeó el mismo email actual. No deberíamos
            // llegar acá porque `institutionalChanged` ya lo filtra,
            // pero por defensa: no es un error realmente.
            toast.info(
              t("profile.emailSameAsCurrent", {
                defaultValue: "El correo nuevo es igual al actual.",
              }),
            );
          } else if (code === "invalid_email_format") {
            toast.error(t("profile.errorInstitutionalInvalid"));
          } else {
            toast.error(
              t("profile.authEmailError", { defaultValue: "Error solicitando el cambio" }) +
                `: ${code}`,
            );
          }
          return;
        }
        toast.success(
          t("profile.emailChangeRequested", {
            defaultValue: "Solicitud enviada",
          }),
          {
            description: t("profile.emailChangeRequestedHint", {
              defaultValue:
                "Te enviamos un correo a la nueva dirección. Tu correo actual seguirá activo hasta que confirmes el cambio (el enlace es válido 1 hora).",
              email: institutional.trim().toLowerCase(),
            }),
            duration: 10000,
          },
        );
      } else {
        toast.success(t("profile.savedToast"));
      }

      // 3) Refrescar el state de useAuth para que la app vea los datos
      //    nuevos sin recargar (sidebar, header, etc.).
      await refreshRoles();
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    fullName.trim() !== (profile.full_name ?? "").trim() ||
    institutionalChanged ||
    (personal.trim() || "") !== (profile.personal_email ?? "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-primary" />
            {t("profile.title")}
          </DialogTitle>
          <DialogDescription>{t("profile.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label required>{t("profile.fullName")}</Label>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t("profile.fullNamePlaceholder")}
              autoComplete="name"
            />
          </div>

          <div className="space-y-1.5">
            <Label required className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              {t("profile.institutionalEmail")}
            </Label>
            <Input
              type="email"
              value={institutional}
              onChange={(e) => setInstitutional(e.target.value)}
              placeholder="usuario@institucion.edu.co"
              autoComplete="email"
            />
            {institutionalChanged && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {t("profile.institutionalChangeWarning")}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <AtSign className="h-3.5 w-3.5" />
              {t("profile.personalEmail")}
              <span className="text-[10px] text-muted-foreground font-normal">
                ({t("common.optional")})
              </span>
            </Label>
            <Input
              type="email"
              value={personal}
              onChange={(e) => setPersonal(e.target.value)}
              placeholder="personal@email.com"
              autoComplete="email"
            />
            <p className="text-[11px] text-muted-foreground">{t("profile.personalEmailHint")}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving || !formValid || !dirty}>
            {saving && <Spinner size="sm" className="mr-1" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Helper para forzar a TS a tipar `Profile` aunque el state se inicialice
// vacío. No exportado, solo referenciado por claridad de tipos.
export type _ProfileShape = Profile;
