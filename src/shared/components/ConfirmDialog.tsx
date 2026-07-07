import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/shared/lib/utils";
import { AlertTriangle, Trash2, Info } from "lucide-react";

export type ConfirmTone = "default" | "destructive" | "warning";

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

interface InternalState extends ConfirmOptions {
  open: boolean;
  resolve?: (value: boolean) => void;
}

const ConfirmCtx = createContext<(opts: ConfirmOptions) => Promise<boolean>>(() =>
  Promise.resolve(false),
);

const TONE_ICON = {
  default: Info,
  destructive: Trash2,
  warning: AlertTriangle,
} as const;

const TONE_STYLES: Record<ConfirmTone, { iconWrap: string; iconColor: string; action: string }> = {
  default: {
    iconWrap: "bg-primary/10",
    iconColor: "text-primary",
    action: "",
  },
  destructive: {
    iconWrap: "bg-destructive/10",
    iconColor: "text-destructive",
    action: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  },
  warning: {
    iconWrap: "bg-warning/15",
    iconColor: "text-warning-foreground",
    action: "bg-warning text-warning-foreground hover:bg-warning/90",
  },
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<InternalState>({ open: false, title: "" });

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, open: true, resolve });
    });
  }, []);

  const handleClose = (value: boolean) => {
    state.resolve?.(value);
    setState((prev) => ({ ...prev, open: false }));
  };

  const tone = state.tone ?? "default";
  const Icon = TONE_ICON[tone];
  const styles = TONE_STYLES[tone];

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <AlertDialog
        open={state.open}
        onOpenChange={(o) => {
          if (!o) handleClose(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "h-10 w-10 rounded-full flex items-center justify-center shrink-0",
                  styles.iconWrap,
                )}
              >
                <Icon className={cn("h-5 w-5", styles.iconColor)} />
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <AlertDialogTitle>{state.title}</AlertDialogTitle>
                {state.description && (
                  <AlertDialogDescription>{state.description}</AlertDialogDescription>
                )}
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => handleClose(false)}>
              {state.cancelLabel ?? t("common.cancel", { defaultValue: "Cancelar" })}
            </AlertDialogCancel>
            <AlertDialogAction className={cn(styles.action)} onClick={() => handleClose(true)}>
              {state.confirmLabel ?? t("common.confirm", { defaultValue: "Confirmar" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}
