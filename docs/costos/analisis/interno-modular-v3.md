# 🔒 INTERNO — homólogo del modelo modular v3

> **Uso interno (NO mostrar al cliente).** Espejo de [`modelo-modular-v3.md`](modelo-modular-v3.md)
> y del deck modular: acá está **mi costo/margen de cada bundle**. La IA solo me cuesta si el
> cliente toma **IA administrada** o yo administro con IA — ver
> [`interno-comercial-v3.md` §2](interno-comercial-v3.md) para la tabla de mi costo de IA. USD/mes.

## Margen por bundle coherente (modalidad AUTO, IA = BYO ⇒ $0 IA para mí)

| Bundle (perfil) | Composición | Precio | Mi costo | Margen $ | Margen % |
|---|---|---|---|---|---|
| **Colegio pequeño** | Pequeña | $149 | ~$18 | $131 | **88%** |
| **Facultad de Ingeniería** | Mediana + Code runner | $349 + $49 = $398 | ~$43 (infra $38 + Lambda $5) | $355 | **89%** |
| **Instituto con certificación** | Mediana + Certificación | $349 + $29 = $378 | ~$38 | $340 | **90%** |
| **Universidad regulada** | Grande + Aislamiento + SSO | $799 + $99 + $29 = $927 | ~$165 (infra $90 + Supabase dedicado $75) | $762 | **82%** |

## Margen de cada add-on (referencia)

| Add-on | Precio | Mi costo real | Margen |
|---|---|---|---|
| IA administrada | $0.10/matr/mes | ~$0.062 típico / $0.20 intensivo | **38% típico / PÉRDIDA intensivo** → tope obligatorio (ver interno-comercial §2) |
| Storage extra | $10/100GB | $2,13/100GB | **79%** |
| Code runner | $49/mes | ~$5 (Lambda) | **90%** |
| Aislamiento dedicado | $99/mes | ~$75 (Supabase dedicado $25 + ops $50) | **24%** |
| SSO/SAML | $99 setup + $29/mes | ~$50 setup, $0 recurrente | **50% setup / ~100% recurrente** |
| Certificación | $29/mes | $0 marginal | **~100%** |

## Si el bundle es ADMINISTRADO o incluye IA administrada

Sumar al costo de cada bundle:
- **Humano** (Administrada +$300): +~$225/cliente/mes.
- **IA administrada**: +mi costo de Gemini según escala (200→$12 · 1.000→$62 · 3.000→$186 · 10.000→$620 típico; ver [`interno-comercial-v3.md` §2](interno-comercial-v3.md)). En uso intensivo puede volverse pérdida sin el tope contractual.

**Regla:** el aislamiento dedicado (margen 24%) y la IA administrada intensiva son los add-ons de menor/negativo margen — no descontarlos en negociación; ahí no hay espacio.
