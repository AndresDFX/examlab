# Configurar login con Microsoft (Azure AD / Microsoft Entra ID)

> **Estado del código:** ✅ Completo. El frontend (`src/routes/auth.index.tsx`), el callback (`src/routes/auth.sso-callback.tsx`) y el edge `auth-sso-verify` ya soportan Microsoft a la par de Google. **No hay que tocar código** para habilitar Microsoft.
>
> Lo que falta es **100% configuración externa**: un registro de app en Azure AD + habilitar el provider Azure en el dashboard de Supabase. Esta guía lo cubre paso a paso.

---

## Escenario: "soy el owner del proyecto (no una institución) y quiero que CUALQUIER usuario ya existente entre con Outlook"

**Respuesta corta:** sí se puede, y es justo para lo que sirve esto. Pero **registrar UNA app en Azure AD es obligatorio** — no hay un atajo que lo evite, ni con Supabase ni con nadie. Cualquier "Login con Microsoft/Google" del mundo necesita una app registrada que entregue un **Client ID + Secret**; Supabase no presta una app compartida (tampoco Google). La buena noticia: **es un registro ÚNICO de ~10 minutos**, lo haces **tú como owner**, y NO necesitas una app por institución.

¿"No sería más simple con Supabase"? Supabase **ya es la parte simple**: hace el intercambio de tokens y te da la sesión. Lo único "externo" es el registro de la app en Azure, que existe porque Microsoft exige identificar a quién le da los datos del usuario. No es algo que ExamLab o Supabase puedan saltarse.

**Cómo montarlo para tu caso (un solo registro multi-tenant, sirve para todos):**

1. **¿No tienes Azure?** No importa que no tengas institución: con **cualquier cuenta Microsoft** (incluso un `@outlook.com` personal) entras a [portal.azure.com](https://portal.azure.com) y tienes un **directorio Entra ID gratis**. No necesitas pagar nada ni ser una organización.
2. **Registra la app UNA vez** (paso 1 de abajo) y en **"Supported account types"** elige:
   > **`Accounts in any organizational directory (Any Microsoft Entra ID tenant) and personal Microsoft accounts`**
   
   Eso es la opción **multi-tenant + personales** (= tenant **`common`**). Con esa sola app, **cualquier** usuario con cuenta Microsoft —de cualquier organización o un Outlook/Hotmail personal— puede autenticarse. No registras nada por institución.
3. En Supabase pones **Azure Tenant URL = `https://login.microsoftonline.com/common`** (paso 2). Debe coincidir con el "multi-tenant + personales" que elegiste en Azure.
4. **"Cualquier usuario YA EXISTENTE"**: la plataforma **no crea cuentas nuevas por SSO** a propósito (política de seguridad). El edge `auth-sso-verify` deja entrar **solo si el email de la cuenta Microsoft ya existe** en `profiles.institutional_email`. Así que, una vez configurado, **todo usuario pre-existente cuyo correo coincida con su cuenta de Outlook entra con un click**. No hay que tocar usuario por usuario.
5. Si algunos de esos usuarios fueron **creados con contraseña** y ahora quieren entrar por Outlook, habilita **Account Linking** en Supabase (sección 4) para que enlace la identidad Microsoft al usuario existente del mismo correo.

> En resumen: **1 app multi-tenant (tú, owner, una sola vez) + provider Azure en Supabase con `common` + Account Linking**. Después, cualquier usuario existente entra con Outlook sin configuración adicional. El resto de esta guía es el detalle paso a paso.

---

## 0. Cómo funciona el flujo (para entender la config)

```
[App ExamLab]
   │  supabase.auth.signInWithOAuth({ provider: "azure" })
   │  redirectTo = https://<host>/auth/sso-callback
   ▼
[Microsoft login]  ← el usuario elige su cuenta
   │
   ▼
[Callback de SUPABASE]  https://uxxpzfsfcnqiwwdxoelm.supabase.co/auth/v1/callback
   │  (Supabase intercambia el código por una sesión)
   ▼
[App: /auth/sso-callback]  invoca el edge auth-sso-verify
   │
   ▼
[edge auth-sso-verify]  valida que el email esté en profiles.institutional_email
   │  ✔ existe → login OK
   │  ✘ no existe → borra el auth.user y rechaza (NO crea cuentas)
```

> ⚠️ **PUNTO MÁS IMPORTANTE Y QUE MÁS SE EQUIVOCA:**
> En Azure AD la **Redirect URI** debe ser la URL de **Supabase** (`https://uxxpzfsfcnqiwwdxoelm.supabase.co/auth/v1/callback`), **NO** la del app (`https://examlab.lovable.app/auth/sso-callback`).
> El callback del app es una **Redirect URL de Supabase** (otra cosa) y va en el dashboard de Supabase, no en Azure.

**Política de la plataforma:** el SSO **no registra usuarios nuevos**. El admin debe pre-crear la cuenta (bulk-import o "Nuevo usuario") con el `institutional_email` correcto. El SSO solo permite el primer login si ese email ya existe.

---

## 1. Registrar la aplicación en Azure AD (Microsoft Entra ID)

1. Entra a **[portal.azure.com](https://portal.azure.com)** con una cuenta con permisos sobre el directorio de la institución.
2. Ve a **Microsoft Entra ID** (antes "Azure Active Directory") → **App registrations** → **New registration**.
3. Llena el formulario:
   - **Name:** `ExamLab SSO`
   - **Supported account types:** elige según el alcance institucional:
     - `Accounts in any organizational directory (Any Microsoft Entra ID tenant) and personal Microsoft accounts` → equivale a tenant **`common`** (recomendado si entran cuentas de varias instituciones o personales).
     - `Accounts in this organizational directory only (Single tenant)` → si la institución quiere restringir a su solo directorio.
   - **Redirect URI:**
     - Plataforma: **`Web`**
     - Valor EXACTO (copiar tal cual, ojo con el `/v1/`):
       ```
       https://uxxpzfsfcnqiwwdxoelm.supabase.co/auth/v1/callback
       ```
       > Esta es la URL de Supabase, **NO** la del app. (Confírmala: aparece igual en el dashboard de Supabase → Auth → Providers → Azure como "Callback URL".)
4. Click **Register**.
5. En la pantalla **Overview**, **anota** el **Application (client) ID** (lo necesitas en Supabase).

### 1.1 Crear el Client Secret

1. En la app registrada → **Certificates & secrets** → pestaña **Client secrets** → **New client secret**.
2. Descripción: `ExamLab Supabase`. Expiración: la máxima que permita la política (ej. 24 meses).
3. Click **Add**.
4. **Copia el `Value` INMEDIATAMENTE** (no el "Secret ID" — el **Value**). Solo se muestra una vez; si sales de la página no lo vuelves a ver.
5. **Anota la fecha de expiración** y agenda un recordatorio para rotarlo antes de que venza (cuando expire, el login Microsoft deja de funcionar hasta cargar un secret nuevo).

### 1.2 Permisos de API (claims que necesitamos)

1. En la app → **API permissions**.
2. Debe haber, sobre **Microsoft Graph** (delegated): `openid`, `email`, `profile`, `User.Read`. Normalmente ya vienen por defecto; si falta alguno: **Add a permission → Microsoft Graph → Delegated permissions** y agrégalo.
3. (Opcional pero recomendado) **Grant admin consent** para que el usuario no tenga que aceptar el consentimiento individualmente.

### 1.3 ⚠️ Asegurar que se emita el claim `email` (evita rechazos confusos)

El edge `auth-sso-verify` valida por **email**. Muchos tenants de Azure **no emiten el claim `email` por defecto** (requiere buzón Exchange o configurar un optional claim). Si falta, Supabase deja `auth.users.email` vacío y el login cae en `reason: no_email` → el usuario válido es rechazado sin razón aparente.

Para evitarlo:

1. En la app → **Token configuration** → **Add optional claim**.
2. Token type: **ID** (y opcionalmente **Access**).
3. Marca **`email`** y **`upn`** → **Add**.
4. Si aparece el aviso "Turn on the Microsoft Graph email permission", acéptalo.

---

## 2. Habilitar el provider Azure en el dashboard de Supabase

1. Entra al **[dashboard de Supabase](https://supabase.com/dashboard)** → proyecto **`uxxpzfsfcnqiwwdxoelm`**.
2. **Authentication** → **Providers** → **Azure**.
3. Configura:
   - **Enable Azure:** ON.
   - **Application (Client) ID:** el *Application (client) ID* del paso 1.
   - **Secret Value:** el **Value** del client secret del paso 1.1 (NO el Secret ID).
   - **Azure Tenant URL:**
     - Multi-tenant / personales: `https://login.microsoftonline.com/common`
     - Single-tenant: `https://login.microsoftonline.com/<TENANT_ID>` (el Directory/tenant ID está en el Overview del Entra ID).
     - ⚠️ Debe **coincidir** con el "Supported account types" que elegiste en Azure (paso 1). Si en Azure pusiste single-tenant pero acá pones `common`, el login falla.
4. Verifica que la **Callback URL** que muestra Supabase sea exactamente la que registraste como Redirect URI en Azure (`https://uxxpzfsfcnqiwwdxoelm.supabase.co/auth/v1/callback`).
5. **Save**.

---

## 3. Allowlist de Redirect URLs en Supabase

El app, tras volver de Supabase, redirige a `${origin}/auth/sso-callback`. Ese destino debe estar permitido o Supabase corta el flujo.

1. Supabase Dashboard → **Authentication** → **URL Configuration**.
2. En **Redirect URLs**, confirma que estén (agregar las que falten):
   - `https://examlab.lovable.app/**` — cubre `https://examlab.lovable.app/auth/sso-callback`.
   - `http://localhost:3000/**` y `http://localhost:5173/**` — para desarrollo local.
   - Cualquier dominio de **preview** o **dominios de tenant personalizados** que se usen.
3. Revisa que el **Site URL** apunte al dominio de producción (`https://examlab.lovable.app`).
4. **Save**.

> `supabase/config.toml` **no aplica** al proyecto hosted gestionado por Lovable — la fuente de verdad de las URLs es el dashboard. (Opcional, solo para paridad en dev local: agregar `https://examlab.lovable.app/**` a `additional_redirect_urls` en `config.toml`.)

---

## 4. (Recomendado) Identity Linking — usuarios con contraseña que entran por Microsoft

El edge devuelve `duplicate_email` y bloquea el login cuando un email ya existe en `profiles` con **otro** `auth.id` (típico: usuario creado con contraseña por bulk-import que ahora intenta entrar por Microsoft).

Para que Supabase **enlace** la identidad Azure al usuario existente del mismo email:

1. Supabase Dashboard → **Authentication** → **Settings** (o **Providers**).
2. Habilita **"Link accounts with the same email address"** / **Account Linking** (según la versión del dashboard, puede estar en *Auth → Settings → User Signups* o en cada provider).
3. Si tu plan/versión no expone Account Linking: documenta para soporte que **el primer login de un usuario debe ser por el método con que se creó** (los creados con contraseña entran con contraseña; el SSO Microsoft queda para usuarios cuyo primer acceso sea OAuth), o que un admin vincule las identidades manualmente.

---

## 5. Checklist de prueba end-to-end

Prerrequisito: tener un usuario de prueba **pre-aprovisionado** con un `institutional_email` que coincida con un correo Microsoft real al que tengas acceso.

- [ ] **App Registration en Azure** existe con Redirect URI = `https://uxxpzfsfcnqiwwdxoelm.supabase.co/auth/v1/callback`.
- [ ] **Client secret (Value)** copiado y cargado en Supabase; expiración agendada.
- [ ] **Optional claim `email`** habilitado en Token configuration (paso 1.3).
- [ ] **Provider Azure habilitado** en Supabase con Client ID + Secret + Tenant URL coherente con el "account type" de Azure.
- [ ] **Redirect URLs** de Supabase incluyen `https://examlab.lovable.app/**`.
- [ ] El usuario de prueba existe en `profiles.institutional_email` (case-insensitive) con el mismo correo que la cuenta Microsoft.

Prueba el flujo feliz:

1. Abre `https://examlab.lovable.app` (o la URL de preview) en una ventana de incógnito.
2. En el login, click en el botón **Microsoft**.
3. Debe abrir el selector de cuentas de Microsoft (forzamos `prompt=select_account`). Elige la cuenta institucional de prueba.
4. Acepta el consentimiento si aparece.
5. Vuelves al app a `/auth/sso-callback` → ves "Verificando tu cuenta…".
6. ✅ **Éxito:** entras al dashboard del rol correspondiente.

Prueba los casos de rechazo (deben mostrar mensaje claro, no pantalla en blanco):

- [ ] **Correo NO aprovisionado:** entra con una cuenta Microsoft cuyo email **no** esté en `profiles` → mensaje "Tu cuenta no está registrada… pídele a un administrador que te cree primero" (`not_provisioned`). Verifica además que el `auth.user` huérfano se borró (no queda basura en Authentication → Users).
- [ ] **Email con cuenta de contraseña existente (sin Identity Linking):** → mensaje "Tu correo ya tiene una cuenta con contraseña…" (`duplicate_email`). Si habilitaste Account Linking (paso 4), este caso debería entrar OK en vez de rechazar.
- [ ] **Botón "Volver al inicio de sesión"** en la pantalla de rechazo funciona y limpia la sesión.

Diagnóstico si algo falla:

| Síntoma | Causa probable |
|---|---|
| Microsoft devuelve error `redirect_uri_mismatch` (AADSTS50011) | La Redirect URI en Azure no es exactamente la de Supabase `…/auth/v1/callback`. |
| `signInWithOAuth` falla al instante con "Could not start SSO" | Provider Azure no habilitado en Supabase, o Client ID/Secret mal cargados. |
| Vuelve al app pero se corta antes del callback | `${origin}/auth/sso-callback` no está en Redirect URLs de Supabase. |
| Usuario Microsoft válido es rechazado y `auth.users.email` está vacío | Falta el optional claim `email` en Azure (paso 1.3). |
| Login OK pero "tenant mismatch" | El `profiles.tenant_id`/slug del usuario no corresponde — problema de aprovisionamiento, no de SSO. |
| El secret dejó de funcionar de un día para otro | El **client secret de Azure expiró** → crear uno nuevo (paso 1.1) y recargar el Value en Supabase. |

---

## 6. Notas

- **No hay que tocar el repo** para habilitar Microsoft: el código ya está completo y es provider-agnostic. (`supabase/config.toml` a propósito **no** tiene secciones `[auth.external.*]` — los providers viven en el dashboard de Supabase en el modelo Lovable.)
- Diferenciar del OAuth de **Google Calendar** (`GOOGLE_OAUTH_CLIENT_ID/SECRET`): esa es otra integración, **no** tiene relación con el login SSO de Microsoft/Google.
- El mismo flujo (y este mismo edge `auth-sso-verify`) aplica a **Google**: el provider Google ya está configurado de forma análoga en el dashboard.
