# Almacenamiento esperado y política de storage por plan

> Documento técnico-comercial · ExamLab v3 · Moneda USD/mes · Locale es-CO
> Base: material didáctico + entregas en Supabase Storage. **IA = BYO** (no afecta storage). **Videos = URL externa** (no consumen storage de ExamLab).
> Reverificar precios Supabase/R2 antes de firmar contrato — ajustan ~2×/año.

---

## 1. Modelo de consumo de storage

ExamLab usa **Supabase Storage** con buckets separados por función. El storage crece por **acumulación** (el material y las entregas quedan almacenados entre semestres salvo purga explícita), no por concurrencia. Los drivers reales, confirmados en el código:

| Bucket | Qué guarda | Tamaño por unidad | Driver de crecimiento | Cap por archivo |
|---|---|---|---|---|
| **generated-contents** | Material didáctico del curso: docx, pptx, pdf, imágenes, notebooks `.ipynb`, código fuente inline | **~6 MB/curso** (conservador) a **~15 MB/curso** (agresivo, muchos pptx/pdf pesados) | **N.º de cursos vivos + históricos** | 50 MB |
| **project-files** | ZIPs de código de proyectos + adjuntos de entrega | **~5 MB/ZIP**, ~1,5–2 entregas/año/matrícula en cursos con proyecto | **N.º de entregas de proyecto** (solo cursos de ingeniería/proyecto) | 100 MB |
| **workshop-files** | Archivos de entrega de talleres (PDF, docx) | **~1–2 MB/entrega** | N.º de entregas de taller | 50 MB |
| **support-attachments** | Adjuntos de tickets PQRS | **~0,5 MB/ticket**, pocos tickets/mes | N.º de tickets de soporte | 25 MB |
| **certificates** | PDFs de certificados con QR | **~0,15–0,3 MB/certificado** | N.º de certificados emitidos | pequeño |
| **feedback-attachments** | Adjuntos en retroalimentación docente | ~1 MB, ocasional | Uso esporádico | pequeño |

**Regla de oro que abarata el modelo:** las grabaciones de clase y videos se referencian por **URL externa** (YouTube/Drive/Vimeo). **No pasan por el Storage de ExamLab** y por tanto **no cuentan** en ninguna cuota. Este es el mayor ahorro estructural del modelo — un LMS que aloja video internamente gastaría 10–50× más storage.

### Traducción a "MB por matrícula activa"

Consolidando los buckets sobre la unidad de facturación (matrícula activa = 1 inscripción a materia):

| Componente | Conservador | Agresivo |
|---|---|---|
| Material didáctico (generated-contents) | ~1,0 MB/matr | ~2,0 MB/matr |
| Entregas ZIP + talleres (project/workshop-files) | ~1,8 MB/matr | ~4,5 MB/matr |
| Soporte + certificados + feedback | ~0,2 MB/matr | ~0,5 MB/matr |
| **Total por matrícula activa** | **~3 MB/matr** | **~7 MB/matr** |

El escenario agresivo (~7 MB/matrícula) es coherente con el break-point del modelo v3: **Storage 100 GB de Supabase Pro ≈ 15.000 matrículas totales** (100.000 MB ÷ 7 MB ≈ 14.300).

**Supuestos del rango:**
- **Conservador:** ~30 matrículas/curso, material liviano (6 MB/curso), 30 % de matrículas con entrega ZIP (1,5/año, 5 MB), poca acumulación histórica (~1–2 semestres retenidos).
- **Agresivo:** ~25 matrículas/curso, material pesado (15 MB/curso), 60 % con ZIP (2/año, 8 MB) + archivos de taller, acumulación de 2+ años sin purga.

---

## 2. Storage esperado por escala de matrículas activas

Aplica a la **suma de todos los tenants** sobre el Supabase compartido (modelo actual). Para tenants aislados o self-host, el cálculo por-tenant usa la misma tasa MB/matrícula.

| Matrículas activas | Cursos vivos aprox. | **Conservador (~3 MB/matr)** | **Agresivo (~7 MB/matr)** | Comentario |
|---|---|---|---|---|
| **200** | ~7 | **0,6 GB** | **1,4 GB** | Piloto / colegio pequeño — irrelevante |
| **1.000** | ~33 | **3 GB** | **7 GB** | Tope plan Pequeña — holgadísimo |
| **3.000** | ~100 | **9 GB** | **21 GB** | Tope plan Mediana — cómodo |
| **10.000** | ~330 | **30 GB** | **70 GB** | Tope plan Grande — dentro de los 100 GB Supabase |
| **25.000** | ~830 | **75 GB** | **175 GB** | Enterprise — **rompe los 100 GB agregados de Supabase Pro** |

**Supuestos:** ~30 matrículas/curso; entregas ZIP solo en cursos con componente de proyecto (30–60 % de matrículas según franja); videos siempre externos; sin purga automática del material (peor caso de acumulación en el rango agresivo).

**Lectura clave:** el consumo por-tenant es bajísimo. Incluso una universidad Grande (10.000 matrículas) en el peor caso usa **70 GB** — cabe holgadamente en los 100 GB de Supabase Pro. El punto de tensión **no es el tenant individual, sino el agregado**: con varios tenants sumando >15.000 matrículas totales se supera el pool compartido de 100 GB y empieza overage.

---

## 3. Storage incluido por plan — ¿alcanza?

| Plan | Matrículas máx | Storage soft cap | Uso agresivo esperado al tope | Headroom | ¿Aprieta? |
|---|---|---|---|---|---|
| **Pequeña** ($149) | 1.000 | **50 GB** | ~7 GB | **7×** | No. Solo si suben video como archivo (mala práctica evitable). |
| **Mediana** ($349) | 3.000 | **100 GB** | ~21 GB | **~5×** | No. Margen amplio. |
| **Grande** ($799) | 10.000 | **200 GB** | ~70 GB | **~3×** | No, salvo material propietario pesado no externalizable (video interno, datasets). |
| **Enterprise** | >10.000 | Custom | ~175 GB @ 25k | — | Se dimensiona a medida; aquí sí se planifica R2 o Supabase dedicado. |

**Diagnóstico:** los soft caps por plan son **deliberadamente generosos** frente al consumo real (3–7×). Su función NO es limitar al cliente típico, sino:
1. **Asignar el pool compartido de 100 GB** de Supabase entre tenants (evitar que uno acapare).
2. **Detectar abuso** (subir video/backups/datasets pesados que deberían ir por URL externa).

**Dónde aprieta de verdad:** en el **agregado del Supabase compartido**, no en el plan. Cuando la suma de todos los tenants pasa de ~15.000 matrículas activas (o hay 2–3 tenants Grande con material pesado), se supera 100 GB total y entra overage de Supabase — independientemente de que cada tenant esté por debajo de su cap. **Ese es el trigger operativo** para cobrar storage extra o migrar a R2 (§5), no el cap individual.

---

## 4. Precio de storage extra

### Economía (margen)

| Concepto | Valor |
|---|---|
| Costo real Supabase | **$0,0213/GB/mes = $2,13 por 100 GB** |
| **Precio de venta** | **$10 por 100 GB/mes** |
| **Margen** | **$7,87 por 100 GB = 79 %** |

### Cómo cobrarlo — recomendación

- **Bloques de 100 GB** a $10/mes (mínimo 1 bloque). Cobrar por GB suelto genera facturas confusas y micro-cargos; el bloque es un mental model limpio y el margen (79 %) absorbe cualquier fracción no usada.
- **Solo se factura al superar el soft cap del plan.** El cap incluido cubre >99 % de los clientes; el add-on es para el outlier con material propietario pesado que no puede externalizar.
- **Siempre ofrecer primero la alternativa gratis:** externalizar video/material a URL externa (YouTube unlisted, Drive, Cloudflare Stream) antes de vender el bloque. El add-on es la excepción, no el default.

### Enforcement (soft cap, sin cortar servicio)

1. **80 %:** email automático al Admin del tenant + banner en el UI ("estás usando 40 GB de 50 GB").
2. **100 %:** banner de alerta persistente + email; **NO se corta la subida** durante el mes en curso (misma filosofía que el sobreconsumo de matrículas del modelo v3).
3. **Mes siguiente:** se factura el bloque de 100 GB adicional automáticamente, documentado en contrato ("al superar el cap de storage se habilita facturación por bloques de 100 GB a $10/mes c/u").
4. **Query de control** (Supabase SQL Editor, correr mensual >2.000 matrículas):
   ```sql
   SELECT bucket_id, sum((metadata->>'size')::bigint)/1024/1024/1024 AS gb
   FROM storage.objects GROUP BY bucket_id ORDER BY gb DESC;
   ```

---

## 5. ¿Conviene mover storage a Cloudflare R2? ¿Desde qué escala?

### Comparación de costo unitario

| Concepto | Supabase Storage | **Cloudflare R2** |
|---|---|---|
| Almacenamiento | $0,0213/GB/mes | **$0,015/GB/mes** (~30 % más barato) |
| **Egress (salida de datos)** | **$0,09/GB** (tras 250 GB incluidos) | **$0 — gratis, ilimitado** |
| Operaciones | incluidas | Class A $4,50/M, Class B $0,36/M (despreciable) |

El diferencial de almacenamiento es menor (30 %); **el diferencial que importa es el egress**. Cada descarga de material/ZIP consume egress, y en Supabase el egress overage ($0,09/GB) es el driver de costo que rompe **antes** que el storage puro (break-point egress ~5.000–10.000 matrículas vs storage ~15.000). R2 elimina ese costo por completo.

### Recomendación por escala

| Escala agregada (todos los tenants) | Acción |
|---|---|
| **< 10.000 matrículas / < ~100 GB** | **Quedarse en Supabase Storage.** Todo cabe en el incluido; migrar a R2 no compensa la complejidad operativa (nuevo bucket, firmar URLs, reescribir capa de upload/download). |
| **10.000–15.000 matrículas o egress overage >$20/mes recurrente** | **Empezar a planificar R2.** Migrar primero los buckets pesados y de alta descarga: **`generated-contents`** (material que muchos alumnos descargan) y **`project-files`** (ZIPs grandes). Dejar en Supabase los livianos (`certificates`, `support-attachments`). |
| **> 15.000 matrículas / > 150 GB agregado o clientes Enterprise con video propietario** | **R2 obligatorio** para storage pesado. Con egress gratis, el costo de servir material a 25.000+ matrículas cae a ~$2–3/mes (175 GB × $0,015) vs. potencialmente $50–150/mes en Supabase entre storage + egress. |

**Trabajo de migración:** bajo — R2 expone API compatible con S3, y Supabase ya usa el mismo patrón de signed URLs. Estimado ~1 semana de dev para redirigir upload/download de los 2 buckets pesados y migrar objetos existentes.

**Efecto en pricing:** al mover a R2, el add-on "Storage extra $10/100 GB" pasa a tener margen aún mayor (costo real cae de $2,13 a $1,50/100 GB → **85 % de margen**), y desaparece la presión del egress overage que hoy es el verdadero cuello de botella del Supabase compartido. **Recomendación estratégica:** tratar R2 como la ruta por defecto de storage a partir del primer cliente Grande o Enterprise con material propietario.

---

### Resumen ejecutivo

- Consumo real: **3–7 MB por matrícula activa**. Videos externos = $0 de storage.
- Los caps por plan (50/100/200 GB) sobran 3–7× para el cliente típico; existen para repartir el pool compartido y frenar abuso.
- El límite que muerde es el **agregado de Supabase (100 GB / egress 250 GB)**, no el tenant individual → se cruza cerca de **10–15k matrículas totales**.
- Storage extra: **$10/100 GB, 79 % de margen**, en bloques, con soft cap + avisos al 80/100 %.
- **Migrar los buckets pesados a Cloudflare R2 a partir de ~10k matrículas agregadas** (o del primer Enterprise con video propietario): elimina el egress, que es el driver de costo real.