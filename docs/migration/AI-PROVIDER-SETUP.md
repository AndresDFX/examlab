# Configuración del provider de IA

Las edge functions que usan IA (`generate-contents`, `ai-grade-submission`,
`evaluate-exam-time`) soportan tres providers que hablan el mismo formato
OpenAI chat-completions. Cuál se usa se controla desde la tabla
`public.ai_model_settings` (singleton con `is_active=true`).

| Provider | Endpoint | Env var con la key | Formato de key |
|---|---|---|---|
| `lovable` | `ai.gateway.lovable.dev/v1/chat/completions` | `LOVABLE_API_KEY` | `sk_lovable_...` |
| `openai` | `api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` | `sk-...` |
| `gemini` | `generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `GEMINI_API_KEY` | `AIza...` |

> El provider `gemini` se agregó en la migration `20260515000000_ai_provider_gemini.sql`.
> Si tu proyecto restaurado es anterior a esa, tienes que aplicarla
> primero (`Apply DB Migrations` workflow o copy/paste en SQL Editor).

---

## Por qué hay tres providers

- **`lovable`** es lo más simple si tu app vive en Lovable Cloud — Lovable
  gestiona el quota y la facturación de Gemini/Claude detrás. Limita
  tu independencia: si te vas de Lovable, dejas de tener esa key.
- **`openai`** te conecta directo con OpenAI (gpt-4o, gpt-4o-mini, etc.).
  Pagas tu propia factura, control total.
- **`gemini`** te conecta directo con Google AI Studio. Mismo modelo
  Gemini que usa Lovable internamente, pero con tu key y tu quota.
  Plan free tier de Google AI Studio es generoso (~15 RPM, 1500 RPD).

Los tres hablan el mismo wire format (OpenAI chat-completions), así que
el body de la request (`messages`, `tools`, `tool_choice`) viaja idéntico
— solo cambia el `model`. El código de las edge functions tiene un solo
switch en `aiChatCompletion()` que elige endpoint + key según el provider
activo.

---

## Cambiar el provider activo

### Paso 1 — Obtener la API key

| Provider | Dónde |
|---|---|
| `lovable` | Lovable → Settings → API Keys → `Create API key`. Empieza con `sk_lovable_...` |
| `openai` | https://platform.openai.com/api-keys → `Create new secret key`. Empieza con `sk-...` |
| `gemini` | https://aistudio.google.com/apikey → `Create API key`. Empieza con `AIza...` |

### Paso 2 — Setear el secret en el nuevo Supabase

Dashboard del nuevo Supabase → **`Edge Functions`** → **`Secrets`** →
`Add new secret`:

- **Name**: `LOVABLE_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` (según provider)
- **Value**: la key del paso 1

> El secret puede coexistir con los de otros providers. No los borres si
> querés cambiar entre ellos sin re-pegar valores.

### Paso 3 — Cambiar el provider activo en `ai_model_settings`

SQL Editor:

```sql
UPDATE public.ai_model_settings
SET provider = 'gemini',          -- o 'lovable' o 'openai'
    model = 'gemini-2.5-flash',   -- ver tabla de modelos abajo
    is_active = true
WHERE is_active = true;
```

> **Importante**: la tabla tiene un índice UNIQUE PARTIAL sobre
> `is_active=true`. Solo puede haber UNA configuración activa.

Verificar:

```sql
SELECT provider, model, is_active FROM public.ai_model_settings WHERE is_active = true;
```

### Paso 4 — (Opcional) borrar el caché en memoria de las edge functions

Las 3 edge functions cachean la resolución de provider/model dentro de
la misma invocación. Como las invocaciones son procesos efímeros que
mueren entre requests, el caché se evapora solo en ~minutos.

Si necesitas forzar el cambio inmediato, re-deploya las funciones desde
GitHub Actions → `Deploy Edge Functions` → `Run workflow`. El re-deploy
mata las instancias warm y la próxima request crea instancias frescas
que leen el `ai_model_settings` actualizado.

---

## Modelos soportados

### Provider `gemini`

| Modelo | Cuándo usar |
|---|---|
| `gemini-2.5-flash` | Default — rápido y barato (free tier: ~15 RPM, 1500 RPD) |
| `gemini-2.5-pro` | Mejor calidad, ~10x más lento. Para grading sensible |
| `gemini-1.5-flash` | Si necesitas máximo throughput (más viejo, free tier más amplio) |
| `gemini-1.5-pro` | Backup si `gemini-2.5-pro` da rate-limit |

Ver lista actualizada: https://ai.google.dev/gemini-api/docs/models

### Provider `openai`

| Modelo | Cuándo usar |
|---|---|
| `gpt-4o-mini` | Default — barato y rápido |
| `gpt-4o` | Mejor calidad, ~10x más caro |
| `gpt-4-turbo` | Si necesitas contexto largo (~128k) y calidad |

### Provider `lovable`

| Modelo | Notas |
|---|---|
| `google/gemini-2.5-flash` | Default histórico — equivalente a `gemini-2.5-flash` pero ruteado por Lovable |
| `google/gemini-2.5-pro` | Para grading complejo |
| `anthropic/claude-sonnet-4` | Si quieres probar Claude (verificar que Lovable lo enrute) |

---

## Diagnosticar problemas

### Síntoma: `Invalid API key format. Key must start with 'sk_' prefix`

**Causa**: el provider activo es `lovable` pero pusiste una key que NO
es de Lovable (probablemente de Gemini o OpenAI).

**Fix**: cambiá el provider a `gemini` o `openai` según corresponda
(paso 3 arriba), o pegá la key correcta de Lovable en `LOVABLE_API_KEY`.

### Síntoma: `GEMINI_API_KEY missing`

**Causa**: el provider es `gemini` pero no hay un secret con ese nombre
en Edge Functions → Secrets.

**Fix**: paso 2 arriba.

### Síntoma: `401 unauthorized` desde la API de Google/OpenAI/Lovable

**Causa**: key inválida, expirada o sin créditos.

**Fix**:
- Gemini: verificar en https://aistudio.google.com/apikey que la key
  esté activa y el proyecto tenga API enabled.
- OpenAI: verificar saldo en https://platform.openai.com/account/billing.
- Lovable: regenerar key en panel de Lovable.

### Síntoma: `Model not found`

**Causa**: el nombre del modelo no coincide con lo que el endpoint del
provider acepta (ej. `gpt-4o` en endpoint de Gemini).

**Fix**: usá un modelo de la lista de arriba que sí esté soportado por
el provider activo.

### Síntoma: las edge functions devuelven OK pero ves el modelo viejo

**Causa**: el caché en memoria de la edge function todavía tiene el
provider viejo (raro, se evapora en ~5 min).

**Fix**: re-deployar las funciones (paso 4 arriba).

---

## Verificar la configuración desde la UI

Admin → menú lateral → **Sistema** → tarjeta "Provider de IA" muestra
qué provider está activo y si la key correspondiente está presente en
Edge Function Secrets.

Si la key falta, el card aparece en rojo con el secret faltante.

---

## Tabla `ai_model_settings` — schema

```sql
CREATE TABLE public.ai_model_settings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL CHECK (provider IN ('lovable', 'openai', 'gemini')),
  model         text NOT NULL,
  is_active     boolean NOT NULL DEFAULT false,
  updated_by    uuid REFERENCES auth.users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Solo una fila activa a la vez:
CREATE UNIQUE INDEX ai_model_settings_one_active
  ON public.ai_model_settings (is_active)
  WHERE is_active = true;
```

RLS: SELECT abierto a authenticated, INSERT/UPDATE solo Admin.

---

## Archivos relevantes

- [supabase/migrations/20260507110000_ai_model_settings.sql](../../supabase/migrations/20260507110000_ai_model_settings.sql) — creación de la tabla.
- [supabase/migrations/20260515000000_ai_provider_gemini.sql](../../supabase/migrations/20260515000000_ai_provider_gemini.sql) — agrega `'gemini'` al CHECK.
- [supabase/functions/ai-grade-submission/index.ts](../../supabase/functions/ai-grade-submission/index.ts) — función `aiChatCompletion()` con el switch de providers.
- [supabase/functions/evaluate-exam-time/index.ts](../../supabase/functions/evaluate-exam-time/index.ts) — idem.
- [supabase/functions/generate-contents/index.ts](../../supabase/functions/generate-contents/index.ts) — idem.
- [src/routes/app.admin.ai-prompts.tsx](../../src/routes/app.admin.ai-prompts.tsx) — UI para cambiar provider (tab "Modelo"). Si el selector está hardcoded a `lovable`/`openai`, agregar `gemini` ahí también.
