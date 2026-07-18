# Propuesta comercial — ExamLab como servicio administrado (llave en mano)

**Para:** un responsable/coordinador/rectoría de la institución.
**Qué propone:** que la institución use ExamLab **sin tener que administrarlo** — yo me encargo de la operación y administración de la plataforma por ustedes (setup, usuarios, configuración, soporte, respaldos y actualizaciones). **El valor mensual depende de la cantidad de usuarios.**
**Se apoya en:** demo general + series completas por perfil + presentación (mismos enlaces que los demás correos).

> Variante "administrado" del modelo comercial de [`correo-3-mi-institucion.md`](correo-3-mi-institucion.md): allí la institución se auto-administra; **aquí la administración corre por mi cuenta** como servicio. Precios de referencia — ajústalos a tu política antes de mostrarlos (mantenlos sincronizados con la presentación comercial).

---

## El servicio en 30 segundos

La institución obtiene su **espacio propio en ExamLab** (con su marca), y **yo lo administro de punta a punta**. Los docentes solo enseñan y los estudiantes solo aprenden: **cero carga técnica, cero personal de TI**.

| La institución pone | Yo pongo (servicio administrado) |
|---|---|
| Los datos de docentes y estudiantes (una planilla) | Plataforma + infraestructura + **toda la administración y el soporte** |
| Las decisiones académicas (cursos, cortes, pesos) | La **configuración** de todo eso en la plataforma por ustedes |
| *(Opcional)* su propia API key de IA | Operación diaria, respaldos, actualizaciones y monitoreo |

---

## Qué incluye la administración (lo hago yo, no ustedes)

- **Puesta en marcha:** creación del espacio institucional con su **logo y colores**, estructura académica (programas, asignaturas, periodos) y cursos.
- **Gestión de usuarios:** carga masiva de docentes y estudiantes desde su planilla, altas/bajas, reseteo de contraseñas, **desactivación de usuarios** (los inactivos no cuentan como licencia).
- **Configuración académica:** cortes y pesos de calificación, escalas, certificados con su formato, prompts de IA a la medida de cada curso.
- **Soporte:** canal de soporte para docentes y estudiantes + acompañamiento (resolvemos dudas y problemas de uso).
- **Operación:** respaldos periódicos de la base de datos, actualizaciones de la plataforma y monitoreo — todo transparente para ustedes.
- **Todas las funciones incluidas:** exámenes y talleres con **IA que genera y califica**, detección de copia, proyectos con sustentación, asistencia con QR, encuestas/Reto en vivo, pizarras en vivo, **Tutor del curso** para estudiantes, mensajería, reportes y actas. No hay "funciones premium" recortadas: **todo viene en todos los planes**.

---

## Planes — el valor escala con la cantidad de usuarios

Mismas franjas que la suscripción estándar de ExamLab (por cantidad de usuarios), **más la administración por mi cuenta**. Los usuarios **desactivados no cuentan** para la franja. Todas las funciones incluidas en todos los planes.

| Plan | Estudiantes | Docentes | Mensual | Anual *(2 meses gratis)* | Montaje inicial |
|---|---|---|---|---|---|
| **Esencial administrado** | hasta 250 | hasta 5 | **$249** | **$2.490** | incluido |
| **Profesional administrado** ⭐ | hasta 1.500 | hasta 20 | **$649** | **$6.490** | $200 |
| **Institucional administrado** | hasta 5.000 | hasta 100 | **$1.900** | **$19.000** | $500 |
| **A medida** | +5.000 | ilimitado | **Contáctanos** *(por rango o ~$0,35–$0,50 por estudiante/mes)* | — | cotizado |

*Valores en USD/mes, de referencia — ajustables a tu política. El **anual** paga 10 meses (2 gratis).*

> **De dónde salen los números:** la suscripción estándar de ExamLab (plataforma con **auto-administración**) cuesta **$99 / $299 / $1.000** al mes en esas mismas franjas. Esta propuesta **agrega la administración por mi cuenta**, por eso los valores van por encima — **$249 / $649 / $1.900**. El diferencial (~**$150 / $350 / $900** al mes) cubre el montaje, la gestión de usuarios, la configuración, el soporte y la operación. **IA:** la institución pone su propia API key (sin costo de IA para mí) o se incluye como **add-on** medido por consumo.

## Modelo de IA — ustedes controlan el gasto (Cola de procesamiento)

La IA viene **incluida** (genera y califica exámenes, talleres y proyectos; **Tutor del curso** para estudiantes; **Asistente de la plataforma** para el administrador; detección de copia). Lo importante para el presupuesto: **el costo de la IA lo controlan ustedes**.

- **Su propia API key** (Gemini / OpenAI): la IA corre con su clave → **sin sobrecosto de IA** de mi parte.
- **O como add-on medido por consumo**, si prefieren no gestionar la clave (yo la administro y se factura por uso).
- **Cola de procesamiento IA:** eligen modo **inmediato** (la IA responde al instante) o **en cola** (se procesa por lotes) para controlar **cuándo y cuánto** corre la IA — gasto predecible y sin bloquear la plataforma.
- **Alta disponibilidad:** claves de respaldo con **failover automático** — si una clave agota su cuota, la IA sigue con la siguiente, sin caídas.
- **Costo estimado (con datos reales):** con **Gemini 2.5 Flash** ≈ **US$0,06 por estudiante/mes** (rango 0,05–0,20 según intensidad) → ≈ **$16 / $95 / $315 al mes** para 250 / 1.500 / 5.000 estudiantes. Con su API key, eso lo paga la institución **directo a Google**. Aritmética completa en [`../../costos/modelo-costos-ia-almacenamiento.md`](../../costos/modelo-costos-ia-almacenamiento.md).
- **Almacenamiento y regulación:** el uso real es bajo (~**6,6 MB/curso**; proyección 3–62 GB según plan) → **incluido** en el plan. Para exigencias regulatorias (Habeas Data / residencia de datos) ofrecemos **separación dedicada por institución** (bucket o proyecto propio) como add-on Enterprise.

> En el **demo** la IA se ve en vivo: generación de preguntas/contenido y calificación con retroalimentación.

---

**Condiciones:**
- **Facturación mensual o anual** (anual con descuento). Sin cuota de entrada más allá del onboarding.
- **Onboarding inicial** (carga de usuarios + configuración): incluido en el primer mes / o valor único según tamaño.
- **IA:** la institución puede poner su **propia API key** (sin costo de IA para mí) **o** incluirla en el plan como add-on medido por consumo.
- **Datos de la institución aislados** (multi-institución con separación estricta) y **respaldos** a cargo del servicio.
- Permanencia mínima sugerida: 1 periodo académico (ajustable).

---

## Versión correo

**Asunto:** ExamLab administrado para [Institución] — ustedes enseñan, yo opero la plataforma

> Hola [Nombre]:
>
> Les propongo llevar **ExamLab** a [Institución] como un **servicio llave en mano**: ustedes obtienen la plataforma educativa con IA (genera y califica exámenes y talleres, Tutor del curso para estudiantes, asistencia, reportes, actas…) y **yo me encargo de administrarla por ustedes** — montar el espacio con su marca, cargar docentes y estudiantes, configurar cursos, cortes y certificados, dar soporte y mantener respaldos y actualizaciones. **Cero carga técnica para la institución.**
>
> **El valor mensual depende de la cantidad de usuarios activos** (docentes + estudiantes), y **los usuarios desactivados no cuentan**, así solo pagan por lo que usan. Todas las funciones vienen incluidas en todos los planes.
>
> Para que se hagan una idea completa:
> - 📹 Recorrido general: [Ver el demo general](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/general.mp4)
> - 🛠️ Administrador: [Ver serie completa](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-admin.mp4) · 👩‍🏫 Docente: [Ver serie completa](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-docente.mp4) · 🎓 Estudiante: [Ver serie completa](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-estudiante.mp4)
> - 📊 Presentación general: [Abrir presentación](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/presentacion-general.pptx)
> - 📘 Manual de usuario (PDF): [Descargar](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/manual.pdf)
>
> Si les hace sentido, armamos una reunión corta, les muestro en vivo cómo quedaría el espacio de [Institución] y les paso una **cotización cerrada según su número de usuarios**. 🙌
>
> Un saludo,
> [Tu nombre] · [correo / WhatsApp]

---

## Versión WhatsApp

> Hola [Nombre] 👋 Te propongo **ExamLab administrado** para [Institución]: la plataforma educativa con IA (arma y califica exámenes/talleres, Tutor del curso, asistencia con QR, reportes, actas) y **yo la administro por ustedes** — monto el espacio con su marca, cargo docentes y estudiantes, configuro todo, doy soporte y mantengo respaldos. Cero TI de su lado.
>
> 💰 El valor **depende de la cantidad de usuarios activos** (los desactivados no cuentan). Todas las funciones en todos los planes.
>
> 🎬 Demo y series: 📹 [General](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/general.mp4) · 🛠️ [Admin](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-admin.mp4) · 👩‍🏫 [Docente](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-docente.mp4) · 🎓 [Estudiante](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-estudiante.mp4) · 📊 [Presentación](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/presentacion-general.pptx) · 📘 [Manual](https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/manual.pdf)
>
> ¿Armamos una llamada corta y te paso la cotización según su número de usuarios? 🚀

---

## Notas para ti (borrar antes de enviar)

- **Precios ya concretos** ($249 / $649 / $1.900), calculados como la base de ExamLab ($99/$299/$1.000) **+ el diferencial de administración**. Ajústalos si tu política difiere y mantenlos sincronizados con la presentación comercial administrada (`ExamLab-Presentacion-Comercial-Administrada.pptx`) y con la estándar (`ExamLab-Presentacion-Comercial.pptx`).
- **Reemplaza** `[Institución]`, `[Nombre]`, `[Tu nombre]` y `[correo / WhatsApp]`.
- **IA:** decide si el cliente pone su API key (sin costo de IA para ti) o si la incluyes como add-on medido — impacta el margen.
- **Onboarding:** define si el montaje inicial va incluido o como valor único (según tamaño de la institución).
- **Enlaces ya embebidos** (Supabase Storage / Google Slides); canónicos en [`_ENLACES-demos.md`](_ENLACES-demos.md). Adjunta la **presentación comercial** cuando avances a números.
- Diferencia clave vs. [`correo-3-mi-institucion.md`](correo-3-mi-institucion.md): allí la institución **se auto-administra**; aquí **tú operas** — súbelo como un servicio premium, no como el mismo precio de plataforma sola.
