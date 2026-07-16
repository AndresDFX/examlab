# Add-ons — catálogo detallado con costo y margen

> Los add-ons se venden a la carta sobre cualquier plan (excepto casos marcados).
> Precios y márgenes calculados con costos actualizados 2026-07.

## 1. IA administrada (sin BYO API key)

**Qué desbloquea**: la universidad NO configura su propia API key de Gemini. ExamLab gestiona el consumo con su propia clave y lo pasa como costo variable.

**Racional**: algunas instituciones no tienen equipo técnico para gestionar Google Cloud + billing, o no quieren la fricción. Prefieren "todo incluido".

### Pricing

| Métrica | Valor |
|---|---|
| Precio de venta | **$0.10/matrícula activa/mes** |
| Costo real (Gemini Flash, uso típico) | ~$0.062/matrícula/mes |
| Costo real (Gemini Flash, uso intensivo) | ~$0.20/matrícula/mes |
| **Margen típico** | **~$0.038/matrícula/mes = 38%** |
| **Margen intensivo** | **-$0.10/matrícula/mes** (pérdida) |

### Protección de margen

- Establecer **tope duro**: 30 mensajes de Tutor IA por matrícula/mes + 6 calificaciones. Al superar el tope, se corta la IA (in-app) hasta el siguiente mes.
- Alternativa: cobrar overage al cliente ($0.15/matrícula extra sobre el tope).
- Documentar el tope en el contrato con anexo técnico.

### Aplicable a

Todos los planes. Recomendado como default para clientes sin equipo técnico.

## 2. Storage extra (>50 GB por tenant)

**Qué desbloquea**: subida de material pesado al Storage de Supabase (videos, PDFs grandes, ZIPs de proyectos con dependencias).

**Racional**: Supabase Pro incluye 100 GB TOTALES. Se distribuye entre todos los tenants según su cap contractual:
- Pequeña: 50 GB soft cap
- Mediana: 100 GB soft cap
- Grande: 200 GB soft cap

Al superar el cap, add-on obligatorio.

### Pricing

| Métrica | Valor |
|---|---|
| Precio de venta | **$10 por 100 GB/mes adicionales** |
| Costo real Supabase | $2.13/100 GB ($0.0213/GB × 100) |
| **Margen** | **$7.87/100 GB = 79%** |

### Consideraciones

- **Preferir siempre** grabaciones de clase como URL externa (YouTube unlisted, Vimeo, Cloudflare Stream). El add-on es para material propietario donde no puedan externalizar.
- Alertas automáticas al superar el 80% del cap: email al Admin + banner en el UI.

## 3. Code runner ilimitado (Java/Python en exámenes)

**Qué desbloquea**: ejecución server-side (AWS Lambda) de código Java/Python en exámenes y talleres, sin depender del navegador del alumno. Habilita GUI con Xvfb (JavaGUI/PythonGUI), Python con tkinter.

**Racional**: en planes Pequeña/Mediana el uso ligero está incluido por AWS free tier (1M requests + 400k GB-s/mes). Para facultades de ingeniería con exámenes semanales de programación, se requiere garantía de disponibilidad + posible overage AWS.

### Pricing

| Métrica | Valor |
|---|---|
| Precio de venta | **$49/mes** |
| Costo real AWS Lambda (estimado con 20k execs/mes) | ~$5/mes |
| **Margen** | **$44/mes = 90%** |

### Aplicable a

Mediana o superior. En Pequeña la ejecución básica está incluida (CheerpJ client-side + fallback Lambda dentro del free tier).

## 4. Aislamiento dedicado (proyecto Supabase por tenant)

**Qué desbloquea**: DB + storage + backups físicamente separados en un proyecto Supabase dedicado por institución. Opcionalmente en **región específica** (data residency Colombia, USA, EU).

**Racional**: exigencia legal (Ley 1581/2012 Habeas Data en Colombia, GDPR en EU) o contractual. Reduce blast radius de bugs cross-tenant.

### Pricing

| Métrica | Valor |
|---|---|
| Precio de venta | **$99/mes** |
| Costo real | $25/mes (Supabase Pro adicional) + $50/mes de operación (deploy separado, migraciones, monitoreo) |
| **Margen** | **~$24/mes = 24%** |

### Consideraciones técnicas

Requiere trabajo de deployment:
- Aplicar todas las migraciones al proyecto nuevo.
- Configurar CI/CD para deploy sincronizado con el proyecto principal.
- Copiar seed data (roles, plantillas de certificado).
- Migrar datos existentes si el cliente ya tenía tenant en el proyecto compartido.

Estimar setup: **8-16h de tech senior por primera vez** por cliente. Después es incremental.

### Aplicable a

Grande o Enterprise. NO ofrecer en Pequeña/Mediana (margen no justifica la complejidad operativa a esa escala).

## 5. SSO/SAML (integración con directorio institucional)

**Qué desbloquea**: los usuarios se loguean con las credenciales corporativas de la universidad (Azure AD, Google Workspace, Okta, ADFS). Sin gestionar contraseñas separadas.

**Racional**: requisito de universidades medianas/grandes por política de seguridad. También reduce fricción de onboarding.

### Pricing

| Métrica | Valor |
|---|---|
| Setup one-time | **$99** (configuración inicial) |
| Cargo recurrente | **$29/mes** |
| Costo real Supabase | $0 marginal (feature ya soportado en Pro) |
| Costo real ExamLab (setup) | ~2h de tech senior = $50 |
| **Margen setup** | **$49 = 50%** |
| **Margen recurrente** | **$29 = 100%** |

### Consideraciones

- Supabase Auth soporta SAML nativamente en Pro.
- Setup: configurar el IdP del cliente + testing + docs.
- Ofrecer también OAuth (Google Workspace, Microsoft 365) sin costo extra.

### Aplicable a

Mediana o superior. En Grande/Enterprise se incluye SIN cargo extra como diferenciador de tier.

## 6. Certificación oficial con firma digital + QR verificable

**Qué desbloquea**: emisión de certificados PDF con firma digital + QR que apunta a URL de verificación pública (`https://cliente.examlab.co/verify/<code>`). Layout personalizable con logo, firma del rector, texto legal.

**Racional**: programas académicos formales, diplomados, cursos con certificado que el alumno querrá compartir en LinkedIn.

### Pricing

| Métrica | Valor |
|---|---|
| Precio de venta | **$29/mes** |
| Costo real | $0 marginal (código ya implementado, storage insignificante) |
| **Margen** | **$29 = ~100%** |

### Consideraciones

- Ya está implementado en `src/modules/certificates/certificate-pdf.ts`.
- Cada certificado emitido queda en `certificates` con `shortCode` único.
- URL de verificación pública (RLS anónima) muestra: alumno, curso, fecha, docente, hash de integridad.
- El add-on habilita la emisión en volumen (>10 al mes). Volumen bajo (≤10/mes) puede ir incluido.

### Aplicable a

Todos los planes.

## 7. Servicios de setup one-time (venta consultiva)

Estos NO son recurrentes — son proyectos concretos que se cotizan por hora.

| Servicio | Precio | Duración típica |
|---|---|---|
| Import de datos legacy (Excel/CSV, otros LMS) | **$300-800** flat rate | 8-24h de tech |
| Personalización de branding avanzada (colores, fuentes, logos por rol) | **$400** flat rate | 8h |
| Configuración de reports templates customizados | **$500** flat rate | 12h |
| Migración desde Moodle/Canvas | **$1,500-3,000** flat rate | 40-80h |
| Training para docentes (workshop 2h remoto) | **$200/sesión** | Por sesión |
| Consultoría de estructura académica (mapear carreras + pesos) | **$100/hora** | Según scope |

**Margen estimado**: 40-60% después de costo humano.

## 8. Resumen de contribución al margen

Con la mezcla realista (basado en 20 clientes):

- **60% de clientes** solo el plan base (sin add-ons)
- **25% de clientes** agregan 1 add-on (típicamente Certificación o Code runner)
- **10% de clientes** agregan 2-3 add-ons (perfil Enterprise)
- **5% de clientes** contratan servicios one-time (proyectos)

**Ingreso adicional por add-ons esperado**: ~15-25% sobre el plan base.

**Margen sobre add-ons**: 40-100% según add-on (promedio ~70%).

## Documentos relacionados

- [modelo-precios-v3.md](modelo-precios-v3.md) — planes base
- [analisis-infra-2026.md](analisis-infra-2026.md) — costos que sustentan los precios
- [calculadora.csv](calculadora.csv) — simulador
