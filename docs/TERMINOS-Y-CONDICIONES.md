# ExamLab — Términos y Condiciones

> Documento de referencia comercial y legal. Redacción en lenguaje claro (es-CO).
> Última actualización: 2026-06-13. Cifras y porcentajes de referencia — ajustar a la
> política comercial vigente y a la legislación aplicable antes de firmar con un cliente o
> aliado. **No constituye asesoría legal**; conviene revisión jurídica antes de publicar.

Estos Términos regulan dos relaciones distintas:

- **Parte A — Suscripción a la plataforma** (instituciones que contratan ExamLab).
- **Parte B — Programa de Aliados** (personas/empresas que refieren o revenden ExamLab).

Definiciones comunes: **"ExamLab"** / **"la Plataforma"** = el servicio educativo en la nube
descrito en este documento y su titular. **"Institución"** / **"Cliente"** = la entidad que
contrata una suscripción. **"Usuario"** = cualquier persona (admin, docente, estudiante) que
accede bajo la Institución. **"Aliado"** = quien participa en el Programa de Aliados.

---

# Parte A — Términos de Suscripción

## A.1 Objeto

ExamLab es una plataforma educativa en la nube (multi-institución) con gestión de cursos,
exámenes, talleres, proyectos, asistencia, mensajería, generación y calificación de
evaluaciones con Inteligencia Artificial, antifraude, certificados y reportes. La suscripción
otorga a la Institución un **derecho de uso no exclusivo, intransferible y revocable** sobre
la Plataforma durante la vigencia del plan contratado.

## A.2 Planes y cupos

Todos los planes incluyen **todas las funcionalidades**; se diferencian por el **número de
usuarios** (cupos por rol). Valores de referencia:

| Plan | Estudiantes | Docentes | Administradores | Valor mensual (ref.) |
|---|---|---|---|---|
| **Esencial** | hasta 250 | hasta 5 | 2 | $99 |
| **Profesional** | hasta 1.500 | hasta 20 | 4 | $299 |
| **Institucional** | hasta 5.000 | hasta 100 | 8 | $1.000 |
| **A la medida** | +5.000 | a convenir | a convenir | Contáctanos |

- Los cupos se controlan por rol (`max_admins`, `max_teachers`, `max_students`). Al alcanzar
  un cupo, no se pueden crear más usuarios de ese rol hasta liberar espacio o ampliar el plan.
- No hay límite en el número de cursos, exámenes, talleres ni proyectos.
- Cambiar de plan (upgrade/downgrade) aplica desde el siguiente ciclo de facturación, salvo
  acuerdo distinto.

## A.3 Inteligencia Artificial

- Las funciones de IA (generación de evaluaciones/contenido, calificación, tutor, antifraude)
  operan con la **clave de API que provee la Institución** (Google Gemini / OpenAI según
  configuración). El **costo de consumo de IA corre por cuenta de la Institución** y no está
  incluido en el valor de la suscripción.
- ExamLab no garantiza la disponibilidad continua de los proveedores de IA de terceros. Si la
  clave expira, se agota la cuota o el proveedor falla, las funciones de IA pueden quedar
  temporalmente indisponibles; el resto de la Plataforma sigue operando.
- La IA es una **herramienta de apoyo**: las calificaciones y contenidos generados deben ser
  **revisados por un docente**. ExamLab no se responsabiliza por decisiones académicas tomadas
  únicamente con base en resultados de IA sin revisión humana.

## A.4 Facturación, vigencia y renovación

- La suscripción se factura por el **ciclo contratado** (mensual, trimestral o anual) y se
  cobra por anticipado sobre el período correspondiente.
- Cada suscripción tiene una **fecha de inicio** y una **fecha de fin**; el estado puede ser:
  *prueba*, *al día*, *por vencer*, *suspendida*, *cancelada* o *vencida*.
- La renovación extiende la fecha de fin por un ciclo. Salvo cancelación previa, la intención
  es la **continuidad del servicio** mediante renovación acordada con el Cliente.
- Los precios de referencia pueden ajustarse; cualquier cambio de precio se comunica con
  antelación razonable y aplica desde la siguiente renovación.

## A.5 Mora, período de gracia y suspensión

- Si la suscripción **vence sin renovar**, la cuenta entra en **período de gracia**
  parametrizable (por defecto 5 días) durante el cual el servicio **sigue activo** y se envían
  avisos de vencimiento.
- Superado el período de gracia, ExamLab puede **suspender** el acceso de los Usuarios de la
  Institución (bloqueo de inicio de sesión). La suspensión **no borra los datos**.
- La **reactivación** es inmediata al regularizar el pago / extender la fecha de fin: los datos
  y la configuración se conservan intactos.
- Los avisos de vencimiento se envían a los administradores de la Institución y al correo de
  facturación registrado, con anticipación (p. ej. 7, 3 y 1 días antes).

## A.6 Cancelación y conservación de datos

- La Institución puede **cancelar** en cualquier momento; el servicio continúa hasta la fecha
  de fin del período ya pagado (no hay reembolso parcial del período en curso, salvo acuerdo).
- Tras la cancelación/expiración, los datos se conservan por un período razonable antes de su
  eliminación definitiva (la Plataforma incluye una **Papelera** con purga a 30 días para
  entidades borradas; los datos de una institución cancelada se conservan para una eventual
  reactivación durante el plazo que se acuerde).
- La Institución puede solicitar la **exportación** de sus datos (calificaciones, reportes)
  antes de la baja definitiva.

## A.7 Datos personales y privacidad

- ExamLab actúa como **encargado del tratamiento** de los datos que la Institución (responsable)
  carga en la Plataforma (datos de docentes y estudiantes). La Institución es responsable de
  contar con la autorización para el tratamiento conforme a la ley aplicable (en Colombia, Ley
  1581 de 2012 y normas concordantes).
- Los datos se usan exclusivamente para prestar el servicio. No se venden a terceros.
- El aislamiento entre instituciones se garantiza a nivel de base de datos (RLS multi-tenant):
  una institución **no** puede ver los datos de otra.
- Las notificaciones son **personales**: cada usuario solo accede a las suyas.

## A.8 Disponibilidad y soporte

- ExamLab se ofrece "tal cual" y "según disponibilidad". Se procura alta disponibilidad pero no
  se garantiza un *uptime* específico salvo que se pacte un SLA por escrito en planes a la medida.
- El soporte está incluido en la suscripción por los canales habilitados (módulo de Soporte/PQRS
  dentro de la plataforma y/o los que se acuerden). Tiempos de respuesta según el plan.
- Mantenimientos programados se notifican con antelación cuando sea posible.

## A.9 Uso aceptable

La Institución y sus Usuarios se comprometen a no: (a) usar la Plataforma para fines ilícitos;
(b) intentar vulnerar la seguridad o el aislamiento entre instituciones; (c) revender el acceso
sin autorización; (d) sobrecargar la infraestructura de forma abusiva; (e) cargar contenido que
infrinja derechos de terceros. El incumplimiento puede derivar en suspensión.

## A.10 Propiedad intelectual

- La Plataforma, su código, marca y diseño son propiedad de ExamLab.
- El **contenido cargado** por la Institución (cursos, materiales, evaluaciones, datos de
  estudiantes) es y sigue siendo **propiedad de la Institución**.

## A.11 Limitación de responsabilidad

En la máxima medida permitida por la ley, ExamLab no responde por daños indirectos, lucro
cesante ni pérdida de datos derivada de causas ajenas a su control (fallas de proveedores de
IA/infraestructura de terceros, fuerza mayor). La responsabilidad total se limita al valor
pagado por la suscripción en los últimos 12 meses.

## A.12 Modificaciones y ley aplicable

ExamLab puede actualizar estos Términos notificando a las Instituciones; el uso continuado
implica aceptación. Se rigen por la legislación colombiana y cualquier controversia se resolverá
ante los jueces competentes del domicilio acordado.

---

# Parte B — Términos del Programa de Aliados

## B.1 Objeto

El Programa de Aliados permite a personas o empresas (**Aliados**) **referir o revender**
ExamLab a instituciones, a cambio de una **comisión**. Asociarse es **gratuito**, sin cuota de
entrada ni metas obligatorias.

## B.2 Modalidades y comisiones

| Modalidad | Qué hace el Aliado | Comisión (referencia) |
|---|---|---|
| **Referido** | Solo presenta al cliente; ExamLab cierra y opera. | **10% del primer año** (pago único). |
| **Aliado Comercial** | Vende y acompaña al cliente en el día a día. | **15% recurrente** mientras el cliente siga activo (incluye renovaciones). |
| **Aliado Premium** | Desde 5 instituciones activas a su nombre. | **20% recurrente** + soporte prioritario y co-branding. |

- La comisión se calcula sobre **lo efectivamente cobrado** al cliente (neto de impuestos y de
  descuentos aplicados), no sobre precios de lista.
- El consumo de IA (clave del cliente) **no** genera comisión (no lo factura ExamLab).
- Los porcentajes son de referencia y se confirman por escrito en el acuerdo de cada Aliado.

## B.3 Registro de oportunidad

- El Aliado **registra** las instituciones que presenta. Una oportunidad registrada queda
  **protegida 90 días**: si se cierra en ese plazo, la comisión es del Aliado que la registró.
- Si dos Aliados registran la misma institución, prevalece el **primer registro válido**.
- Una oportunidad ya cliente de ExamLab (o en negociación directa previa) no es elegible.

## B.4 Pago de comisiones

- Las comisiones se liquidan **mensual o trimestralmente** (según se acuerde) sobre los pagos
  efectivamente **recibidos** de los clientes en el período.
- Las comisiones recurrentes (Comercial/Premium) se pagan **mientras el cliente permanezca
  activo y al día**. Si el cliente se suspende por mora o cancela, la comisión recurrente
  **se pausa o cesa** respectivamente; se reanuda si el cliente reactiva.
- Si un cliente solicita reembolso o hace contracargo, la comisión correspondiente se
  **descuenta** de liquidaciones futuras.
- El Aliado es responsable de sus propios impuestos y de emitir el soporte de cobro que
  corresponda.

## B.5 Obligaciones del Aliado

- Representar ExamLab con honestidad: **no** prometer funciones inexistentes, precios no
  autorizados, ni garantías que ExamLab no ofrece.
- No usar la marca ExamLab fuera de los materiales y lineamientos entregados (sin co-branding
  salvo nivel Premium o autorización escrita).
- No contactar a los clientes de ExamLab de forma que genere confusión sobre quién presta el
  servicio: **ExamLab opera la plataforma**, el Aliado gestiona la relación comercial.
- Cumplir la ley aplicable (protección de datos, publicidad, competencia).

## B.6 Lo que aporta ExamLab al Aliado

- Materiales de venta (presentación del programa, demos en video, manual de usuario).
- **Cuentas de prueba** para mostrar la plataforma.
- Acompañamiento en el cierre cuando el Aliado lo solicite (especialmente Comercial/Premium).
- Soporte prioritario y condiciones por volumen en nivel Premium.

## B.7 Vigencia y terminación

- El acuerdo de Aliado es **a voluntad** de cualquiera de las partes y puede terminarse con
  aviso razonable.
- Tras la terminación, las comisiones **recurrentes ya devengadas** sobre clientes activos se
  respetan según lo pactado en el acuerdo individual (o se liquidan hasta la fecha de
  terminación, según se acuerde). Los registros de oportunidad vencidos no generan derechos.
- ExamLab puede dar de baja a un Aliado que incumpla estos términos (representación engañosa,
  uso indebido de marca, conducta ilegal), sin perjuicio de las comisiones legítimamente
  devengadas.

## B.8 Independencia

El Aliado es un **contratista independiente**. Nada en el Programa crea una relación laboral,
sociedad, *joint venture* ni representación legal entre el Aliado y ExamLab. El Aliado no puede
obligar contractualmente a ExamLab sin autorización escrita.

---

## Anexo — Resumen de parámetros de referencia

- **Período de gracia por defecto:** 5 días (parametrizable por institución, 0–90).
- **Avisos de vencimiento:** 7, 3 y 1 días antes.
- **Purga de Papelera:** 30 días.
- **Protección de oportunidad (Aliados):** 90 días.
- **Comisiones (Aliados):** Referido 10% (1er año, único) · Comercial 15% recurrente ·
  Premium 20% recurrente.
- **Planes (ref.):** Esencial $99 / Profesional $299 / Institucional $1.000 / a la medida +5.000.

> Estos parámetros son los valores por defecto del sistema y de la oferta comercial; cada
> contrato individual prevalece sobre este resumen cuando difiera.
