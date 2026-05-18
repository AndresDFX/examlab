/**
 * Generación del PDF de certificado en el cliente.
 *
 * Usa jspdf (sin servidor) + qrcode (QR como data URL embebido). El
 * binario NO se persiste en Storage — se reconstruye desde el snapshot
 * de la fila `certificates` cada vez que el estudiante descarga.
 *
 * IMPORTANTE: jspdf y qrcode tienen side effects al importarse (acceden
 * a `window`/`document`). Si se importan al top-level, cualquier ruta
 * que importe este módulo se rompe en escenarios SSR/build raros. Por
 * eso los cargamos en lazy import dentro de cada función. La penalidad
 * es despreciable: code-splitting natural y bajo demanda al primer
 * descargar.
 */
import { formatDateLong } from "@/lib/format";

async function loadJsPdf() {
  const mod = await import("jspdf");
  return mod.default;
}

async function loadQrCode() {
  const mod = await import("qrcode");
  return mod.default;
}

export interface CertificateData {
  shortCode: string;
  studentFullName: string;
  studentIdentification?: string | null;
  courseName: string;
  coursePeriod?: string | null;
  finalGrade: number;
  gradeScaleMax: number;
  teacherNames: string[];
  universityName?: string | null;
  universityLogoUrl?: string | null;
  issuedAt: string;
  payloadHash: string;
  revokedAt?: string | null;
}

/** URL pública absoluta a la que apunta el QR. */
export function buildVerifyUrl(shortCode: string, origin?: string): string {
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/verify/${encodeURIComponent(shortCode)}`;
}

/**
 * Construye el PDF en memoria y dispara la descarga.
 * Devuelve el Blob por si se quiere subir o adjuntar a un email.
 */
export async function buildCertificatePdf(data: CertificateData): Promise<Blob> {
  // Lazy load: solo al primer "Descargar PDF". Ver nota en imports.
  const jsPDF = await loadJsPdf();
  const QRCode = await loadQrCode();
  // A4 landscape: 297 x 210 mm
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 18; // margen

  // ── Marco decorativo ───────────────────────────────────────────────
  pdf.setDrawColor(30, 64, 175); // indigo-700
  pdf.setLineWidth(1.2);
  pdf.rect(M, M, W - 2 * M, H - 2 * M);

  pdf.setLineWidth(0.3);
  pdf.rect(M + 3, M + 3, W - 2 * M - 6, H - 2 * M - 6);

  // ── Logo (opcional) ────────────────────────────────────────────────
  if (data.universityLogoUrl) {
    try {
      const logoBytes = await fetchAsDataUrl(data.universityLogoUrl);
      if (logoBytes) {
        // Tamaño moderado en esquina superior izquierda
        pdf.addImage(logoBytes, "PNG", M + 12, M + 12, 26, 26, undefined, "FAST");
      }
    } catch {
      // Si falla el logo (CORS / 404) seguimos sin él. No bloqueamos.
    }
  }

  // ── Nombre de universidad ──────────────────────────────────────────
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(11);
  pdf.setTextColor(100, 116, 139); // slate-500
  if (data.universityName) {
    pdf.text(data.universityName.toUpperCase(), W / 2, M + 18, { align: "center" });
  }

  // ── Título ─────────────────────────────────────────────────────────
  pdf.setFontSize(36);
  pdf.setTextColor(30, 64, 175);
  pdf.text("CERTIFICADO DE FINALIZACIÓN", W / 2, M + 38, { align: "center" });

  // Línea decorativa
  pdf.setDrawColor(30, 64, 175);
  pdf.setLineWidth(0.6);
  pdf.line(W / 2 - 40, M + 42, W / 2 + 40, M + 42);

  // ── Cuerpo: certifica que… ────────────────────────────────────────
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(13);
  pdf.setTextColor(50, 50, 50);
  pdf.text("Se certifica que", W / 2, M + 60, { align: "center" });

  // Nombre del estudiante
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(28);
  pdf.setTextColor(20, 20, 20);
  pdf.text(data.studentFullName, W / 2, M + 76, { align: "center" });

  if (data.studentIdentification) {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Identificación: ${data.studentIdentification}`, W / 2, M + 84, { align: "center" });
  }

  // Cuerpo del enunciado
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(13);
  pdf.setTextColor(50, 50, 50);
  const periodSuffix = data.coursePeriod ? ` durante el periodo ${data.coursePeriod}` : "";
  const body = `aprobó satisfactoriamente el curso${periodSuffix}`;
  pdf.text(body, W / 2, M + 96, { align: "center" });

  // Nombre del curso
  pdf.setFont("helvetica", "bolditalic");
  pdf.setFontSize(20);
  pdf.setTextColor(30, 64, 175);
  pdf.text(`"${data.courseName}"`, W / 2, M + 108, { align: "center" });

  // Nota final
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(13);
  pdf.setTextColor(50, 50, 50);
  pdf.text(
    `con una calificación final de ${Number(data.finalGrade).toFixed(2)} / ${data.gradeScaleMax}`,
    W / 2,
    M + 120,
    { align: "center" },
  );

  // ── Docentes ────────────────────────────────────────────────────────
  if (data.teacherNames.length > 0) {
    pdf.setFontSize(10);
    pdf.setTextColor(100, 116, 139);
    const label = data.teacherNames.length === 1 ? "Docente:" : "Docentes:";
    pdf.text(`${label} ${data.teacherNames.join(", ")}`, W / 2, M + 132, { align: "center" });
  }

  // ── Fecha de emisión ───────────────────────────────────────────────
  pdf.setFontSize(11);
  pdf.setTextColor(50, 50, 50);
  pdf.text(`Emitido el ${formatDateLong(new Date(data.issuedAt))}`, M + 18, H - M - 24);

  // ── Bloque de verificación con QR ──────────────────────────────────
  const verifyUrl = buildVerifyUrl(data.shortCode);
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: "M",
    margin: 0,
    width: 200,
  });

  // QR en esquina inferior derecha
  const qrSize = 32;
  const qrX = W - M - qrSize - 12;
  const qrY = H - M - qrSize - 12;
  pdf.addImage(qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize, undefined, "FAST");

  // Etiquetas debajo del QR
  pdf.setFontSize(8);
  pdf.setTextColor(100, 116, 139);
  pdf.text("Verifica este certificado en:", qrX + qrSize / 2, qrY - 4, { align: "center" });
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(30, 64, 175);
  pdf.text(data.shortCode, qrX + qrSize / 2, qrY + qrSize + 5, { align: "center" });

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7);
  pdf.setTextColor(120, 120, 120);
  pdf.text(verifyUrl, qrX + qrSize / 2, qrY + qrSize + 9, { align: "center" });

  // Hash de verificación (chico, abajo izquierda)
  pdf.setFontSize(6);
  pdf.setTextColor(180, 180, 180);
  pdf.text(`hash: ${data.payloadHash.slice(0, 32)}...`, M + 18, H - M - 14);

  // Si está revocado, marca de agua diagonal
  if (data.revokedAt) {
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(80);
    pdf.setTextColor(220, 38, 38);
    pdf.text("REVOCADO", W / 2, H / 2, { align: "center", angle: 30 });
  }

  return pdf.output("blob");
}

/** Descarga directa con nombre estándar. */
export async function downloadCertificate(data: CertificateData): Promise<void> {
  const blob = await buildCertificatePdf(data);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeStudent = data.studentFullName.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
  const safeCourse = data.courseName.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
  a.download = `Certificado_${safeStudent}_${safeCourse}_${data.shortCode}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Helpers internos ────────────────────────────────────────────────

async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
