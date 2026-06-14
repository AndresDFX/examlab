# Factibilidad — Módulo de generación de video con IA

> Evaluación de viabilidad (no implementado). Fecha: 2026-06. Sustenta la decisión
> de incluir, o no, un módulo de "generar video con IA" en ExamLab.

## Respuesta corta

**Sí, es técnicamente posible** generar video con la **misma familia de API key de
Gemini** que ya usamos — pero a través del modelo de video de Google, **Veo**
(no del modelo de texto Gemini), y con tres condiciones importantes: la key debe
estar en **plan de pago** (Veo no está en el free tier), el flujo es **asíncrono y
lento** (segundos→minutos por clip), y el **costo es alto y por segundo**. Encaja
de forma natural en la **cola de IA** que ya tenemos (`ai_generation_queue`).

## Qué ofrece hoy Veo vía Gemini API

- Modelos disponibles por la Gemini API (mismo endpoint/credencial que ya usamos):
  `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`,
  `veo-3.1-lite-generate-preview`.
- Genera **clips cortos** (~8 s, extendibles encadenando) desde **texto** y/o
  **imagen**; Veo 3.x incluye **audio nativo**.
- Es una **operación de larga duración** (long-running operation): la API responde
  con un handle, hay que **hacer polling** hasta que termine y luego **descargar el
  MP4** desde una URI temporal.

### Costo (referencia 2026, por segundo de video)

| Modelo | Rango aprox. |
|---|---|
| Veo 3.1 Lite (sin audio) | desde ~**$0.03/s** |
| Veo 3.1 Fast (con audio) | ~**$0.15/s** |
| Veo 3.1 estándar (con audio) | ~**$0.40/s** |

Un clip de 8 s ≈ **$0.24 – $3.20** según el modelo. Lo paga la **key de la
institución** (mismo modelo de costos que el resto de la IA: la institución pone su
propia key y asume el consumo — ver T&C / `CLAUDE.md`).

## Encaje con la arquitectura actual (lo que ya tenemos a favor)

1. **Provider + key ya existen**: `ai_model_settings` (provider `gemini`) +
   `GEMINI_API_KEY` en secrets de Lovable. Veo se invoca con esa misma credencial
   (no hay que pedir otra key si la actual es de pago con Veo habilitado).
2. **La cola de IA es el lugar ideal**: por ser asíncrono + caro, el patrón correcto
   es **encolar** (no sync). Reusar `ai_generation_queue` añadiendo un `kind =
   'video_generation'` (hoy ya maneja `content_generation`, `exam_questions`,
   `workshop_questions`). El worker (`ai-generation-worker`) + el cron + el panel de
   la cola + el auto-retry transitorio ya están construidos. **Justo encajan con el
   trabajo reciente de la cola** (encolar/cancelar/borrar-cascada).
3. **Storage + módulo de contenido**: el MP4 resultante se guarda en el bucket
   `generated-contents` y se enlaza como Video/Contenido (módulos que ya existen:
   Videos, Contenidos). El visor de media ya reproduce video.
4. **Control de gasto**: el sistema `processing_mode` (sync/async) + el código de
   "IA inmediata" (override con cap) ya permiten gobernar cuándo se permite gastar.

## Diseño propuesto (si se decide hacerlo)

1. **Edge `ai-generate-video`** (`verify_jwt=false` + auth interna, como las otras
   edges de IA): recibe `{ prompt, durationSeconds, model, aspectRatio, imageUrl? }`,
   llama a Veo (`models/veo-3.1-*:predictLongRunning` o equivalente), hace polling
   con backoff hasta `done`, descarga el MP4 y lo sube a `generated-contents`.
2. **Encolar siempre** (kind `video_generation` en `ai_generation_queue`): el worker
   drena en background — un video puede tardar minutos, no se puede bloquear el UI.
   `source_table='generated_contents'`, `source_id` = la fila de contenido destino
   (igual que `content_generation`). El **borrado del contenido ya cancela el job**
   (trigger de cascada recién añadido).
3. **UI Docente**: en Contenidos/Videos, un botón "Generar video con IA" con prompt +
   duración + modelo (Lite/Fast/Estándar) + estimación de costo en vivo
   (`duración × tarifa`). Avisar que el resultado llega a la cola.
4. **Migración**: añadir `'video_generation'` al CHECK de `ai_generation_queue.kind`
   y `code_execution`-style settings si se quiere elegir modelo Veo por defecto en
   `ai_model_settings` (`video_provider` / `video_model`).
5. **Límites a documentar**: clips ~8 s (no clases completas), costo alto, latencia
   de minutos, disponibilidad de Veo sujeta a la región/cuenta de la institución.

## Alternativas (otras API keys)

| Opción | Notas |
|---|---|
| **Veo vía Gemini API** (recomendada) | Misma key, integra con la cola; clips cortos con audio. Requiere plan de pago. |
| **OpenAI Sora vía API** | El provider `openai` ya está soportado en `ai_model_settings`; Sora por API permite texto→video. Otra key (`OPENAI_API_KEY`) ya existente. Misma necesidad de async + costo. |
| **Runway / Pika / Luma / Kling** | APIs dedicadas de video; mayor control creativo pero **key e integración aparte** (no reusan el provider actual). |
| **HeyGen (avatar)** | Ya lo usamos para los tours/demos (`docs/heygen/`). Ideal para **video explicativo con presentador** (voz + avatar sobre guion), distinto a clips generativos. Para "video educativo hablado" suele ser mejor que Veo. |

## Recomendación

- **Viable y de bajo costo de integración** porque reutiliza credencial + cola +
  storage + módulos existentes. El bloqueante NO es técnico sino de **producto/costo**:
  Veo cuesta por segundo y genera clips cortos.
- **Antes de construir**, verificar que la **key de Gemini de la institución tenga Veo
  habilitado en plan de pago** (un `GET models` con la key dirá si aparecen los
  `veo-3.1-*`). Si no, no hay módulo posible con esa key.
- Para **video explicativo de clase** (lo más pedido en educación), **HeyGen/avatar**
  da más valor que Veo. Veo conviene para **intros, ejemplos visuales, b-roll** cortos.
- Si se aprueba: hacerlo **encolado** desde el día 1 (nunca sync) y con **estimación
  de costo visible** + límite por institución, dado el precio por segundo.

## Fuentes

- [Build with Veo 3, now available in the Gemini API — Google Developers Blog](https://developers.googleblog.com/veo-3-now-available-gemini-api/)
- [Gemini Developer API pricing — Google AI for Developers](https://ai.google.dev/gemini-api/docs/pricing)
- [Veo 3 API Pricing 2026 — veo3ai.io](https://www.veo3ai.io/blog/veo-3-api-pricing-2026)
- [Google Veo Pricing Calculator & Cost Guide (Jun 2026) — costgoat.com](https://costgoat.com/pricing/google-veo)
