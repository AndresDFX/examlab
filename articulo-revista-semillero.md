# ExamLab: sistematización de una experiencia de transformación digital de la evaluación académica mediante inteligencia artificial

**Autor:** [Tu nombre y apellidos completos]
**Presentación:** [Cargo / programa / breve descripción profesional — por ejemplo: "Docente de programación e ingeniería de software con experiencia en desarrollo full-stack y aplicación de IA en contextos educativos. Líder técnico del proyecto ExamLab."]

---

## Introducción

La evaluación es uno de los procesos académicos más vulnerables a la fricción operativa: corrección manual, retroalimentación tardía, integridad académica vulnerable y poca trazabilidad. La irrupción de modelos de lenguaje y de plataformas de desarrollo asistidas con inteligencia artificial (IA) abre un escenario en el que es posible repensar cómo se diseña, aplica, califica y audita una evaluación. Este artículo sistematiza la experiencia de construcción y despliegue de **ExamLab**, una plataforma educativa multi-tenant para la evaluación de exámenes, talleres y proyectos universitarios. En ExamLab, la IA opera como motor de calificación asistida mientras el docente conserva la decisión final. El propósito es documentar las decisiones de diseño y transformaciones pedagógicas que la herramienta ha introducido en la práctica docente, en consonancia con la invitación de la Revista Semillero 2026 a reflexionar sobre **conocimiento y transformación**.

## Desarrollo

ExamLab nace con tres preguntas guía: ¿cómo reducir el tiempo entre la entrega del estudiante y su retroalimentación?, ¿cómo preservar la integridad académica sin convertir la prueba en una experiencia hostil?, y ¿cómo dar al docente una mirada completa sobre el aprendizaje sin sobrecargarlo de tareas administrativas?

La plataforma articula tres flujos principales: **exámenes** con proctoring suave (detección de cambio de ventana, salida de pantalla completa y control de sesión del examen mediante heartbeat), **talleres** con calificación que admite intentos configurables —con un límite global ajustable por el docente— antes de la calificación final, y **proyectos** con sustentación obligatoria y entrega de código en formato ZIP que la IA descomprime y analiza. Todos los flujos comparten un modelo común de pesos por corte académico, asistencia y nota final, lo que permite consolidar el desempeño del estudiante sin recurrir a cálculos paralelos.

La integración de IA se realiza mediante la API de Google Gemini, expuesta a través de funciones sin servidor. La calificación opera en dos modos: sincrónico, donde el estudiante recibe retroalimentación inmediata, y asincrónico, donde una cola distribuida desacopla el costo de inferencia del momento de la entrega. La detección de fraude combina dos señales independientes: un análisis textual por entrega y una comparación pareada entre estudiantes para detectar similitudes inusuales.

Una decisión metodológica relevante fue **no automatizar por completo**: la IA propone, el docente dispone. Cada nota generada por IA es susceptible de ajuste, cada rechazo queda registrado con justificación, y cada estudiante puede reabrir su entrega mientras no haya sido calificada. Esta disciplina protege la dimensión formativa de la evaluación y evita el sesgo de delegar la decisión final en un sistema opaco.

## Metodología

El desarrollo de ExamLab respondió a un enfoque iterativo de **sistematización ágil continua**. Cada ciclo corto integró tres momentos: (1) **identificación de una necesidad pedagógica** observada en el aula —por ejemplo, "los estudiantes no reciben retroalimentación a tiempo en talleres extensos"—; (2) **diseño técnico y experimentación** sobre un componente acotado de la plataforma; y (3) **validación en uso real** con grupos de estudiantes activos, registrando hallazgos en bitácoras de cambios versionadas.

El proceso utilizó herramientas de desarrollo asistido por IA: **Lovable.dev** para orquestación del despliegue continuo y **Claude Code** para desarrollo guiado por conversación. Esta adopción redujo el ciclo de retroalimentación de semanas a horas, permitiendo que la voz del estudiante y del docente incidiera directamente en la evolución del producto. Las decisiones de arquitectura quedaron registradas en archivos de contexto (`CLAUDE.md`), que funcionan como memoria viva del proyecto y como mecanismo de trazabilidad para futuros colaboradores.

## Conclusión

ExamLab evidencia que la transformación digital de la evaluación no consiste en sustituir al docente por una máquina, sino en **redistribuir la carga cognitiva**: la IA absorbe las tareas mecánicas y repetitivas, mientras el docente se concentra en el acompañamiento, la retroalimentación cualitativa y el diseño didáctico. La experiencia muestra que es viable construir herramientas educativas robustas con equipos pequeños cuando se combina IA generativa con plataformas de servicios en línea modernas (SaaS). El reto pendiente es avanzar hacia métricas que permitan medir, con rigor, el impacto de esta transformación sobre los aprendizajes y sobre la equidad del proceso evaluativo. Esa será la siguiente fase de la sistematización.

## Referencias

García-Peñalvo, F. J. (2021). *Avoiding the dark side of digital transformation in teaching: An institutional reference framework for e-learning in higher education*. Sustainability, 13(4), 2023. https://doi.org/10.3390/su13042023

Selwyn, N. (2022). *Education and technology: Key issues and debates* (3rd ed.). Bloomsbury Academic.

Miao, F., & Holmes, W. (2023). *Guidance for generative AI in education and research*. UNESCO. https://unesdoc.unesco.org/ark:/48223/pf0000386693

Black, P., & Wiliam, D. (2018). *Classroom assessment and pedagogy*. Assessment in Education: Principles, Policy & Practice, 25(6), 551–575. https://doi.org/10.1080/0969594X.2018.1441807

Holmes, W., & Tuomi, I. (2022). *State of the art and practice in AI in education*. European Journal of Education, 57(4), 542–570. https://doi.org/10.1111/ejed.12533
