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
  /** Texto principal personalizable (admin/curso). Soporta placeholders
   *  {student} {course} {grade} {period} {teacher} {date}. Si está vacío
   *  se usa el cuerpo por defecto. */
  certificateMessage?: string | null;
  signatureName?: string | null;
  signatureTitle?: string | null;
  signatureImageUrl?: string | null;
  footerText?: string | null;
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

  // ── Título — incluye el nombre del curso como subtítulo del header ──
  pdf.setFontSize(32);
  pdf.setTextColor(30, 64, 175);
  pdf.text("CERTIFICADO DE FINALIZACIÓN", W / 2, M + 36, { align: "center" });
  pdf.setFont("helvetica", "italic");
  pdf.setFontSize(16);
  pdf.setTextColor(50, 50, 50);
  pdf.text(data.courseName.toUpperCase(), W / 2, M + 46, { align: "center" });

  // Línea decorativa
  pdf.setDrawColor(30, 64, 175);
  pdf.setLineWidth(0.6);
  pdf.line(W / 2 - 40, M + 50, W / 2 + 40, M + 50);

  // ── Cuerpo: certifica que… ────────────────────────────────────────
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(13);
  pdf.setTextColor(50, 50, 50);
  pdf.text("Se certifica que", W / 2, M + 64, { align: "center" });

  // Nombre del estudiante
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(26);
  pdf.setTextColor(20, 20, 20);
  pdf.text(data.studentFullName, W / 2, M + 80, { align: "center" });

  if (data.studentIdentification) {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Identificación: ${data.studentIdentification}`, W / 2, M + 88, { align: "center" });
  }

  // Cuerpo del enunciado — usa `certificateMessage` si está configurado,
  // sustituyendo placeholders. Si no, usa el texto por defecto.
  const issuedDateStr = formatDateLong(new Date(data.issuedAt));
  const primaryTeacher = data.teacherNames[0] ?? "el docente";
  const renderedMessage =
    data.certificateMessage && data.certificateMessage.trim()
      ? data.certificateMessage
          .replace(/\{student\}/g, data.studentFullName)
          .replace(/\{course\}/g, data.courseName)
          .replace(/\{grade\}/g, Number(data.finalGrade).toFixed(2))
          .replace(/\{period\}/g, data.coursePeriod ?? "")
          .replace(/\{teacher\}/g, primaryTeacher)
          .replace(/\{date\}/g, issuedDateStr)
      : null;

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(13);
  pdf.setTextColor(50, 50, 50);
  if (renderedMessage) {
    // Wrap el mensaje custom a ancho útil para que multi-linea no se salga.
    const wrapped = pdf.splitTextToSize(renderedMessage, W - 2 * M - 30);
    pdf.text(wrapped, W / 2, M + 100, { align: "center" });
  } else {
    const periodSuffix = data.coursePeriod ? ` durante el periodo ${data.coursePeriod}` : "";
    pdf.text(`aprobó satisfactoriamente el curso${periodSuffix}`, W / 2, M + 100, {
      align: "center",
    });
    pdf.setFont("helvetica", "bolditalic");
    pdf.setFontSize(18);
    pdf.setTextColor(30, 64, 175);
    pdf.text(`"${data.courseName}"`, W / 2, M + 112, { align: "center" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(13);
    pdf.setTextColor(50, 50, 50);
    pdf.text(
      `con una calificación final de ${Number(data.finalGrade).toFixed(2)} / ${data.gradeScaleMax}`,
      W / 2,
      M + 122,
      { align: "center" },
    );
  }

  // ── Docente(s) responsables del curso ──────────────────────────────
  if (data.teacherNames.length > 0) {
    pdf.setFontSize(10);
    pdf.setTextColor(100, 116, 139);
    const label = data.teacherNames.length === 1 ? "Docente:" : "Docentes:";
    pdf.text(`${label} ${data.teacherNames.join(", ")}`, W / 2, M + 134, { align: "center" });
  }

  // ── Fecha de generación + periodo (siempre visibles) ───────────────
  pdf.setFontSize(11);
  pdf.setTextColor(50, 50, 50);
  pdf.text(`Generado el ${issuedDateStr}`, M + 18, H - M - 24);
  if (data.coursePeriod) {
    pdf.setFontSize(10);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Periodo: ${data.coursePeriod}`, M + 18, H - M - 18);
  }

  // ── Firma (centro abajo) ────────────────────────────────────────────
  if (data.signatureName || data.signatureImageUrl) {
    const sigCx = W / 2;
    const sigY = H - M - 32;
    if (data.signatureImageUrl) {
      try {
        const sigBytes = await fetchAsDataUrl(data.signatureImageUrl);
        if (sigBytes) {
          pdf.addImage(sigBytes, "PNG", sigCx - 25, sigY - 20, 50, 18, undefined, "FAST");
        }
      } catch {
        /* logo opcional */
      }
    }
    // Línea sobre la firma
    pdf.setDrawColor(80, 80, 80);
    pdf.setLineWidth(0.3);
    pdf.line(sigCx - 35, sigY, sigCx + 35, sigY);
    if (data.signatureName) {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(10);
      pdf.setTextColor(50, 50, 50);
      pdf.text(data.signatureName, sigCx, sigY + 5, { align: "center" });
    }
    if (data.signatureTitle) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(100, 116, 139);
      pdf.text(data.signatureTitle, sigCx, sigY + 10, { align: "center" });
    }
  }

  // ── Pie de página personalizado (opcional) ────────────────────────
  if (data.footerText && data.footerText.trim()) {
    pdf.setFont("helvetica", "italic");
    pdf.setFontSize(8);
    pdf.setTextColor(120, 120, 120);
    const wrapped = pdf.splitTextToSize(data.footerText.trim(), W - 2 * M - 30);
    pdf.text(wrapped, W / 2, H - M - 6, { align: "center" });
  }

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

/** Descarga directa con nombre estándar.
 *  Formato: `Certificado_<curso>_<periodo>_<estudiante>_<YYYY-MM-DD>_<short>.pdf`
 *  El periodo y la fecha facilitan ordenar masivamente cuando el docente
 *  emite/descarga muchos certificados en lote.
 */
export async function downloadCertificate(data: CertificateData): Promise<void> {
  const blob = await buildCertificatePdf(data);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeStudent = data.studentFullName.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
  const safeCourse = data.courseName.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
  const safePeriod = (data.coursePeriod ?? "").replace(/[^a-z0-9]+/gi, "_").slice(0, 20);
  const issuedDate = new Date(data.issuedAt).toISOString().slice(0, 10);
  const periodPart = safePeriod ? `${safePeriod}_` : "";
  a.download = `Certificado_${safeCourse}_${periodPart}${safeStudent}_${issuedDate}_${data.shortCode}.pdf`;
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
