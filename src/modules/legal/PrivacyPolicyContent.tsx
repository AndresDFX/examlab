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
 * plataforma) y NO se traduce: traducir un documento legal cambia lo que la
 * institución declara, y eso es una decisión jurídica, no de producto. Solo los
 * rótulos de la interfaz (título, "última actualización", índice) van por i18n.
 *
 * ── Regla al editar este archivo ──────────────────────────────────────────
 * Cada afirmación describe algo que la plataforma HACE, verificado en el
 * código, no una intención. Las que más fácil se vuelven mentira si alguien
 * agrega una función sin volver acá:
 *
 *   · "no se activa la cámara ni el micrófono durante un examen" — hoy es
 *     cierto: el único uso de cámara es el escáner de QR de asistencia
 *     (`AttendanceQRScanner`, `html5-qrcode`), y `getUserMedia` no aparece en
 *     ningún otro lugar de `src/`.
 *   · "no usamos analítica de terceros" — hoy es cierto: no hay gtag,
 *     Analytics, Plausible, PostHog, Mixpanel ni Sentry en el bundle.
 *   · "no recogemos ubicación" — hoy es cierto: `geolocation` no se usa.
 *   · la lista de señales de supervisión sale de `WarningType` en
 *     `src/modules/exams/proctoring.ts` y el tope de `MAX_WARNINGS`.
 *   · los 30 días de la papelera salen de `purge_deleted_items()`.
 *
 * Si agregás cámara en exámenes, telemetría, ubicación o una señal de
 * supervisión nueva, actualizá la sección correspondiente Y
 * `PRIVACY_LAST_UPDATED` en el mismo cambio.
 */
import { useTranslation } from "react-i18next";

/** Fecha de vigencia del documento. Constante (NO `new Date()`) para no
 *  introducir un mismatch de hidratación SSR ni variar entre renders.
 *  Actualizar SIEMPRE que cambie el texto de fondo. */
export const PRIVACY_LAST_UPDATED = "22 de agosto de 2026";

interface Section {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
}

/** `1. Introducción y alcance` → `sec-1`, para el índice y los enlaces
 *  profundos. Se deriva del número que ya abre cada título en vez de agregar
 *  un campo `id` que se puede desincronizar del texto. */
function sectionId(title: string): string {
  return `sec-${title.split(".")[0].trim()}`;
}

export function PrivacyPolicyContent({ showHeader = true }: { showHeader?: boolean }) {
  const { t } = useTranslation();

  const sections: Section[] = [
    {
      title: "1. Introducción y alcance",
      paragraphs: [
        "Esta Política de Privacidad describe cómo se tratan los datos personales de las personas que usan ExamLab —administradores, docentes y estudiantes— dentro de cada institución educativa.",
        "ExamLab es una plataforma de gestión educativa multi-institución: cada institución opera de forma aislada, con su propia comunidad, sus cursos y sus datos.",
        "Se aplica a todo el uso de la plataforma, sea desde el sitio web general o desde la dirección propia de una institución.",
      ],
    },
    {
      title: "2. Quién responde por tus datos",
      paragraphs: [
        "Bajo la Ley 1581 de 2012 y el Decreto 1377 de 2013 de Colombia, la distinción importa porque define a quién le reclamás:",
      ],
      bullets: [
        "Tu institución educativa es la RESPONSABLE del tratamiento: decide qué datos se cargan, con qué finalidad académica, quién accede y por cuánto tiempo se conservan.",
        "ExamLab es el ENCARGADO: trata los datos por cuenta de la institución y siguiendo sus instrucciones, sin usarlos para fines propios.",
        "La autorización para tratar tus datos la recoge y administra tu institución, normalmente al momento de tu matrícula o vinculación.",
      ],
    },
    {
      title: "3. Datos que recopilamos",
      paragraphs: ["Según tu rol y el uso que hagas de la plataforma, podemos tratar:"],
      bullets: [
        "Datos de cuenta: nombre, correo institucional, rol(es) e institución. Opcionalmente un correo personal, si lo registrás para recibir avisos cuando el institucional falla.",
        "Identidad de inicio de sesión: si tu institución usa acceso corporativo (SSO), recibimos de ese proveedor tu identificador y tu correo para vincularlos a tu cuenta. Nunca recibimos tu contraseña corporativa.",
        "Datos académicos: cursos, grupo, matrículas, entregas de exámenes, talleres y proyectos, calificaciones, retroalimentación, sustentaciones y asistencia.",
        "Contenido que creás: archivos, código, diagramas, respuestas, mensajes, participación en foros y encuestas.",
        "Señales de supervisión de evaluaciones: ver la sección 5.",
        "Progreso sobre el material: qué archivos del tablero del curso abriste o descargaste, para poder mostrarte dónde ibas. Registra el hecho de abrirlo, no cuánto lo leíste, y no se usa para calificar.",
        "Datos técnicos: identificador de sesión, preferencias (tema, idioma, ajustes de las listas) y registros de auditoría con fecha, autor y acción.",
      ],
    },
    {
      title: "4. Finalidad del tratamiento",
      paragraphs: [
        "Tratamos los datos únicamente para fines educativos y para operar la plataforma. No los usamos para publicidad, no los vendemos y no los cedemos a terceros con fines comerciales.",
      ],
      bullets: [
        "Gestionar cursos, evaluaciones, entregas y calificaciones.",
        "Registrar y consolidar la asistencia y las notas por corte.",
        "Facilitar la comunicación entre docentes y estudiantes.",
        "Cuidar la integridad académica de las evaluaciones.",
        "Emitir certificados de finalización y permitir que un tercero los verifique.",
        "Mantener la seguridad, diagnosticar incidentes y atender solicitudes de soporte.",
      ],
    },
    {
      title: "5. Supervisión de exámenes e integridad académica",
      paragraphs: [
        "Cuando el docente activa la supervisión de un examen, la plataforma registra señales sobre CÓMO se rindió: salir de pantalla completa, cambiar de pestaña o de ventana, copiar, cortar o pegar, abrir el menú contextual e intentos de captura de pantalla. Al acumular tres advertencias la entrega queda marcada para revisión del docente.",
        "Durante un examen NO se activa la cámara ni el micrófono, y no se graba la pantalla. Las señales anteriores son eventos de la ventana del navegador, no imagen ni sonido.",
        "Para detectar copia, la plataforma también puede comparar entre sí las entregas de una misma actividad y señalarle al docente los pares con coincidencias que el enunciado no explica. Eso implica que tu entrega se procesa junto con la de tus compañeros, con la única finalidad de esa comparación.",
        "Ninguna de estas señales decide por sí sola: son insumos para el docente, que es quien evalúa el caso y toma la decisión académica. Tenés derecho a que se te explique el señalamiento y a controvertirlo por los canales de tu institución.",
      ],
    },
    {
      title: "6. Procesamiento con inteligencia artificial",
      paragraphs: [
        "Algunas funciones usan modelos de inteligencia artificial. Cuando el docente activa la calificación con IA, el contenido de tu entrega se envía a un proveedor de modelos (por ejemplo Google Gemini, OpenAI o Amazon Bedrock, según la configuración vigente) para producir una calificación y una retroalimentación SUGERIDAS. La nota final siempre la define el docente, que puede modificarla.",
        "La misma IA puede estimar qué tan probable es que un texto haya sido generado automáticamente, y ese resultado se le muestra al docente con sus motivos. También es un insumo, no una sanción.",
        "El Tutor del curso responde tus dudas apoyándose en el material que el docente compartió; las conversaciones quedan asociadas a tu cuenta y a ese curso.",
        "Para generar material o preguntas, la plataforma puede enviar al modelo el contenido del curso cargado por el docente.",
        "No usamos datos personales para entrenar modelos, propios ni de terceros.",
      ],
    },
    {
      title: "7. Cámara, notificaciones y permisos del dispositivo",
      paragraphs: [
        "La plataforma solo pide permisos del dispositivo cuando una función concreta los necesita, y siempre podés negarlos:",
      ],
      bullets: [
        "Cámara: únicamente para leer el código QR del registro de asistencia. La imagen se procesa en tu propio dispositivo para extraer el código; no se envía ni se almacena ninguna foto. Si preferís no dar el permiso, podés escribir el código de seis dígitos a mano.",
        "Notificaciones: si las autorizás, guardamos el identificador que tu navegador genera para poder enviarte avisos de la plataforma. Podés revocarlo desde los ajustes del navegador.",
        "Ejecución de código: cuando pulsás «Ejecutar», el código que escribiste se envía a un servicio de ejecución para devolverte la salida. Va el código, no tu identidad.",
        "No recopilamos tu ubicación geográfica, ni usamos analítica de terceros, ni rastreamos tu actividad fuera de la plataforma.",
      ],
    },
    {
      title: "8. Aislamiento entre instituciones",
      paragraphs: [
        "La plataforma separa los datos de cada institución con reglas de seguridad aplicadas en la propia base de datos, no solo en la interfaz: una persona solo alcanza la información de su institución y dentro de lo que su rol permite.",
        "El personal de la plataforma puede acceder a datos de una institución únicamente cuando es necesario para soporte u operación, y esos accesos quedan registrados en la auditoría.",
      ],
    },
    {
      title: "9. Proveedores y transferencia internacional",
      paragraphs: [
        "Para funcionar, ExamLab se apoya en proveedores que tratan datos por nuestra cuenta, bajo obligaciones contractuales de confidencialidad y solo para prestar el servicio: alojamiento del sitio, base de datos, envío de correo, ejecución de código y proveedores de modelos de inteligencia artificial.",
        "Varios de esos proveedores operan su infraestructura fuera de Colombia, principalmente en Estados Unidos, de modo que el uso de la plataforma implica una transferencia internacional de datos. Se realiza para poder prestar el servicio educativo que la institución contrató y está cubierta por la autorización que la institución recoge de los titulares.",
        "No vendemos datos personales ni los compartimos con terceros para sus propios fines.",
      ],
    },
    {
      title: "10. Cookies y almacenamiento local",
      paragraphs: [
        "No usamos cookies de publicidad ni de seguimiento de terceros. Lo que guardamos en tu navegador es lo mínimo para que la plataforma funcione y recuerde cómo la dejaste:",
      ],
      bullets: [
        "Tu sesión iniciada, para no pedirte la contraseña en cada pantalla.",
        "Preferencias de interfaz: tema claro u oscuro, idioma, orden y tamaño de página de las listas.",
        "Si activás «Recordarme», tu correo y la institución elegida, para prellenar el próximo inicio de sesión. La contraseña nunca se guarda: eso queda a cargo del administrador de contraseñas de tu navegador, si decidís usarlo.",
        "Borrar los datos del sitio en tu navegador elimina todo lo anterior sin afectar tu cuenta ni tus notas.",
      ],
    },
    {
      title: "11. Conservación de los datos",
      paragraphs: [
        "Conservamos los datos mientras tu cuenta esté activa y por el tiempo que la institución determine, atendiendo sus obligaciones académicas y de archivo.",
        "Lo que se elimina desde la plataforma pasa primero a una papelera: deja de estar visible y de poder usarse de inmediato, y permanece recuperable durante treinta (30) días antes de su borrado definitivo.",
        "Los registros de auditoría se conservan para trazabilidad y para poder responder reclamos sobre notas o accesos.",
      ],
    },
    {
      title: "12. Datos de niñas, niños y adolescentes",
      paragraphs: [
        "Cuando una persona menor de edad usa la plataforma, el tratamiento se limita a lo estrictamente necesario para su proceso académico y responde al interés superior de la niñez.",
        "La autorización correspondiente la gestiona la institución con quien ejerce la patria potestad o la representación legal. Si detectás que hay datos de un menor tratados sin esa autorización, avisale al administrador de tu institución para que se corrijan o eliminen.",
      ],
    },
    {
      title: "13. Tus derechos y cómo ejercerlos",
      paragraphs: ["Como titular de tus datos personales tenés derecho a:"],
      bullets: [
        "Conocer, actualizar y rectificar tus datos, en especial los que estén incompletos o induzcan a error.",
        "Solicitar prueba de la autorización que dio origen al tratamiento.",
        "Ser informado, cuando lo pidas, sobre el uso que se le ha dado a tus datos.",
        "Presentar quejas ante la Superintendencia de Industria y Comercio por infracciones a la normativa de protección de datos.",
        "Revocar la autorización o solicitar la supresión de tus datos cuando no exista un deber legal o contractual que obligue a conservarlos.",
        "Acceder gratuitamente a tus datos personales.",
      ],
    },
    {
      title: "14. Canales de atención",
      paragraphs: [
        "Como la institución es la responsable del tratamiento, las solicitudes se atienden por su conducto: escribile al administrador de tu institución, que puede gestionarlas dentro de la plataforma.",
        "Si tu solicitud requiere intervención del equipo de la plataforma, el administrador la escala por el módulo de Soporte, que deja constancia del caso y de su respuesta.",
        "Atendemos las consultas y los reclamos en los términos y plazos que fija la normativa colombiana de protección de datos.",
      ],
    },
    {
      title: "15. Seguridad",
      paragraphs: [
        "Aplicamos medidas técnicas y organizativas acordes al riesgo: cifrado de las comunicaciones, control de acceso por roles, aislamiento por institución, cambio obligatorio de la contraseña temporal en el primer ingreso y registros de auditoría de las acciones sensibles.",
        "Ningún sistema es infalible. Si detectamos un incidente que afecte datos personales, informaremos a la institución para que actúe y notifique según corresponda.",
      ],
    },
    {
      title: "16. Cambios a esta política",
      paragraphs: [
        "Podemos actualizar esta política para reflejar cambios en la plataforma o en la normativa aplicable. La versión vigente se publica siempre en esta misma sección, con su fecha de última actualización, para que puedas ver qué cambió y desde cuándo aplica.",
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

      {/* Índice: con 16 secciones, sin él hay que barrer el documento entero
          para encontrar la que interesa (típicamente "mis derechos"). Los
          enlaces son ancla dentro de la misma página, no navegación. */}
      <nav aria-labelledby="privacy-toc" className="mb-8 rounded-md border p-3">
        <h2 id="privacy-toc" className="mb-2 text-sm font-semibold">
          {t("privacy.contents", { defaultValue: "Contenido" })}
        </h2>
        <ol className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {sections.map((s) => (
            <li key={s.title} className="text-sm">
              <a
                href={`#${sectionId(s.title)}`}
                className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="space-y-6">
        {sections.map((s) => (
          <section key={s.title} id={sectionId(s.title)} className="scroll-mt-20">
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
