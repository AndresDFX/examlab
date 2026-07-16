# Comparables del mercado — pricing LMS 2026-07

> Precios verificados en las fuentes oficiales el 2026-07-19.
> Convertidos a USD/mes/matrícula para comparación uniforme con ExamLab.

## 1. Moodle Cloud (hosting oficial de Moodle)

Fuente: [moodlecloud.com/standard-plans](https://www.moodlecloud.com/standard-plans/)

| Plan | Usuarios | Precio anual USD | $/mes | $/matrícula/mes |
|---|---|---|---|---|
| Starter | 50 | $160 | $13.33 | $0.27 |
| Mini | 100 | $270 | $22.50 | $0.23 |
| Small | 200 | $490 | $40.83 | $0.20 |
| **Medium** | **500** | **$1,180** | **$98.33** | **$0.20** |
| Standard | 750 | $2,080 | $173.33 | $0.23 |

**Notas**:
- Moodle Cloud es hosted managed — pagás por la cantidad de usuarios activos.
- **No incluye IA** (integración con OpenAI/otros es plugin extra).
- **No incluye Kahoot** (plugin de encuestas básico).
- **No incluye anti-plagio** (Turnitin es integración extra ~$5-10/usuario/año).
- Interfaz percibida como "años 2010" comparado con productos modernos.

## 2. Canvas LMS (Instructure)

Fuente: [Vendr Marketplace](https://www.vendr.com/marketplace/canvas) + análisis independientes.

**Pricing NO publicado — se negocia por institución.**

| Escala institución | Precio anual estimado | $/matrícula/mes |
|---|---|---|
| Small (<5,000 usuarios) | $25k-$75k | $0.42-$1.25 |
| Mid-size (5k-20k) | $75k-$300k | $0.31-$1.25 |
| Large (20k+) | $300k+ | Custom |

**Rango típico**: $5-$30/estudiante/año = **$0.42-$2.50/matrícula/mes**.

**Notas**:
- Requiere negociación con Instructure — no hay auto-servicio.
- Contrato mínimo típico 3 años.
- Setup + capacitación: $10k-$50k adicionales.
- Muy usado en Estados Unidos y Europa. En LATAM tiene presencia pero es percibido como caro.

## 3. Blackboard Learn

**Pricing NO publicado — enterprise-only, negociado.**

| Escala | Precio anual estimado | $/matrícula/mes |
|---|---|---|
| Universidad mediana | $50k-$200k | $0.50-$3.00 |
| Universidad grande | $200k-$1M+ | Variable |

**Notas**:
- Legacy dominant en LATAM (muchas universidades públicas lo tienen).
- UI percibida como anticuada.
- Costos ocultos de operación son significativos.

## 4. Chamilo LMS

Fuente: [chamilo.org](https://chamilo.org) + [BeezNest hosted](https://beeznest.com).

| Modalidad | Precio | Descripción |
|---|---|---|
| Chamilo Self-hosted | **$0** | Open source. Cliente monta su propio servidor. |
| Chamilo PRO (BeezNest) | Cotización | Hosting managed + soporte + upgrades. Cotización individual. |

**Notas**:
- Open source real — cero licencias.
- Popular en LATAM (proyecto originado en Bélgica pero muy adoptado en América Latina).
- **Costo real total**: $0 licencia + VPS ($20-50/mes) + admin server (~10h/mes × $30 = $300/mes valorizado) + updates manuales.
- Es la "opción gratuita" que ExamLab tiene que superar en valor entregado.

## 5. Google Classroom

**Pricing**: **$0** para instituciones con Google Workspace for Education.

**Notas**:
- Casi gratis para colegios/universidades ya en el ecosistema Google.
- **Muy básico**: no tiene banco de preguntas serio, no tiene proyectos, no tiene calificación con IA, no tiene proctoring.
- Competidor real solo para colegios pequeños que ya usan Google Workspace.
- ExamLab compite por **profundidad de features**, no por precio.

## 6. Microsoft Teams (Education)

**Pricing**: incluido en Microsoft 365 for Education (~$5-8/usuario/año).

**Notas**:
- Similar a Google Classroom — competitivo por precio pero limitado en features educativos.
- Fuerte para colegios/universidades que ya son Microsoft-heavy.
- ExamLab compite por: banco de preguntas, IA de calificación, Kahoot integrado.

## 7. Docebo, TalentLMS, Absorb

Fuente: comparativa de [G2](https://www.g2.com) y [Capterra](https://www.capterra.com).

Enfoque distinto (corporate training, no académico) pero con overlap:

| Producto | Modelo | Precio |
|---|---|---|
| Docebo | Corporate | $2-6/usuario activo/mes |
| TalentLMS | SMB | $0.60-2/usuario/mes (mínimos $69-$429/mes) |
| Absorb LMS | Enterprise | Custom (típico $1-3/usuario/mes) |

**Notas**:
- Diseñados para corporate LMS, no para educación superior.
- No tienen features específicos de universidad (semestres, cortes, actas de notas oficiales).
- Solo relevantes si ExamLab se expande a corporate training (roadmap futuro).

## 8. Posicionamiento de ExamLab en el mercado

```
Precio por matrícula/mes (2026-07):

$0.00 ─┤ Chamilo self-hosted, Google Classroom Free
       │
$0.10 ─┤ ★ ExamLab Grande ($0.08)
       │
$0.15 ─┤ ★ ExamLab Mediana ($0.12), ★ ExamLab Pequeña ($0.15)
       │
$0.20 ─┤ Moodle Cloud Medium/Standard
       │
$0.30 ─┤ Moodle Cloud Starter
       │
$0.50 ─┤ Canvas Small (negociado bajo), Blackboard mid-market
       │
$1.00 ─┤ Docebo, Canvas mid-market
       │
$1.50 ─┤
       │
$2.00 ─┤ TalentLMS, Absorb
       │
$2.50 ─┤ Canvas enterprise, Blackboard enterprise
       │
$3.00+ ─┤ (custom deals)
```

## 9. Diferenciación competitiva de ExamLab

### vs. Moodle Cloud (competidor directo)

| Feature | Moodle Cloud | ExamLab |
|---|---|---|
| Precio Medium (500 users) | $98/mes | $149/mes (Pequeña) |
| IA de calificación | Plugin extra | Incluida (BYO) |
| Kahoot en vivo | Plugin básico | Nativo con PIN + QR |
| Anti-plagio | Turnitin extra | Detección con IA incluida |
| UI | 2010 | 2026 (React + shadcn) |
| Multi-idioma | Amplio | es-CO + en |
| Setup | Self-service | Self-service o guided |

**Ganador por precio absoluto**: Moodle Cloud (~30-50% más barato en tier Small/Medium).
**Ganador por features**: ExamLab (IA + Kahoot + antiplagio integrados).
**Ganador por experiencia**: ExamLab (UI moderna).

### vs. Canvas (competidor premium)

| Feature | Canvas | ExamLab |
|---|---|---|
| Precio 3,000 estudiantes | $2,500-$12,500/mes | $349/mes (Mediana) |
| Features | Amplios, maduros | Ambos comparables |
| Contract mínimo | 3 años típico | Anual o mensual |
| Setup | 3-6 meses | Días |
| Latin America support | Limitado | Nativo es-CO |

**Ganador por precio**: ExamLab (7-35× más barato).
**Ganador por features**: paridad; Canvas tiene más integrations (Turnitin, Zoom, etc.) pero ExamLab tiene features modernos.
**Ganador por time-to-value**: ExamLab (self-service inmediato).

### vs. Chamilo (competidor gratis)

| Feature | Chamilo self-hosted | ExamLab |
|---|---|---|
| Licencia | $0 | $149-799/mes |
| Hosting | Cliente paga VPS ($20-50/mes) | Incluido |
| Ops | Cliente admin server (~10h/mes valorizadas ~$300) | ExamLab lo mantiene |
| IA | Plugin extra | BYO built-in |
| Updates | Manual | Continuos |

**Costo total real Chamilo**: $0 licencia + $50 VPS + $300 admin = **~$350/mes valorizado**.
**Costo total ExamLab Pequeña**: **$149/mes**.

ExamLab es de hecho **más barato** que Chamilo self-hosted cuando se valoriza el tiempo de admin.

## 10. Estrategia de mensaje por segmento

### Para colegios ya en Google Workspace

**Mensaje**: "Google Classroom te da lo básico. ExamLab te da la evaluación digital profesional (banco de preguntas, IA, anti-plagio, Kahoot integrado). Puedes seguir usando tu Google Workspace para lo demás — nosotros nos integramos con SSO."

### Para universidades ya en Moodle

**Mensaje**: "Moodle funciona pero se siente 2010. ExamLab es la evolución moderna: mismo poder + IA + UI que tus alumnos van a querer usar. Migración asistida incluida en el primer mes."

### Para universidades evaluando Canvas

**Mensaje**: "Canvas es genial pero cuesta 10-30× más y toma 3-6 meses configurarlo. ExamLab entrega el 90% del valor por el 10% del costo, listo en 1 semana."

### Para instituciones sensibles al precio

**Mensaje**: "Menos de $0.15 por matrícula al mes — más barato que Moodle Cloud, y con IA incluida. Prueba gratis un semestre."

## Sources

- [Moodle Cloud Standard Plans](https://www.moodlecloud.com/standard-plans/)
- [Moodle Pricing 2026: Plans, Costs & TCO](https://checkthat.ai/brands/moodle/pricing)
- [Canvas LMS Pricing 2026](https://formswrite.com/blog/canvas-lms-pricing-plans-and-costs-explained)
- [Canvas Software Pricing & Plans 2026 - Vendr](https://www.vendr.com/marketplace/canvas)
- [Chamilo Pricing 2026 - G2](https://www.g2.com/products/chamilo-lms/pricing)
- [Chamilo LMS Homepage](https://chamilo.org/en/)
