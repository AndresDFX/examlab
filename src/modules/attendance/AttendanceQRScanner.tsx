/**
 * Escáner de QR de check-in para el estudiante.
 *
 * Usa `html5-qrcode` (~50KB) para acceder a la cámara y detectar QR
 * automáticamente. El callback `onDetected` recibe el payload escaneado.
 *
 * El payload esperado es una URL deep-link:
 *   https://<host>/app/student/attendance?session=<uuid>&code=<6 dígitos>
 * pero también aceptamos un payload "raw" del estilo "session=...&code=..."
 * para tolerar QR antiguos o de pruebas.
 *
 * Ciclo de vida:
 *   - Al abrirse: instancia el scanner y arranca cámara
 *   - Al cerrarse / desmontar: stop + clear (libera la cámara)
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { friendlyError } from "@/shared/lib/db-errors";
import { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

interface Props {
  onDetected: (payload: { sessionId: string; code: string }) => void;
  onClose: () => void;
}

const SCANNER_ELEMENT_ID = "examlab-attendance-qr-scanner";

/** Parsea un payload escaneado. Devuelve null si no se reconoce. */
function parsePayload(text: string): { sessionId: string; code: string } | null {
  try {
    // Si parece URL, intentamos parsearla
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text);
      const session = u.searchParams.get("session");
      const code = u.searchParams.get("code");
      if (session && code) return { sessionId: session, code };
      return null;
    }
    // payload "raw" tipo "session=X&code=Y"
    const params = new URLSearchParams(text);
    const session = params.get("session");
    const code = params.get("code");
    if (session && code) return { sessionId: session, code };
  } catch {
    /* fallthrough */
  }
  return null;
}

export function AttendanceQRScanner({ onDetected, onClose }: Props) {
  const { t } = useTranslation();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  // html5-qrcode invoca el callback de éxito por CADA frame decodificado (fps:10)
  // y scanner.stop() es async: antes de que resuelva puede llegar otro frame con el
  // mismo QR → onDetected/submitCheckIn se dispararía dos veces (doble toast). Este
  // guard garantiza una sola detección.
  const detectedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const scanner = new Html5Qrcode(SCANNER_ELEMENT_ID, /* verbose */ false);
    scannerRef.current = scanner;

    (async () => {
      try {
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: { width: 240, height: 240 },
            aspectRatio: 1.0,
          },
          (decodedText) => {
            if (cancelled || detectedRef.current) return;
            const parsed = parsePayload(decodedText);
            if (!parsed) {
              // QR no reconocido — seguir escaneando.
              return;
            }
            detectedRef.current = true;
            // Stop antes de notificar para evitar múltiples disparos.
            scanner
              .stop()
              .catch(() => {})
              .finally(() => {
                onDetected(parsed);
              });
          },
          () => {
            // onFailure por frame. Silenciar — html5-qrcode dispara mucho.
          },
        );
        if (!cancelled) setStarting(false);
      } catch (e: unknown) {
        if (!cancelled) {
          // El error de cámara / html5-qrcode viene en inglés técnico
          // (NotAllowedError, etc.) → mostramos el mensaje en español.
          const message = friendlyError(
            e,
            t("hc_modulesAttendanceAttendanceQRScanner.cameraAccessError"),
          );
          setError(message);
          setStarting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      if (!s) return;
      Promise.resolve()
        .then(() => (s.getState() === 2 /* SCANNING */ ? s.stop() : null))
        .catch(() => {})
        .then(() => {
          try {
            s.clear();
          } catch {
            /* noop */
          }
        });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {t("hc_modulesAttendanceAttendanceQRScanner.scanProjectedQr")}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4 mr-1" />
          {t("hc_modulesAttendanceAttendanceQRScanner.close")}
        </Button>
      </div>
      <div className="rounded-lg overflow-hidden border bg-muted relative">
        <div id={SCANNER_ELEMENT_ID} className="w-full" />
        {starting && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground bg-background/60 backdrop-blur-sm">
            <Spinner size="md" className="mr-2" />
            {t("hc_modulesAttendanceAttendanceQRScanner.activatingCamera")}
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-sm text-destructive bg-background/80 text-center">
            {error}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("hc_modulesAttendanceAttendanceQRScanner.instructions")}
      </p>
    </div>
  );
}
