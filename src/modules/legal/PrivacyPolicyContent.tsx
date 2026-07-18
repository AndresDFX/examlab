/**
 * Contenido de la Política de Privacidad de ExamLab.
 *
 * Componente PRESENTACIONAL y reutilizable, montado por:
 *   - `/privacy`        → página pública (pre-login, footer del landing/auth).
 *   - `/app/privacy`    → in-app, accesible a TODOS los roles (la regla
 *                          fallback `{ prefix: "/app", roles: null }` de rbac.ts
 *                          ya lo permite sin regla específica).
 *
 * El texto es un documento legal en español (es-CO, idioma primario de la
 * plataforma). Los encabezados van por i18n con defaultValue para que sean
 * traducibles a futuro sin romper la paridad es/en (no se agregan claves al
 * JSON salvo `nav.privacy`, usada por los enlaces de acceso).
 */
import { useTranslation } from "react-i18next";

/** Fecha de vigencia del documento. Constante (NO `new Date()`) para no
 *  introducir un mismatch de hidratación SSR ni variar entre renders. */
export const PRIVACY_LAST_UPDATED = "11 de junio de 2026";

interface Section {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
}

export function PrivacyPolicyContent({ showHeader = true }: { showHeader?: boolean }) {
  const { t } = useTranslation();

  const sections: Section[] = [
    {
      title: "1. Introducción y alcance",
      paragraphs: [
        "Esta Política de Privacidad describe cómo ExamLab trata los datos personales de las personas que usan la plataforma —administradores, docentes y estudiantes— dentro de cada institución educativa.",
        "ExamLab es una plataforma de gestión educativa multi-institución: cada institución (tenant) opera de forma aislada y es responsable de los datos de su comunidad. ExamLab actúa como encargado del tratamiento, procesando los datos por cuenta y según las instrucciones de la institución.",
      ],
    },
    {
      title: "2. Datos que recopilamos",
      paragraphs: ["Según el rol y el uso, podemos tratar las siguientes categorías de datos:"],
      bullets: [
        "Datos de cuenta: nombre, correo institucional, rol(es) e institución a la que pertenece.",
        "Datos académicos: cursos, matrículas, entregas de exámenes, talleres y proyectos, calificaciones, retroalimentación y asistencia.",
        "Datos de supervisión de evaluaciones: eventos registrados durante un examen (salidas de pantalla completa, cambios de ventana, advertencias) cuando el docente activa la supervisión.",
        "Contenido generado: archivos, código, diagramas y mensajes que la persona sube o escribe en la plataforma.",
        "Datos técnicos: identificador de sesión, preferencias (tema, idioma) y registros de actividad (auditoría) con fecha, autor y acción.",
      ],
    },
    {
      title: "3. Finalidad del tratamiento",
      paragraphs: ["Tratamos los datos únicamente para fines educativos y de operación de la plataforma:"],
      bullets: [
        "Gestionar cursos, evaluaciones, entregas y calificaciones.",
        "Registrar y consolidar la asistencia y las notas por corte.",
        "Facilitar la comunicación entre docentes y estudiantes.",
        "Garantizar la integridad académica de las evaluaciones.",
        "Emitir certificados de finalización y permitir su verificación.",
        "Mantener la seguridad, diagnosticar incidentes y atender solicitudes de soporte.",
      ],
    },
    {
      title: "4. Procesamiento con inteligencia artificial",
      paragraphs: [
        "Algunas funciones usan modelos de inteligencia artificial. Cuando un docente activa la calificación con IA, el contenido de la entrega se envía a un proveedor de modelos (por ejemplo, Google Gemini u OpenAI) para producir una calificación y retroalimentación sugeridas; la decisión final siempre queda en manos del docente.",
        "El Tutor del curso responde dudas del estudiante apoyándose en el material del curso compartido por el docente. Las conversaciones se asocian a la cuenta del estudiante y a su curso.",
        "No usamos los datos personales para entrenar modelos propios ni de terceros.",
      ],
    },
    {
      title: "5. Aislamiento entre instituciones",
      paragraphs: [
        "La plataforma separa estrictamente los datos de cada institución. Las reglas de seguridad a nivel de base de datos garantizan que una persona solo accede a la información de su propia institución y según su rol. El personal de la plataforma accede a datos de una institución únicamente cuando es necesario para soporte u operación.",
      ],
    },
    {
      title: "6. Conservación de los datos",
      paragraphs: [
        "Conservamos los datos mientras la cuenta esté activa y según lo requiera la institución. Las entidades eliminadas pasan a una papelera y permanecen recuperables durante treinta (30) días antes de su borrado definitivo.",
        "Los registros de auditoría se conservan por el período definido por la institución para fines de trazabilidad y atención de reclamos.",
      ],
    },
    {
      title: "7. Proveedores y terceros",
      paragraphs: [
        "Para operar, ExamLab se apoya en proveedores de infraestructura y servicios (alojamiento y base de datos, envío de correo, ejecución de código y proveedores de modelos de IA). Estos proveedores tratan los datos solo para prestar el servicio contratado y bajo obligaciones de confidencialidad. No vendemos datos personales.",
      ],
    },
    {
      title: "8. Cookies y almacenamiento local",
      paragraphs: [
        "Usamos almacenamiento local del navegador para mantener la sesión iniciada y recordar preferencias (tema claro/oscuro, idioma, ajustes de la interfaz). No usamos cookies de publicidad ni de seguimiento de terceros.",
      ],
    },
    {
      title: "9. Derechos de los titulares",
      paragraphs: [
        "Las personas pueden solicitar acceder, actualizar o eliminar sus datos personales. Como la institución es la responsable del tratamiento, estas solicitudes se canalizan a través del administrador de la institución, quien las gestiona dentro de la plataforma.",
      ],
    },
    {
      title: "10. Seguridad",
      paragraphs: [
        "Aplicamos medidas técnicas y organizativas para proteger los datos: cifrado en tránsito, control de acceso por roles, aislamiento por institución y registros de auditoría. Ningún sistema es completamente infalible, pero trabajamos para mantener un nivel de protección adecuado al riesgo.",
      ],
    },
    {
      title: "11. Cambios a esta política",
      paragraphs: [
        "Podemos actualizar esta Política de Privacidad para reflejar cambios en la plataforma o en la normativa aplicable. Publicaremos la versión vigente en esta misma sección, indicando la fecha de última actualización.",
      ],
    },
    {
      title: "12. Contacto",
      paragraphs: [
        "Para ejercer tus derechos o resolver dudas sobre esta política, comunícate con el administrador de tu institución a través de los canales internos de la plataforma.",
      ],
    },
  ];

  return (
    <article className="mx-auto w-full max-w-3xl">
      {showHeader ? (
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {t("privacy.title", { defaultValue: "Política de Privacidad" })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("privacy.lastUpdated", {
              defaultValue: "Última actualización: {{date}}",
              date: PRIVACY_LAST_UPDATED,
            })}
          </p>
        </header>
      ) : (
        <p className="mb-6 text-sm text-muted-foreground">
          {t("privacy.lastUpdated", {
            defaultValue: "Última actualización: {{date}}",
            date: PRIVACY_LAST_UPDATED,
          })}
        </p>
      )}

      <div className="space-y-6">
        {sections.map((s) => (
          <section key={s.title}>
            <h2 className="mb-2 text-lg font-semibold">{s.title}</h2>
            {s.paragraphs?.map((p, i) => (
              <p key={i} className="mb-2 text-sm leading-relaxed text-muted-foreground">
                {p}
              </p>
            ))}
            {s.bullets && (
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
                {s.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </article>
  );
}
