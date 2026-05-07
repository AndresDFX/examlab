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
import { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";

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
  const scannerRef = useRef<Html5Qrcode | null>(null);
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
            if (cancelled) return;
            const parsed = parsePayload(decodedText);
            if (!parsed) {
              // QR no reconocido — seguir escaneando.
              return;
            }
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
          const message =
            e instanceof Error ? e.message : "No se pudo acceder a la cámara";
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
        <div className="text-sm font-medium">Escanea el QR proyectado</div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4 mr-1" />
          Cerrar
        </Button>
      </div>
      <div className="rounded-lg overflow-hidden border bg-muted relative">
        <div id={SCANNER_ELEMENT_ID} className="w-full" />
        {starting && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground bg-background/60 backdrop-blur-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Activando cámara…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-sm text-destructive bg-background/80 text-center">
            {error}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Apunta el celular al QR proyectado por el docente. Al detectar, te
        marcaremos presente automáticamente.
      </p>
    </div>
  );
}
