# Mapeo oficial: qué lenguaje ejecuta cada compilador

> **La fuente de verdad es el código**, no esta tabla:
> [`src/modules/code/language-support.ts`](../src/modules/code/language-support.ts) (y su réplica Deno
> en `supabase/functions/execute-code/language-support.ts`). Esta tabla se generó desde ahí. Si
> cambiás el mapeo, regenerala.

## Los cuatro compiladores

| Provider | Qué es | Credenciales (Edge Function Secrets) |
|---|---|---|
| **`aws_lambda`** | **La VM propia, donde corre Judge0.** Judge0 NO es un provider aparte: es la implementación de este. Sin cuota de terceros ni costo por corrida. | `JUDGE0_URL` (+ `JUDGE0_AUTH_TOKEN` si la VM lo exige). Si `JUDGE0_URL` no está, se usa el protocolo propio de `aws/code-runner/app.py` con `AWS_RUNNER_URL` + `AWS_RUNNER_API_KEY`. |
| **`jdoodle`** | API externa. El único además de la VM que ejecuta Kotlin. | `JDOODLE_CLIENT_ID`, `JDOODLE_CLIENT_SECRET` |
| **`onlinecompiler`** | API externa. La de catálogo más amplio, pero **sin Kotlin**. | `ONLINE_COMPILER_API_KEY` |
| **`cheerp`** | CheerpJ: bytecode JVM en el **navegador**. Solo Java — no existe `kotlinc` en el navegador, así que no hay con qué compilar Kotlin. Server-side se resuelve a otro provider. | ninguna (client-side) |

## Tabla

Leyenda: ✅ soportado y habilitado · ⚪ Judge0 lo conoce pero no está declarado como habilitado en la
VM (el ruteo lo manda a otro provider) · — sin soporte.

| Lenguaje | VM propia (`aws_lambda` = Judge0) | JDoodle | OnlineCompiler.io | CheerpJ | Ofrecido en la UI |
|---|---|---|---|---|---|
| **Java** | ✅ `id 62` | ✅ `java v4` | ✅ `openjdk-25` | ✅ (navegador) | ✅ |
| **Kotlin** | ⛔ `id 78` (instalado, **no habilitado** — ver nota) | ✅ `kotlin v3` | — | — | ✅ |
| **Python** | ✅ `id 71` | ✅ `python3 v4` | ✅ `python-3.14` | — | ✅ |
| **JavaScript** | ⚪ `id 63` | ✅ `nodejs v4` | ✅ `typescript-deno` | — | ✅ |
| **TypeScript** | ⚪ `id 74` | ✅ `typescript v1` | ✅ `typescript-deno` | — | — |
| **C** | ⚪ `id 50` | ✅ `c v5` | ✅ `gcc-15` | — | — |
| **C++** | ⚪ `id 54` | ✅ `cpp17 v1` | ✅ `g++-15` | — | — |
| **C#** | ⚪ `id 51` | ✅ `csharp v4` | ✅ `dotnet-csharp-9` | — | — |
| **F#** | ⚪ `id 87` | ✅ `fsharp v1` | ✅ `dotnet-fsharp-9` | — | — |
| **Go** | ⚪ `id 60` | ✅ `go v4` | ✅ `go-1.26` | — | — |
| **Rust** | ⚪ `id 73` | ✅ `rust v4` | ✅ `rust-1.93` | — | — |
| **PHP** | ⚪ `id 68` | ✅ `php v4` | ✅ `php-8.5` | — | — |
| **Ruby** | ⚪ `id 72` | ✅ `ruby v4` | ✅ `ruby-4.0` | — | — |
| **Haskell** | ⚪ `id 61` | ✅ `haskell v3` | ✅ `haskell-9.12` | — | — |

**Por qué la columna "Ofrecido en la UI" es más corta:** el mapeo documenta todo lo que el motor
*puede* correr; exponer 14 lenguajes en el editor del alumno es una decisión de producto aparte. Para
habilitar uno, agregalo a `UI_EXECUTABLE_LANGUAGES` — el resto de la app lo toma solo (los 6
selectores se generan desde esa lista).

**Por qué Kotlin está ⛔ en la VM aunque el compilador esté instalado:** medido a 1 vCPU
(1769 MB, el shape que se despliega), `kotlinc` cuesta **13–18 s+ solo en compilar**. Un `println`
pasó en 13,3 s, pero un programa de 40 líneas y el estilo `object`/`@JvmStatic` murieron en el
timeout de 18 s. Contra el cap de **29 s de API Gateway** y con cold start encima, no es usable en
un examen. Subir a 2 vCPU no mejoró (medido). El JVM del compilador arranca de cero en cada request
y no se calienta entre invocaciones, así que el costo es estructural. El ruteo manda Kotlin a
**JDoodle**, que lo soporta y es rápido; el código del runner queda listo para el día que haya un
daemon de compilación caliente o un shape con más CPU — se vuelve a declarar en
`AWS_LAMBDA_LANGUAGES` y funciona.

**Por qué la VM tiene ⚪ y no ✅ en 11 lenguajes:** Judge0 los conoce, pero lo que la VM tenga
realmente instalado es una cuestión de despliegue. Declararlos todos haría que el ruteo mandara, por
ejemplo, Haskell a la VM y fallara ahí en vez de irse a un provider que sí lo corre. Se amplía
`AWS_LAMBDA_LANGUAGES` a medida que se confirma cada uno con el verificador.

## Cómo se elige el compilador

1. **Configuración efectiva** — la resuelve el RPC `get_active_code_execution_settings()`:
   override de la institución → default de plataforma → defaults duros. El edge y la UI llaman al
   **mismo** RPC, así que el "compilador por defecto" es uno solo en toda la app.
2. **Override por pregunta** — el alumno puede elegir otro compilador durante un examen si el default
   está caído (`CodeRunnerPicker`). Se audita `provider_overridden`.
3. **Ruteo por lenguaje** — `resolveProviderFor(language, configurado)`. Si el configurado no soporta
   el lenguaje, se rutea al primero que sí (orden: VM propia → JDoodle → OnlineCompiler). Si **ninguno**
   lo soporta, el edge responde **400 con mensaje explícito** — nunca un intento a ciegas.
4. **Fallback ante fallo de infraestructura** — si el provider elegido revienta (secret faltante, VM
   caída, timeout), se reintenta con otro que **soporte el lenguaje** y se audita
   `code.provider_fallback`. Los errores de CÓDIGO del alumno no pasan por acá.

### Por institución

`code_execution_settings` tiene `tenant_id`: `NULL` = default de plataforma, con valor = override de esa
institución. Una sola fila activa por institución (índice único parcial con `COALESCE`, porque en un
UNIQUE los NULL se consideran distintos entre sí). El Admin gestiona **solo** la fila de su
institución; el SuperAdmin todas.

## Verificar la VM (obligatorio antes de confiar en los ids)

Los `language_id` de Judge0 **dependen de la versión instalada**. Un id equivocado no falla al
arrancar: **ejecuta otro lenguaje** (mandar Kotlin al compilador de Java compila y devuelve un error de
sintaxis incomprensible para el alumno). Es un fallo mudo, así que se chequea con herramienta:

```bash
JUDGE0_URL=http://mi-vm:2358 node scripts/judge0-verify-languages.mjs
# con auth:
JUDGE0_URL=... JUDGE0_AUTH_TOKEN=... node scripts/judge0-verify-languages.mjs
```

Reporta: ids del mapeo que no existen en la VM (con candidatos por nombre), ids cuyo nombre real no
coincide con el lenguaje esperado, si **Kotlin** está habilitado, y qué lenguajes ofrece la VM que el
mapeo ignora. Sale con código 1 si hay algo que corregir, así que sirve en CI.

### Habilitar Kotlin en la VM

1. Correr el verificador. Si lista Kotlin, anotá su `id` real y corregilo en `language-support.ts` si
   difiere de `78`.
2. Si **no** lo lista: la imagen de Judge0 no trae el compilador de Kotlin. Judge0 CE lo incluye en su
   release estándar, así que lo habitual es que falte por usar una imagen recortada — revisar qué
   imagen corre la VM.
3. Tras corregir ids, **regenerar la réplica Deno** (`supabase/functions/execute-code/language-support.ts`).
   El test `src/modules/code/language-support.test.ts` falla si las dos copias divergen.

Mientras Kotlin no esté en la VM, el ruteo lo manda a **JDoodle**, que sí lo soporta: el alumno puede
ejecutar igual, solo que consumiendo cuota de terceros.

## Al agregar un lenguaje nuevo

1. `CodeLanguage` en `language-support.ts` → TypeScript enumera solo lo que falta (`LANGUAGE_LABEL` y
   `MONACO_LANGUAGE` son `Record` exhaustivos: el build rompe si te olvidás).
2. Su id en cada mapa de provider que lo soporte. **No inventar ids** — si no está confirmado, dejarlo
   afuera y que el ruteo lo mande a otro.
3. `UI_EXECUTABLE_LANGUAGES` si querés que aparezca en los selectores.
4. Starter en `CodeEditor.tsx` (`getStarterCode` + `LANGUAGE_CONFIG`).
5. Regenerar la réplica Deno y correr `language-support.test.ts`.
6. Si es compilado y multi-archivo, revisar `combine-files.ts` (y su réplica en el edge).
