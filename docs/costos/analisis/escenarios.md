# Escenarios comerciales — casos concretos con números

> 6 clientes tipo con propuesta, precio final, ganancia neta, payback.
> Simuládos con [calculadora.csv](calculadora.csv).

## Escenario 1 — Colegio pequeño (piloto)

**Cliente**: Colegio bilingüe con 300 alumnos + 15 profesores. Buscan digitalizar exámenes y usar IA para calificar respuestas abiertas.

**Requerimientos**:
- IA para calificación (aportan su Google Cloud Console).
- No necesitan multi-sede.
- Prefieren self-service (tienen coordinador TI).

**Propuesta**:

| Ítem | Detalle | $/mes |
|---|---|---|
| Plan **Pequeña Auto** | Hasta 1,000 matrículas | $149 |
| Descuento pago anual (-10%) | Compromiso 12 meses | −$15 |
| **Total mensual** | | **$134/mes** |
| **Total anual** | | **$1,608** |

**Costo real ExamLab**: ~$15/mes (fracción del $51 fijo + storage/egress marginal).

**Ganancia neta ExamLab**: **$119/mes = $1,428/año** (89% margen).

**Payback del CAC** ($1,000 estimado): 8.4 meses.

**Comparable Moodle Cloud Small** ($490/año, hasta 200 users): 300 alumnos NO caben en Small, tendrían que ir a Medium ($1,180/año). Comparable **ExamLab** cobra $1,608/año vs Moodle Medium $1,180/año — 36% más caro, pero ExamLab tiene IA + Reto en vivo + anti-plagio + UI moderna.

---

## Escenario 2 — Instituto técnico mediano

**Cliente**: Instituto de sistemas + electrónica en Medellín. 6 carreras técnicas × 4 semestres × 6 materias × ~40 cupos = **~3,000 matrículas activas por semestre**.

**Requerimientos**:
- IA para calificación (usan su API key).
- Code runner para exámenes de programación.
- No hay presión regulatoria (aislamiento).

**Propuesta**:

| Ítem | Detalle | $/mes |
|---|---|---|
| Plan **Mediana Auto** | Hasta 3,000 matrículas | $349 |
| Add-on **Code runner ilimitado** | Java + Python en Lambda | $49 |
| Descuento pago anual (-10%) | Compromiso 12 meses | −$40 |
| **Total mensual** | | **$358/mes** |
| **Total anual** | | **$4,296** |

**Costo real ExamLab**: ~$35/mes (Mediana $30 + code runner overage $5).

**Ganancia neta ExamLab**: **$323/mes = $3,876/año** (90% margen).

**Payback del CAC** ($1,000): 3.1 meses.

**Comparable Canvas**: institución de 3,000 estudiantes @$8/user/año negociado = **$24,000/año**. ExamLab es **5.5× más barato**.

---

## Escenario 3 — Universidad mediana con servicio administrado

**Cliente**: Universidad privada regional con 3,000 matrículas activas. Sin equipo técnico dedicado — necesitan operación administrada.

**Requerimientos**:
- Modalidad administrada (onboarding, capacitación, soporte).
- IA administrada (no quieren gestionar Google Cloud).

**Propuesta**:

| Ítem | Detalle | $/mes |
|---|---|---|
| Plan **Mediana Admin** | Hasta 3,000 matrículas + operación | $749 |
| Add-on **IA administrada** | $0.10 × 3,000 matrículas | $300 |
| **Total mensual** | | **$1,049/mes** |
| **Total anual** | | **$12,588** |

**Costo real ExamLab**:
- Infra: $30/mes
- Tech admin (0.125 FTE): $225/mes
- IA (Gemini Flash uso típico): $186/mes
- **Total costo: $441/mes**

**Ganancia neta ExamLab**: **$608/mes = $7,296/año** (58% margen).

**Payback del CAC** ($1,500 setup asistido): 2.5 meses.

**Comparable Blackboard**: universidad similar ~$5,000-$15,000/mes. ExamLab **5-15× más barato** con servicio equivalente.

---

## Escenario 4 — Universidad grande self-service

**Cliente**: Universidad pública con 8,500 matrículas. Equipo TI robusto — quieren auto-administrarse. Grabaciones de clase van a YouTube unlisted (política institucional).

**Requerimientos**:
- Plan Grande.
- IA con BYO API key.
- SSO con Azure AD.

**Propuesta**:

| Ítem | Detalle | $/mes |
|---|---|---|
| Plan **Grande Auto** | Hasta 10,000 matrículas + SLA 24h | $799 |
| Add-on **SSO/SAML** | Azure AD integration | $29 (+$99 setup una vez) |
| Descuento educación pública (-20%) | Universidad estatal | −$166 |
| **Total mensual** | | **$662/mes** |
| **Setup one-time** | Configuración inicial + SSO | **$99** |
| **Total anual** | | **$7,944** (+$99) |

**Costo real ExamLab**: ~$80/mes (infra Grande + algo de overage esperado a 8,500 matrículas).

**Ganancia neta ExamLab**: **$582/mes = $6,984/año** (88% margen).

**Comparable Canvas** para 8,500 estudiantes: negociado @$10/user/año = **$85,000/año**. ExamLab **10× más barato**.

---

## Escenario 5 — Universidad grande con requerimientos regulatorios

**Cliente**: Universidad grande con exigencia de data residency Colombia (Ley 1581/2012 Habeas Data) + SSO + audit trail extendido.

**Requerimientos**:
- Datos en tenant Supabase dedicado (proyecto propio).
- SSO/SAML con Azure AD.
- Certificación oficial (>10 certificados/mes).
- 8,500 matrículas activas.

**Propuesta**:

| Ítem | Detalle | $/mes |
|---|---|---|
| Plan **Grande Auto** | 10,000 matrículas | $799 |
| Add-on **Aislamiento dedicado** | Supabase project separado | $99 |
| Add-on **SSO/SAML** | Azure AD | $29 |
| Add-on **Certificación oficial** | Emisión ilimitada + QR verificable | $29 |
| Setup one-time (aislamiento + SSO + branding) | — | $500 (una vez) |
| **Total mensual** | | **$956/mes** |
| **Total anual** | | **$11,472** (+$500 setup) |

**Costo real ExamLab**:
- Infra Grande + Supabase Pro extra: $80 + $25 = $105/mes
- Operación aislamiento (deploys extra): $50/mes
- **Total costo: $155/mes**

**Ganancia neta ExamLab**: **$801/mes = $9,612/año** (84% margen).

---

## Escenario 6 — Universidad muy grande (Enterprise)

**Cliente**: Universidad pública nacional con 25,000 matrículas activas. Multi-sede (3 campus). Necesitan SOC2 (algún cliente exigió).

**Requerimientos**:
- >10,000 matrículas → Enterprise.
- Compliance formal (Supabase Team $599 en lugar de Pro $25).
- Aislamiento dedicado.
- Servicio administrado con SLA 4h.
- IA administrada.

**Propuesta custom**:

| Ítem | Detalle | $/mes |
|---|---|---|
| Plan **Enterprise Admin** | 25,000 matrículas + SLA 4h + gerente cuenta | $2,499 |
| Add-on **Aislamiento dedicado en Supabase Team** | SOC2 compliant | $199 |
| Add-on **IA administrada** | $0.10 × 25,000 | $2,500 |
| Add-on **SSO/SAML** | Multi-IdP support | $29 |
| Add-on **Certificación oficial** | Volumen alto | $29 |
| Setup one-time (migración + aislamiento + SSO) | Estimado 100h | $3,000 (una vez) |
| Descuento multi-año (-15%) | Contrato 3 años | −$797 |
| **Total mensual** | | **$4,459/mes** |
| **Total anual** | | **$53,508** (+$3,000 setup) |

**Costo real ExamLab**:
- Supabase Team: $599
- Lovable Business (más créditos): $50
- Infra dedicada extra: $100
- Tech admin dedicado (0.5 FTE por ser Enterprise): $900
- IA Gemini a 25k matrículas típicas: $1,550
- **Total costo: $3,199/mes**

**Ganancia neta ExamLab**: **$1,260/mes = $15,120/año** (28% margen — más bajo pero contract value alto).

**Comparable Canvas** para 25,000 estudiantes: $300k+/año. ExamLab **6× más barato**.

---

## Tabla resumen — 6 escenarios

| Escenario | Perfil | Precio/mes | Costo/mes | Ganancia/mes | Ganancia/año | Margen % |
|---|---|---|---|---|---|---|
| E1 | Colegio 300 Auto | $134 | $15 | $119 | $1,428 | 89% |
| E2 | Instituto 3k Auto + code | $358 | $35 | $323 | $3,876 | 90% |
| E3 | Universidad 3k Admin + IA | $1,049 | $441 | $608 | $7,296 | 58% |
| E4 | Universidad 8.5k Auto + SSO | $662 | $80 | $582 | $6,984 | 88% |
| E5 | Universidad 8.5k regulada | $956 | $155 | $801 | $9,612 | 84% |
| E6 | Enterprise 25k Admin | $4,459 | $3,199 | $1,260 | $15,120 | 28% |

## Análisis del portafolio ideal

**Mix recomendado inicial** (para maximizar margen agregado):

```
5 clientes E1 (Colegio Auto)    → $1,428/año × 5 = $7,140
8 clientes E2 (Instituto Auto)  → $3,876/año × 8 = $31,008
4 clientes E3 (Universidad Admin) → $7,296/año × 4 = $29,184
2 clientes E4 (Universidad Grande) → $6,984/año × 2 = $13,968
1 cliente E5 (Universidad regulada) → $9,612/año × 1 = $9,612
─────────────────────────────────────────────────────
20 clientes total → ~$90,912/año en ganancia neta
```

**Costo total anual estimado**: ~$18,000 (infra + 0.5 FTE tech promedio + herramientas).

**Ganancia neta anual del portafolio**: **~$72,912** (80% margen agregado).

## Reglas de venta que emergen

1. **NO firmar Starter Admin** — la operación humana ($225) no cabe en el spread.
2. **Priorizar clientes con IA=BYO** en las primeras 20 firmas — protege margen.
3. **Empujar el pago anual** con -10% — mejora cashflow y reduce churn.
4. **Enterprise (E6) es baja prioridad** hasta tener 15+ clientes en franjas menores — margen bajo (28%), gestión compleja, requiere Supabase Team ($599).
5. **Educación pública** (universidades estatales): -20% publicable atrae, pero fija payment terms de 90 días → factorar el flujo.
6. **Cross-selling de add-ons**: apuntar a 25% del portafolio con ≥1 add-on (mejor margen que subir de plan).

## Documentos relacionados

- [modelo-precios-v3.md](modelo-precios-v3.md) — precios base y racional
- [add-ons.md](add-ons.md) — detalle de cada add-on
- [calculadora.csv](calculadora.csv) — simulador
- [riesgos-y-supuestos.md](riesgos-y-supuestos.md) — supuestos que fundamentan estos números
