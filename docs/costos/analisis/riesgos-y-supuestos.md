# Riesgos y supuestos del modelo v3

> Documenta los supuestos que sustentan el modelo, los riesgos identificados
> y las palancas de mitigación. Reevaluar cada 6 meses o cuando cambie una
> variable material.

## 1. Supuestos base del modelo

### 1.1. Sobre uso técnico

| Supuesto | Valor asumido | Fuente | Riesgo si cambia |
|---|---|---|---|
| Cada matrícula usa ≤ 1 MB de DB (perfil + entregas texto) | 1 MB/matrícula | Medición hoy | Bajo — cabe en 8 GB para 8,000 matrículas |
| Material por curso | 6 MB (real hoy) | Prod 2026-07-07 | Bajo — sube gradual |
| Videos: URL externa (YouTube/Vimeo), NO subidos al Storage | Política contractual | Recomendación | **Medio** — si el cliente sube al Storage, revienta egress |
| ZIPs de proyectos | 5 MB/entrega × ~2/matrícula/año | Estimado | Bajo |
| Edge functions por matrícula/mes | ~50-100 (Reto en vivo, autosave, notifs) | Estimado | Medio a 15k matrículas |
| Realtime peak | 100-200 conexiones concurrentes | Reto en vivo típico | Bajo hasta 500 |

### 1.2. Sobre economía

| Supuesto | Valor asumido | Racional | Riesgo si cambia |
|---|---|---|---|
| Ratio matrículas/cabeza | 4-6× | Educación superior Colombia | Bajo — si es menor, subestimamos revenue |
| Precio Supabase Pro estable | $25/mes | 2026-07-19 | Alto si sube 50% |
| Precio Lovable Pro estable | $25/mes | 2026-07-19 | Alto si sube 50% (más volátil que Supabase) |
| Tech junior/mid Colombia cargado | $1,500-2,000/mes | Mercado Bogotá 2026 | Bajo — sueldos suben ~10%/año |
| Ratio 1 tech : 8 clientes admin | 8:1 | Estimación conservadora | **Alto** — si es 5:1, admin es no viable |
| Churn anual estimado | 20% | Sin data, benchmark SaaS EDU | Alto — no medido |
| CAC piloto | ~$1,000 (40h × $25/h) | Estimado | Medio |
| TRM USD/COP | Sujeta a volatilidad | Actual ~$3,900-$4,500 | Alto en periodos de crisis |

### 1.3. Sobre uso comercial

| Supuesto | Valor asumido | Riesgo |
|---|---|---|
| BYO API key es aceptable para el cliente | Sí (con onboarding) | Medio — algunos no quieren gestionar Google Cloud |
| Grabaciones de clase por URL externa | Aceptable | Medio — algunos privacy-conscious quieren self-hosted |
| Cap por matrículas es medible | Sí (course_enrollments filtrada por período activo) | Bajo — auditable |
| Auto-administrada es dominante (>70%) | Sí | Bajo — reduce riesgo operativo |

## 2. Riesgos y mitigaciones

### 2.1. Riesgos ALTOS (impacto grande, probabilidad medio-alta)

#### R1. Cliente sube videos al Storage en vez de URL externa

**Impacto**: Egress rompe rápido (250 GB → costo +$9/100 GB). Un curso con 20 videos × 100 alumnos = ~40 GB/curso egress rápido.

**Mitigación**:
- **Contractual**: en el contrato, cláusula explícita "los videos deben subirse a plataformas externas (YouTube, Vimeo, Cloudflare Stream). El Storage se usa solo para material de menos de 100 MB por archivo".
- **Técnico**: en `app.teacher.contents.tsx`, agregar warning al detectar video >50 MB: "¿Estás seguro? Recomendamos subir a YouTube y pegar el link".
- **Facturación**: si excede el cap de storage, aplicar el add-on de storage extra automáticamente ($10/100 GB).

#### R2. Supabase o Lovable duplican precios

**Impacto**: Costo fijo de $51 → $100/mes reduce margen de todos los planes.

**Mitigación**:
- **Contingencia documentada**: si Supabase sube >30%, evaluar migración a self-hosted (PostgreSQL en VPS $20/mes). Estimado 2 semanas de dev.
- **Contingencia Lovable**: migrar hosting a Vercel Free/Netlify. La app es un SPA estático — no depende de Lovable en runtime.
- **Cláusula de precio**: en contratos de más de 1 año, cláusula de "revisión de precio si costos de terceros suben >20%".

#### R3. Churn descontrolado

**Impacto**: Si churn anual es 50%, LTV cae de 5 años (estable) a 2 años. Modelo económico se cae.

**Mitigación**:
- **Medir mensualmente**: rate de renovación, cancelaciones, motivos.
- **Programa de éxito de cliente**: check-in trimestral con clientes admin.
- **Prevenir churn de renovación**: contactar 60 días antes del cumpleaños del contrato con reporte de valor entregado.
- **Ofrecer downgrade antes que cancelación**: si un cliente Mediana quiere irse por costo, ofrecer Pequeña con -20%.

#### R4. Ratio tech:cliente insuficiente en Admin

**Impacto**: Si un tech solo soporta 4 clientes (no 8), el costo humano por cliente sube a $450 → margen admin cae de 47%/66% a negativo/mínimo.

**Mitigación**:
- **Medir carga real**: registrar horas/cliente/mes durante primeros 6 meses.
- **Automatizar operación**: dashboard de "salud del cliente" (uso, errores, alertas) para que 1 tech gestione más.
- **Ajustar precio Admin si es necesario**: si el ratio real es 5:1, subir Admin a +$400/mes (no +$300).

#### R5. Impuestos y facturación Colombia

**Impacto**: IVA 19% + retenciones fuente 4-11% pueden reducir ingreso neto ExamLab hasta 30%.

**Mitigación**:
- **Precios "más IVA"** en propuesta: los precios publicados son netos, no incluyen impuestos.
- **Estructura societaria**: consultar con contador si conviene facturar como Sociedad SAS, régimen común, etc.
- **Facturación USD**: si algún cliente puede pagar en USD (ej. universidades con financiamiento internacional), reduce fricción cambiaria y algunos impuestos.

### 2.2. Riesgos MEDIOS

#### R6. Fricción de BYO API key

**Impacto**: Algunas instituciones no tienen equipo técnico para configurar Google Cloud → prefieren competidor con IA administrada.

**Mitigación**:
- **Add-on "IA administrada"** existe ($0.10/matrícula/mes). Se ofrece como "todo incluido, más simple".
- **Guía paso-a-paso** para BYO: video de 10 min + docs.
- **Setup asistido**: incluido en primer mes de Admin.

#### R7. Percepción "Chamilo es gratis, ¿por qué pagar?"

**Impacto**: Universidades con equipo técnico fuerte pueden self-host Chamilo por $0.

**Mitigación**:
- **Mensaje**: "Chamilo gratis + tu tiempo de admin = ~$350/mes valorizado. ExamLab $149 es más barato y no gestiones servidores".
- **Diferenciación por features**: IA + Reto en vivo + anti-plagio + UI moderna que Chamilo no tiene.

#### R8. Concentración en pocos clientes grandes

**Impacto**: Si un E6 (Enterprise $2,499/mes) representa 30% del revenue, perderlo hunde el mes.

**Mitigación**:
- **Diversificar el portafolio**: no dejar que 1 cliente sea más del 20% del revenue.
- **Contratos multi-año** con Enterprise para reducir churn oportunista.
- **Cláusula de terminación anticipada**: penalty por cancelar antes del término.

#### R9. Cambio en política de precios de Google Gemini

**Impacto**: Si Gemini sube precio 3× (posible), el add-on "IA administrada" pasa de 38% margen a negativo.

**Mitigación**:
- **Ya soportado fallback OpenAI/Anthropic** en el código.
- **Cláusula de pass-through** en el add-on: "El costo de IA se factura al precio de mercado + 30% de margen. Sujeto a cambio si el proveedor ajusta tarifas".
- **Monitorear precio Gemini mensualmente**.

### 2.3. Riesgos BAJOS pero a monitorear

#### R10. Cliente auto-hospeda su propio ExamLab

**Impacto**: Bajo — el código es propietario. Pero si un cliente Enterprise exige "on-premise por regulación", puede ser tecla comercial.

**Mitigación**:
- **NO ofrecer código fuente**: SaaS puro.
- **On-premise solo para Enterprise real** (>25,000 matrículas) con licencia custom (~$50k/año). Documentar como excepción.

#### R11. Competidor local aparece

**Impacto**: Un competidor colombiano/latinoamericano con producto similar puede canibalizar mercado.

**Mitigación**:
- **First mover advantage**: capturar clientes ancla con contratos multi-año.
- **Barrera de entrada baja pero foso alto**: features acumulados (IA embebida, Reto en vivo, anti-plagio, code runner) toman ~1 año en replicar.
- **Marca en el nicho**: publicar casos de estudio con universidades.

## 3. Métricas a monitorear mensualmente

### 3.1. Métricas de infra

```sql
-- Usar en Supabase SQL Editor cada mes:

-- 1. Storage total
SELECT bucket_id, sum((metadata->>'size')::bigint) / 1024 / 1024 AS mb
FROM storage.objects GROUP BY bucket_id;

-- 2. Matrículas activas totales
SELECT count(*) FROM course_enrollments
WHERE course_id IN (SELECT id FROM courses WHERE status = 'active');

-- 3. Uso de IA por tenant
SELECT tenant_id, count(*) as calificaciones_mes
FROM submissions WHERE ai_grade IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY tenant_id;
```

### 3.2. Métricas comerciales

- **MRR** (Monthly Recurring Revenue): suma de todos los planes activos.
- **ARR** (Annual Recurring Revenue): MRR × 12.
- **Churn mensual**: clientes que cancelan / clientes al inicio del mes.
- **Ratio Auto vs Admin**: proporción del portafolio.
- **Add-on attach rate**: qué % de clientes tiene ≥1 add-on.
- **Costo real / Revenue**: margen agregado del mes.
- **CAC promedio**: costo total de ventas / clientes nuevos del mes.

### 3.3. Alertas automáticas recomendadas

Configurar en el dashboard de Supabase:

- Storage > 80 GB (alerta antes de 100 GB cap)
- Egress > 200 GB/mes (alerta antes de 250 GB cap)
- Edge functions > 1.5M/mes (alerta antes de 2M cap)
- Realtime > 400 concurrentes (alerta antes de 500)
- Cualquier `email_skipped_reason` con "provider_error" en `notifications`

## 4. Ciclos de revisión

### 4.1. Cada mes

- MRR, churn, mix de portafolio.
- Alertas de infra.

### 4.2. Cada 3 meses

- Revisión de precios de terceros (Supabase, Lovable, Gemini) — actualizar [analisis-infra-2026.md](analisis-infra-2026.md) si hay cambios.
- Revisión de add-on attach rate.

### 4.3. Cada 6 meses

- Actualizar comparables del mercado — [comparables-mercado.md](comparables-mercado.md).
- Revisar sensibilidad del modelo con datos reales.

### 4.4. Cada año

- Reevaluar toda la propuesta comercial.
- Considerar cambios de tier (subir Pequeña a $179, etc.) según inflación + demanda.

## 5. Decisiones documentadas

**Estas son las decisiones tomadas al crear v3. Cambiarlas requiere nueva versión.**

1. **IA en BYO por default** — todos los planes asumen BYO. IA administrada es add-on.
2. **NO ofrecer Starter Admin** — margen no viable.
3. **NO ofrecer Free tier** — Starter $79 es el piso. (Los clientes que necesitan gratis usan Chamilo self-hosted).
4. **Facturación en USD publicada** — reduce complejidad. Facturación real en COP con TRM del día.
5. **Grabaciones por URL externa por default** — política contractual explícita.
6. **Multi-tenant compartido hasta 25,000 matrículas totales** — aislamiento dedicado solo como add-on.
7. **Supabase Pro suficiente** hasta que un cliente exija SOC2. Team ($599) es contingencia.
8. **Colombia es mercado prioritario** — precios y comparables optimizados para LATAM. Expansión USA/EU es fase 3.

## 6. Qué NO está en el modelo v3 (roadmap futuro)

Estos items se identifican pero se dejan para v4:

- **Corporate training market** (Docebo/TalentLMS): expansión hacia empresas fuera de educación. Requiere features distintos.
- **Marketplace de contenidos**: profesores externos publican cursos, ExamLab cobra 30%. Cambio de modelo de negocio.
- **API pública**: integración con SIS (Systemas de Información Estudiantil) universitarios. Add-on premium potencial.
- **Certificación blockchain**: verificación on-chain. Tecnológicamente interesante pero mercado pequeño hoy.
- **Multilenguaje profundo**: portugués (Brasil), inglés (USA/UK). Actualmente solo es-CO + en.
- **Mobile app nativa**: hoy es PWA. iOS/Android nativo requiere inversión.

## Documentos relacionados

- [modelo-precios-v3.md](modelo-precios-v3.md) — precios y planes
- [analisis-infra-2026.md](analisis-infra-2026.md) — costos base
- [calculadora.csv](calculadora.csv) — simulador de escenarios
