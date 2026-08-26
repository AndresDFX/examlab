# Acuerdo pedagógico con conformidad registrada — plan de diseño

> Producido por el workflow `acuerdo-pedagogico-firmas` (mapeo + frente de ataque + síntesis).
>
> ⚠ **LEER ESTO ANTES DE EJECUTAR EL PLAN — se construyó otra cosa, más liviana.**
> No es este plan: es firma sobre el informe YA generado, sin módulo nuevo.
> `report_signatures` (mig `20261780000000`) + enlace público personal
> (`20261860000000`) + la ruta `/acuerdo/$token`. El docente manda a firmar desde
> Informes, al alumno le llega notificación **y correo** con su enlace, y ahí lee el
> documento completo y firma.
>
> Lo que este plan tiene y eso NO, por si se retoma:
> **D1** (tabla propia con versiones congeladas — lo construido firma contra
> `generated_reports.html`, que es mutable: el hash deja rastro pero nada impide
> re-generar el informe después), **D8** (no se guarda snapshot de identidad: el
> nombre se lee VIVO de `profiles`, y `profiles_update_self` deja renombrarse
> después de firmar), **D11** (no se exige `must_change_password = false` —
> deliberado: los alumnos importados en lote siguen con la clave temporal y el guard
> los dejaría afuera; el costo es que la clave temporal es la misma para todos),
> **D13** ("Aceptar con observaciones" no existe: solo se puede firmar) y **D15**
> (justo lo contrario: SÍ hay enlace sin sesión, y el enlace ES la credencial —
> queda registrado en `signed_via`).
>
> O sea: sirve para constancia interna, **no** para nada que tenga que sostenerse
> ante un tercero. Si hace falta eso, este plan es el camino.
>
> **NO implementado todavía.** Las afirmaciones están verificadas por los agentes contra
> el código; las que sostienen decisiones grandes conviene re-verificarlas antes de
> ejecutar.

# Plan — Acuerdo pedagógico con conformidad registrada por el estudiante

Baseline verificado: `npx tsc --noEmit` = 1 error preexistente (`vite.config.ts(79,3)`). Última migración en el árbol: `20261730000000_uniaj_diagnosticas_max_warnings_5.sql` → la nueva es **`20261740000000_course_agreements.sql`**.

---

## 0. Lo que se puede afirmar y lo que no (esto gobierna todo el diseño)

**Se puede afirmar, literalmente:** que *la cuenta* X registró conformidad, en el instante del **servidor** (`now()` dentro de un RPC `SECURITY DEFINER`, nunca una fecha del cliente), sobre **esta versión exacta del texto** (huella SHA-256 de un snapshot congelado), desde esta IP y este navegador, y que el registro no tiene camino de edición desde la app.

**No se puede afirmar:** que fue esa persona (la clave temporal es la fija `Temporal#123` para todo usuario nuevo, no hay MFA, y existen dos flujos de impersonación de staff donde `auth.uid()` **es** el usuario impersonado); no repudio; sellado de tiempo confiable (el reloj es de la propia base, no de una TSA); inalterabilidad absoluta (`service_role` bypassa RLS y triggers de política — el hash deja **rastro**, no garantía); ni equivalencia legal a una firma manuscrita.

**Palabras prohibidas en texto visible:** "firma digital", "firma electrónica" (término definido en Colombia por Ley 527/1999 + Decreto 2364/2012, exige entidad certificadora), "certificado", "legalmente vinculante", "válido ante…", "no repudiable", "identidad verificada", y toda comparación con ZapSign/DocuSign. El nombre del acto es **"registrar conformidad"**; el artefacto es **"constancia interna"**.

---

## 1. Decisiones (cada una con su por qué en una línea)

| # | Decisión | Por qué |
|---|---|---|
| D1 | **Tabla propia** (`course_agreements` + `course_agreement_versions` + `course_agreement_signatures`), NO `report_templates` como fuente firmada | La plantilla es mutable y se renderiza desde datos VIVOS (`buildReportContext` lee roster/pesos/horario en cada impresión): firmar contra ella es firmar un blanco móvil — el bug exacto que `20260619000000_immutable_acta_grades.sql` tuvo que arreglar en actas. |
| D2 | La plantilla global **"Acuerdo Pedagógico" no se toca** | Las dos migraciones previas (`20260611010000`, `20260612010000`) condicionan su UPDATE a que el body siga siendo el del seed: si algún Admin la personalizó ya hay dos realidades, y editarla por migración crea una tercera. Sigue sirviendo para quien firma en papel. |
| D3 | Se usa como **semilla de autoría**: botón "Traer de la plantilla" → `buildReportContext` + `renderTemplate` + `stripRosterBlock` → texto plano en el borrador | Resuelve el trabajo oculto (los 4 `answer-box` sustantivos hoy son espacio en blanco, no dato) sin inventar un segundo editor, y congela los datos vivos en el momento de autoría. |
| D4 | El **borrador es mutable** (`course_agreements.draft_body_html`); publicar **congela una copia** en una fila de versión nueva | El typo se corrige editando el borrador y publicando v2 — no hace falta un trigger "inmutable solo si hay firmas" ni bloquear ediciones cosméticas (el modo de falla que documenta `_tg_poll_question_immutable_with_responses`). |
| D5 | La huella cubre **texto + CSS + tamaño/orientación**, no solo el body | Un CSS con `display:none` cambia lo que la persona leyó sin cambiar el body: hashear solo el body haría la huella mentirosa. |
| D6 | La huella se calcula **solo en SQL** (`extensions.digest(..., 'sha256')`), nunca en TS | `JSON.stringify`/concatenación en TS y en SQL divergen con facilidad, y el peor fallo posible es un verificador que reporta manipulación donde no hubo. La receta canónica queda publicada y testeada contra el texto de la migración. |
| D7 | El **roster de firmas NO es parte del documento congelado** | El roster crece; si entrara al hash, la huella cambiaría con cada firma. Se compone al exportar, desde las filas reales. |
| D8 | Por firma se guarda: `user_id` + **snapshot de identidad** (nombre, correo institucional, documento, código leídos server-side de `profiles`), `content_hash` + `version_no`, `status`, `observations`, `signed_at` (servidor), `signed_ip`, `signed_user_agent` | `profiles_update_self` deja al alumno renombrarse por REST después de firmar (`tg_guard_profile_self_escalation` **no** congela `full_name` ni `documento`) → sin snapshot la evidencia se repudia sola. IP/UA porque una firma cuya única prueba es "la fila existe" es débil justo en el escenario para el que se construye. |
| D9 | **Escritura solo por RPC**: las tres tablas sin policy de INSERT/UPDATE/DELETE + `REVOKE INSERT, UPDATE, DELETE … FROM anon, authenticated` (excepto `course_agreements`, que sí acepta escritura de staff porque su borrador no es evidencia) | Molde `content_file_progress`/`course_actas`: con una policy owner-writable el alumno POSTea su propio `signed_at`. La RLS de Supabase es por FILA y `authenticated` tiene UPDATE de todas las columnas — ya fue explotado dos veces en este repo (notas y `profiles`). |
| D10 | El RPC de firma **no tiene parámetro de usuario**: solo `auth.uid()` | Una vez que el parámetro existe, la evidencia no distingue una firma propia de una delegada. |
| D11 | El RPC de firma **exige `profiles.must_change_password = false`** | Mientras el alumno no eligió su contraseña, cualquiera con el patrón de correos institucionales firma por él; sin este guard la constancia es decorativa. |
| D12 | **No es gate.** Ni el curso, ni las notas, ni las entregas, ni mensajes/soporte | Consentimiento bajo amenaza de perder el curso no es consentimiento y destruye el valor probatorio que se busca. En su lugar: banner persistente + "faltan N" + recordatorio con tope de 1/24h server-side. |
| D13 | Existe salida **"Aceptar con observaciones"** (`status='con_observaciones'` + texto obligatorio) | Un documento que solo se puede aceptar no es un acuerdo; sin esta salida, quien no está de acuerdo solo puede callarse y el roster lo pinta igual que a quien nunca entró. |
| D14 | **Sin trazo manuscrito** | No prueba identidad (nadie tiene un especimen de la letra del estudiante) y su efecto real es hacer que el registro parezca más probatorio de lo que es; además cuesta un bucket privado nuevo con la trampa del 403-sin-policy-de-SELECT. |
| D15 | **Sin verificación pública** (`/verify/...`) en v1 | Solo hace falta si el documento sale de la institución, y el precedente de certificados arrastra dos defectos que habría que arreglar primero (hash con `now()` adentro → no recomputable; y la página verifica "existe un registro", no "este PDF es auténtico"). |
| D16 | Anular = **UPDATE** (`revoked_at/by/reason`), nunca DELETE, y el audit va **DENTRO** del RPC | Anti-moldes vivos: `teacher_clear_poll_response_for_user` hard-deletea sin rastro, y el borrado de actas audita desde el navegador (un DELETE por REST no deja nada). |
| D17 | Solo **staff** anula; el estudiante no | Retirar la conformidad después del hecho es otro acto; si se permite en silencio, el registro deja de servir para lo único que se construyó. |
| D18 | **No es la 9ª entidad de Papelera**: `deleted_at` = "retirado", gestionado desde el propio módulo | El set de 8 está cableado en 6 lugares sincronizados y agregar una novena abriría un camino de hard-delete sobre las firmas. |
| D19 | FKs a `courses` en **`ON DELETE SET NULL`** + fila de firma **autosuficiente**; `tenant_id` denormalizado **sin FK** | `purge_deleted_items` hace DELETE físico de `courses` a los 30 días: con CASCADE la evidencia entera desaparece sola (bug real que `20261240000000` tuvo que arreglar en certificados). `tenant_id` sin FK evita romper `hard_delete_tenant` con un RESTRICT nuevo, y sostiene el scope de RLS cuando `course_id` ya es NULL. |
| D20 | Superficie del alumno: **card en el tablero del curso** + ruta de detalle `/app/student/agreement/$agreementId`, **sin módulo nuevo** | Informes no tiene ninguna superficie de estudiante (tres candados: seed de `module_visibility`, `rbac.ts:71`, y la RLS de `generated_reports` que dice "el estudiante NO ve nada"). Colgarse del tablero evita el checklist de 10 pasos del catálogo de módulos y el guardrail asociado. |
| D21 | No hace falta cerrar el gap de `report-context.ts:651` (el `id` descartado en `estudiantes[]`) | El roster de conformidades lo renderiza el módulo nuevo, no una plantilla. El gap queda documentado como latente para quien quiera el estado dentro de una plantilla. |

---

## 2. La migración — `supabase/migrations/20261740000000_course_agreements.sql`

Toda la migración va dentro de un `DO $mig$` con la defensiva de dependencias al inicio (patrón de `20261490000000`), y es idempotente (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` antes de cada `CREATE POLICY`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`) — autocontenida a propósito, para no repetir la bomba de replay de `20260608000000` vs `20260528010000`.

```sql
-- ══════════════════════════════════════════════════════════════════════
-- Acuerdo pedagógico con CONFORMIDAD REGISTRADA por el estudiante.
--
-- Qué ES: constancia interna de que una CUENTA autenticada declaró estar de
-- acuerdo, en la hora del servidor, sobre una VERSIÓN congelada del texto.
-- Qué NO ES: firma digital / electrónica certificada. No hay PKI, ni entidad
-- certificadora, ni sellado de tiempo confiable, ni acreditación de la identidad
-- de la persona detrás de la cuenta (la clave temporal de todo usuario nuevo es
-- la fija 'Temporal#123' y no hay MFA). Los textos de la UI dicen exactamente eso.
--
-- RECETA CANÓNICA DE LA HUELLA (única fuente; replicada literal en
-- src/modules/agreements/agreement-state.ts::canonicalHashInput, con un test que
-- lee ESTE archivo del disco y falla si divergen):
--   content_hash = sha256(
--     version_no::text || E'\n' || title || E'\n' ||
--     page_size || ' ' || page_orientation || E'\n' || css || E'\n' || body_html
--   ) en hex minúscula.
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.course_enrollments') IS NULL
     OR to_regclass('public.course_teachers') IS NULL THEN
    RAISE NOTICE 'skip course_agreements: tabla(s) ausente(s)';
    RETURN;
  END IF;

  -- ── Tablas ──────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS public.course_agreements (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- SET NULL + nullable: purge_deleted_items borra el curso a los 30 días y la
    -- constancia debe sobrevivir (lección de 20261240000000 en certificates).
    course_id          uuid REFERENCES public.courses(id) ON DELETE SET NULL,
    -- Denormalizado SIN FK: sostiene el scope de RLS cuando course_id ya es NULL,
    -- y una FK RESTRICT nueva rompería hard_delete_tenant.
    tenant_id          uuid NOT NULL,
    title              text NOT NULL DEFAULT 'Acuerdo pedagógico',
    -- MUTABLE por diseño: el borrador no es evidencia. Publicar congela una copia.
    draft_body_html    text NOT NULL DEFAULT '',
    draft_css          text NOT NULL DEFAULT '',
    page_orientation   text NOT NULL DEFAULT 'portrait'
                         CHECK (page_orientation IN ('portrait','landscape')),
    page_size          text NOT NULL DEFAULT 'A4'
                         CHECK (page_size IN ('A4','letter')),
    current_version_id uuid,                    -- FK circular: se agrega abajo
    status             text NOT NULL DEFAULT 'borrador'
                         CHECK (status IN ('borrador','publicado','retirado')),
    created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz            -- "retirado". NO es la Papelera.
  );

  CREATE TABLE IF NOT EXISTS public.course_agreement_versions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id     uuid NOT NULL REFERENCES public.course_agreements(id) ON DELETE RESTRICT,
    tenant_id        uuid NOT NULL,
    version_no       integer NOT NULL,
    title            text NOT NULL,
    body_html        text NOT NULL,   -- FRAGMENTO renderizado y congelado
    css              text NOT NULL DEFAULT '',
    page_orientation text NOT NULL DEFAULT 'portrait',
    page_size        text NOT NULL DEFAULT 'A4',
    content_hash     text NOT NULL,   -- sha256 hex (receta arriba)
    -- Una versión existe solo si está publicada (el borrador vive en el padre):
    -- así todo guard "existe" ya implica "publicada".
    published_at     timestamptz NOT NULL DEFAULT now(),
    published_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    course_name      text,            -- snapshots (sobreviven al purge del curso)
    course_period    text,
    teacher_names    text[],
    UNIQUE (agreement_id, version_no)
  );

  CREATE TABLE IF NOT EXISTS public.course_agreement_signatures (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_version_id uuid NOT NULL REFERENCES public.course_agreement_versions(id) ON DELETE RESTRICT,
    agreement_id         uuid NOT NULL REFERENCES public.course_agreements(id) ON DELETE RESTRICT,
    course_id            uuid REFERENCES public.courses(id) ON DELETE SET NULL,
    tenant_id            uuid NOT NULL,
    user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Snapshot de identidad: leído SERVER-SIDE de profiles, nunca del payload.
    -- profiles_update_self deja al alumno renombrarse después de firmar.
    signer_name          text NOT NULL,
    signer_email         text,
    signer_document      text,
    signer_codigo        text,
    -- Snapshot del documento
    content_hash         text NOT NULL,
    version_no           integer NOT NULL,
    course_name          text,
    course_period        text,
    -- El acto
    status               text NOT NULL CHECK (status IN ('aceptado','con_observaciones')),
    observations         text CHECK (observations IS NULL OR char_length(observations) <= 2000),
    signed_at            timestamptz NOT NULL DEFAULT now(),
    signed_ip            text,
    signed_user_agent    text,
    -- Anulación (nunca DELETE)
    revoked_at           timestamptz,
    revoked_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    revoke_reason        text
  );

  -- FK circular current_version_id → versions
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_agreements_current_version_fk') THEN
    ALTER TABLE public.course_agreements
      ADD CONSTRAINT course_agreements_current_version_fk
      FOREIGN KEY (current_version_id)
      REFERENCES public.course_agreement_versions(id) ON DELETE RESTRICT;
  END IF;

  -- ── Índices ─────────────────────────────────────────────────────────
  -- Un acuerdo VIVO por curso.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_course_agreements_course_active
    ON public.course_agreements(course_id)
    WHERE course_id IS NOT NULL AND deleted_at IS NULL;
  -- Una conformidad ACTIVA por (versión, estudiante). Las anuladas quedan
  -- como historia y habilitan volver a registrar (patrón de certificates).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_sig_active
    ON public.course_agreement_signatures(agreement_version_id, user_id)
    WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_agreement_sig_agreement
    ON public.course_agreement_signatures(agreement_id);
  CREATE INDEX IF NOT EXISTS idx_agreement_sig_user
    ON public.course_agreement_signatures(user_id);
  CREATE INDEX IF NOT EXISTS idx_agreement_versions_agreement
    ON public.course_agreement_versions(agreement_id, version_no DESC);
END $mig$;
```

### 2.1 Helpers de scope (nombrados, reusados por policies y RPCs)

```sql
-- Staff que puede ver/gestionar un acuerdo. Prohibido USING(true) y prohibida
-- toda rama has_role() sin tenant: is_admin_of_course_tenant ya trae SuperAdmin,
-- y la rama por tenant_id sobrevive a course_id = NULL tras el purge.
-- A propósito NO usa course_in_my_tenant en la rama del docente: ese helper es
-- tenant-wide y reabriría el bug que arregló 20261180000000.
CREATE OR REPLACE FUNCTION public._agreement_staff(_agreement_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.course_agreements a
    WHERE a.id = _agreement_id
      AND (
        (a.course_id IS NOT NULL AND public._teaches_course(a.course_id))
        OR (a.course_id IS NOT NULL AND public.is_admin_of_course_tenant(a.course_id))
        OR (public.has_role(auth.uid(), 'Admin'::app_role)
            AND a.tenant_id = public.current_tenant_id())
        OR public.is_super_admin()
      )
  );
$fn$;

CREATE OR REPLACE FUNCTION public._agreement_enrolled(_agreement_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.course_agreements a
    WHERE a.id = _agreement_id
      AND a.course_id IS NOT NULL
      AND public._is_enrolled_in_course(a.course_id)
  );
$fn$;

-- User-agent del request (GUC de PostgREST), hermano de _audit_client_ip().
-- ⚠ VERIFICAR con un SQL one-shot antes de depender de él:
--   SELECT current_setting('request.headers', true)::json ->> 'user-agent';
-- Si el header no llega, la columna queda NULL — NUNCA se acepta del cliente
-- (es spoofeable y no aportaría nada).
CREATE OR REPLACE FUNCTION public._signature_user_agent()
RETURNS text LANGUAGE plpgsql STABLE
AS $fn$
DECLARE h text; j json;
BEGIN
  h := current_setting('request.headers', true);
  IF h IS NULL OR h = '' THEN RETURN NULL; END IF;
  BEGIN j := h::json; EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
  RETURN NULLIF(left(COALESCE(j ->> 'user-agent', ''), 500), '');
END;
$fn$;

REVOKE ALL ON FUNCTION public._agreement_staff(uuid)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._agreement_enrolled(uuid)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._signature_user_agent()     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._agreement_staff(uuid)    TO authenticated;
GRANT EXECUTE ON FUNCTION public._agreement_enrolled(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._signature_user_agent()   TO authenticated;
```

### 2.2 RLS

```sql
ALTER TABLE public.course_agreements            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_agreement_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_agreement_signatures  ENABLE ROW LEVEL SECURITY;

-- ── course_agreements: staff escribe el BORRADOR (no es evidencia) ──
DROP POLICY IF EXISTS course_agreements_select ON public.course_agreements;
CREATE POLICY course_agreements_select ON public.course_agreements
  FOR SELECT USING (
    public._agreement_staff(id) OR public._agreement_enrolled(id)
  );

DROP POLICY IF EXISTS course_agreements_insert ON public.course_agreements;
CREATE POLICY course_agreements_insert ON public.course_agreements
  FOR INSERT WITH CHECK (
    course_id IS NOT NULL
    AND (
      (public._teaches_course(course_id) AND public.has_role(auth.uid(),'Docente'::app_role))
      OR public.is_admin_of_course_tenant(course_id)
    )
  );

DROP POLICY IF EXISTS course_agreements_update ON public.course_agreements;
CREATE POLICY course_agreements_update ON public.course_agreements
  FOR UPDATE
  USING (public._agreement_staff(id))
  WITH CHECK (public._agreement_staff(id));

DROP POLICY IF EXISTS course_agreements_delete ON public.course_agreements;
CREATE POLICY course_agreements_delete ON public.course_agreements
  FOR DELETE USING (public._agreement_staff(id));   -- trigger bloquea si hay firmas

-- ── versions: SOLO lectura. El INSERT lo hace el RPC de publicación ──
DROP POLICY IF EXISTS course_agreement_versions_select ON public.course_agreement_versions;
CREATE POLICY course_agreement_versions_select ON public.course_agreement_versions
  FOR SELECT USING (
    public._agreement_staff(agreement_id) OR public._agreement_enrolled(agreement_id)
  );
REVOKE INSERT, UPDATE, DELETE ON public.course_agreement_versions FROM anon, authenticated;

-- ── signatures: SOLO lectura, y el alumno solo LA SUYA ──
-- Sin rama de "matriculado": la fila lleva IP y user-agent, un alumno no lee la
-- de un compañero. El "12 de 30 ya aceptaron" sale del RPC agregado.
DROP POLICY IF EXISTS course_agreement_signatures_select ON public.course_agreement_signatures;
CREATE POLICY course_agreement_signatures_select ON public.course_agreement_signatures
  FOR SELECT USING (
    user_id = auth.uid() OR public._agreement_staff(agreement_id)
  );
REVOKE INSERT, UPDATE, DELETE ON public.course_agreement_signatures FROM anon, authenticated;

COMMENT ON TABLE public.course_agreement_signatures IS
  'Conformidad registrada del estudiante con una VERSIÓN del acuerdo. Escritura SOLO por sign_course_agreement() / revoke_course_agreement_signature(): sin policy de INSERT/UPDATE/DELETE a propósito — con una owner-writable el alumno POSTearía su propio signed_at. NO es una firma digital.';
```

### 2.3 Triggers

```sql
-- tenant_id derivado del curso, no del cliente.
CREATE OR REPLACE FUNCTION public._tg_agreement_set_tenant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  SELECT c.tenant_id INTO NEW.tenant_id FROM public.courses c WHERE c.id = NEW.course_id;
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la institución del curso.';
  END IF;
  NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  RETURN NEW;
END $fn$;

-- UPDATE del acuerdo: tenant inmutable y current_version_id solo de ESTE acuerdo.
CREATE OR REPLACE FUNCTION public._tg_agreement_guard_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  NEW.tenant_id := OLD.tenant_id;
  NEW.updated_at := now();
  IF NEW.current_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.course_agreement_versions v
                     WHERE v.id = NEW.current_version_id AND v.agreement_id = OLD.id) THEN
    RAISE EXCEPTION 'La versión indicada no pertenece a este acuerdo.';
  END IF;
  RETURN NEW;
END $fn$;

-- Un acuerdo con conformidades registradas no se borra: se retira.
CREATE OR REPLACE FUNCTION public._tg_agreement_block_delete_with_signatures()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.course_agreement_signatures s WHERE s.agreement_id = OLD.id) THEN
    RAISE EXCEPTION 'Este acuerdo ya tiene conformidades registradas: no se puede eliminar. Retiralo en su lugar.';
  END IF;
  RETURN OLD;
END $fn$;

-- Versión publicada = inmutable en lo que tiene SIGNIFICADO.
CREATE OR REPLACE FUNCTION public._tg_agreement_version_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NEW.body_html    IS DISTINCT FROM OLD.body_html
  OR NEW.css          IS DISTINCT FROM OLD.css
  OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
  OR NEW.version_no   IS DISTINCT FROM OLD.version_no
  OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'Una versión publicada del acuerdo no se modifica. Publicá una versión nueva.';
  END IF;
  RETURN NEW;
END $fn$;

-- Firma: solo la ANULACIÓN puede cambiar. Nada más.
CREATE OR REPLACE FUNCTION public._tg_agreement_signature_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF (NEW.id, NEW.agreement_version_id, NEW.user_id, NEW.signer_name, NEW.content_hash,
      NEW.version_no, NEW.status, NEW.observations, NEW.signed_at, NEW.signed_ip,
      NEW.signed_user_agent)
     IS DISTINCT FROM
     (OLD.id, OLD.agreement_version_id, OLD.user_id, OLD.signer_name, OLD.content_hash,
      OLD.version_no, OLD.status, OLD.observations, OLD.signed_at, OLD.signed_ip,
      OLD.signed_user_agent) THEN
    RAISE EXCEPTION 'El registro de conformidad no se modifica. Solo se puede anular.';
  END IF;
  RETURN NEW;
END $fn$;
```

Triggers montados con `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` (`BEFORE INSERT` / `BEFORE UPDATE` / `BEFORE DELETE` según corresponde).

> **A propósito NO hay trigger `BEFORE DELETE` que bloquee el borrado de una firma:** el `ON DELETE CASCADE` de `user_id → auth.users` lo dispararía y rompería `hard_delete_tenant`. La defensa del DELETE es la ausencia de policy + el `REVOKE`.

### 2.4 RPCs `SECURITY DEFINER`

Todos con `SET search_path TO 'public', 'extensions'` **y** prefijo `extensions.digest(...)` (las dos defensas: el `search_path` solo ya rompió `compute_attendance_code` e `issue_certificate`), y todos cerrando con `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated;` — porque el GRANT no es la frontera (256 de 305 funciones `SECURITY DEFINER` del proyecto tienen `anon=X` en su ACL) y los guards viven en el CUERPO.

**a) `publish_course_agreement(_agreement_id uuid, _title text, _body_html text, _css text, _page_orientation text, _page_size text) RETURNS uuid`**

Guards, en orden: `auth.uid()` no nulo → acuerdo existe (`SELECT … FOR UPDATE`) → `a.deleted_at IS NULL` → curso existe y `courses.deleted_at IS NULL` → autorización (`_teaches_course AND has_role('Docente')` OR `is_admin_of_course_tenant`) → `_body_html` no vacío y `char_length ≤ 400000` → `_page_orientation IN ('portrait','landscape')`, `_page_size IN ('A4','letter')` → calcula `version_no = COALESCE(max,0)+1` → `content_hash = encode(extensions.digest(<receta canónica>, 'sha256'),'hex')` → snapshots (`course_name`, `course_period` desde `academic_periods`/`courses`, `teacher_names` desde `course_teachers ⋈ profiles`) → `INSERT` versión → `UPDATE` acuerdo (`current_version_id`, `status='publicado'`, `title`) → notifica a los matriculados (`kind='agreement'`, `link='/app/student/agreement/'||_agreement_id`) → `INSERT audit_logs` (`category='integrity'`, `action='agreement.published'`, `severity='info'`, metadata con `version_no`, `content_hash`, `ip = public._audit_client_ip()`) → `RETURN` id de versión.

**b) `sign_course_agreement(_version_id uuid, _status text DEFAULT 'aceptado', _observations text DEFAULT NULL) RETURNS uuid`** — el corazón. Sin parámetro de usuario.

```sql
CREATE OR REPLACE FUNCTION public.sign_course_agreement(
  _version_id   uuid,
  _status       text DEFAULT 'aceptado',
  _observations text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v      record;
  v_prof record;
  v_id   uuid;
BEGIN
  -- 1. Autenticación (el GRANT no alcanza: anon=X está en el ACL por default).
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Debés iniciar sesión para registrar tu conformidad.';
  END IF;

  -- 2..5. Versión + acuerdo + curso, con los guards de papelera SERVER-SIDE
  -- (el filtro del cliente no cuenta — bug #6 de issue_certificate).
  SELECT ver.id, ver.agreement_id, ver.version_no, ver.content_hash,
         ver.course_name, ver.course_period,
         a.course_id, a.tenant_id, a.current_version_id, a.deleted_at AS a_deleted,
         c.deleted_at AS c_deleted
    INTO v
    FROM public.course_agreement_versions ver
    JOIN public.course_agreements a ON a.id = ver.agreement_id
    LEFT JOIN public.courses c      ON c.id = a.course_id
   WHERE ver.id = _version_id;

  IF v.id IS NULL THEN
    RAISE EXCEPTION 'El acuerdo no está disponible.';
  END IF;
  IF v.a_deleted IS NOT NULL OR v.c_deleted IS NOT NULL OR v.course_id IS NULL THEN
    RAISE EXCEPTION 'El acuerdo no está disponible.';
  END IF;

  -- 6. Solo la versión VIGENTE se puede aceptar.
  IF v.current_version_id IS DISTINCT FROM _version_id THEN
    RAISE EXCEPTION 'Hay una versión más reciente del acuerdo. Recargá la página.';
  END IF;

  -- 7. Matrícula (helper existente, no re-inlinear el EXISTS).
  IF NOT public._is_enrolled_in_course(v.course_id) THEN
    RAISE EXCEPTION 'No estás matriculado en este curso.';
  END IF;

  -- 8. Identidad mínima: que la persona haya elegido su propia contraseña.
  -- La temporal es la MISMA para todo usuario nuevo; sin este guard cualquiera
  -- que sepa el patrón de correos institucionales registra conformidad por otro.
  SELECT p.full_name, p.institutional_email, p.documento, p.codigo,
         COALESCE(p.must_change_password, false) AS must_change
    INTO v_prof
    FROM public.profiles p WHERE p.id = v_uid;

  IF v_prof.must_change THEN
    RAISE EXCEPTION 'Cambiá tu contraseña temporal antes de registrar tu conformidad.';
  END IF;

  -- 9. Validación del acto.
  IF _status NOT IN ('aceptado','con_observaciones') THEN
    RAISE EXCEPTION 'Opción no válida.';
  END IF;
  IF _status = 'con_observaciones'
     AND (_observations IS NULL OR btrim(_observations) = '') THEN
    RAISE EXCEPTION 'Escribí tu observación para poder registrarla.';
  END IF;
  IF _observations IS NOT NULL AND char_length(_observations) > 2000 THEN
    RAISE EXCEPTION 'La observación no puede pasar de 2000 caracteres.';
  END IF;

  -- 10. Solo alta: nunca UPSERT (identidad adivinable ⇒ no se pisa lo ajeno).
  IF EXISTS (SELECT 1 FROM public.course_agreement_signatures s
              WHERE s.agreement_version_id = _version_id
                AND s.user_id = v_uid AND s.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Ya registraste tu conformidad con esta versión del acuerdo.';
  END IF;

  -- 11..12. Snapshot + inserción. signed_at = reloj del SERVIDOR.
  INSERT INTO public.course_agreement_signatures (
    agreement_version_id, agreement_id, course_id, tenant_id, user_id,
    signer_name, signer_email, signer_document, signer_codigo,
    content_hash, version_no, course_name, course_period,
    status, observations, signed_at, signed_ip, signed_user_agent
  ) VALUES (
    _version_id, v.agreement_id, v.course_id, v.tenant_id, v_uid,
    COALESCE(v_prof.full_name, 'Estudiante'), v_prof.institutional_email,
    v_prof.documento, v_prof.codigo,
    v.content_hash, v.version_no, v.course_name, v.course_period,
    _status, NULLIF(btrim(_observations), ''), now(),
    public._audit_client_ip(), public._signature_user_agent()
  ) RETURNING id INTO v_id;

  -- 13. Rastro DENTRO del RPC (el patrón del acta audita desde el cliente:
  -- un REST directo no deja nada).
  INSERT INTO public.audit_logs (
    actor_id, actor_role, action, category, severity,
    entity_type, entity_id, course_id, course_name, metadata
  ) VALUES (
    v_uid, 'Estudiante', 'agreement.signed', 'integrity', 'info',
    'course_agreement_signature', v_id::text, v.course_id, v.course_name,
    jsonb_build_object('version_no', v.version_no, 'content_hash', v.content_hash,
                       'status', _status, 'ip', public._audit_client_ip())
  );

  RETURN v_id;
END $fn$;

REVOKE ALL ON FUNCTION public.sign_course_agreement(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_course_agreement(uuid, text, text) TO authenticated;
```

**c) `revoke_course_agreement_signature(_signature_id uuid, _reason text DEFAULT NULL) RETURNS void`** — `auth.uid()` no nulo → firma existe → no ya anulada ("Esa conformidad ya está anulada.") → `_agreement_staff(agreement_id)` → `UPDATE` (`revoked_at=now()`, `revoked_by=auth.uid()`, `revoke_reason=_reason`) → `audit_logs` `action='agreement.signature_revoked'`, `severity='warning'` → notificación al estudiante (molde `revoke_certificate`: el afectado se entera). **Nunca DELETE.**

**d) `remind_course_agreement_pending(_agreement_id uuid) RETURNS jsonb`** → `{"sent": n, "skipped": m}`. Guards: autenticado → acuerdo vivo + curso vivo → `_agreement_staff` → `current_version_id NOT NULL`. Inserta notificación a cada matriculado **sin** conformidad activa en la versión vigente, **salvo** los que ya recibieron una del mismo acuerdo en las últimas 24 h (`EXISTS` sobre `notifications` con `kind='agreement'` + `link` del acuerdo + `created_at > now() - interval '24 hours'`). Sin el tope, "recordar" repetido es coerción con pasos extra.

**e) `course_agreement_stats(_agreement_id uuid) RETURNS TABLE(total_enrolled integer, signed_current integer, signed_previous integer, pending integer)`** — guard `_agreement_staff(_agreement_id) OR _agreement_enrolled(_agreement_id)`. Sirve para que el alumno vea el agregado sin leer filas ajenas. *Ojo:* si más adelante se agrega una columna al `RETURNS TABLE`, hace falta `DROP FUNCTION` antes del `CREATE` (Postgres no cambia el row type con `OR REPLACE`).

### 2.5 Correos (invariante de 3 lados) y limpieza de tenant

En la **misma** migración: re-crear `public._notification_kind_emails(text,text)` (respetando las dos ramas del `DO` de `20261490000000`) agregando `'agreement'` al `IN (...)`, y sembrar `email_settings.enabled_kinds.agreement = true`. Sincronizar en el mismo commit:

- `src/modules/notifications/notification-email.ts` → `CRITICAL_KINDS` += `"agreement"`.
- `supabase/functions/send-email/index.ts` → `CRITICAL_KINDS` += `"agreement"`.
- `src/modules/admin/AdminEmailSettingsPanel.tsx` → switch "Acuerdo pedagógico".

Y agregar a `hard_delete_tenant` (migración aparte o la misma), antes del `DELETE FROM courses`:

```sql
DELETE FROM public.course_agreement_signatures WHERE tenant_id = _tenant_id;
DELETE FROM public.course_agreement_versions   WHERE tenant_id = _tenant_id;
DELETE FROM public.course_agreements           WHERE tenant_id = _tenant_id;
```

(sin esto quedan filas huérfanas: `tenant_id` no tiene FK, justamente para no meter un RESTRICT nuevo).

---

## 3. La UI

### 3.1 Docente — tercer tab en `/app/teacher/reports`

Archivo nuevo: **`src/modules/agreements/CourseAgreementPanel.tsx`** (el panel entero; `app.teacher.reports.tsx` ya tiene 1858 líneas). Montaje en `src/routes/app.teacher.reports.tsx`:

- `useState<"plantillas" | "informes" | "acuerdo">` y `<TabsTrigger value="acuerdo">` con ícono **`FileSignature`** (nuevo concepto → ícono propio y único; se reusa en el tab, en la card del alumno y en la notificación).
- **P4:** el `actions` del `PageHeader` (hoy "Subir Word" + "Nueva plantilla" primario) se renderiza solo cuando `tab !== "acuerdo"`; el primario del tab vive dentro del panel. Dos primarios visibles sin scroll = la pantalla pierde jerarquía.
- **P1:** el root del panel lleva solo `space-y-5`.

Dentro del panel:

1. **Selector de curso** — `fetchScopedCourses(activeRole, roles, user.id, "id, name")` de `@/modules/courses/course-scope` (obligatorio: sin esto un docente vería el acuerdo de cursos que no dicta). Docente sin cursos → `<NoAssignedCoursesNotice />`.
2. **Estado** — `Card` con `StatusBadge` (`borrador`/`publicado`/`retirado`), "Versión N · publicada el <fecha>" (`formatDateTime`) y el **Código de verificación** (12 hex, con `HelpHint`: "Identifica la versión exacta del texto que aceptaron los estudiantes").
3. **Editor del borrador** — `RichTextEditor` (`src/modules/reports/RichTextEditor.tsx`, ya existe) + botón `variant="outline"` **"Traer de la plantilla Acuerdo Pedagógico"** → `buildReportContext({courseId, periodo})` + `renderTemplate(stripRosterBlock(template.body_html), ctx)`. Autoguardado del borrador con `debounce` 1200 ms **con flush-on-unmount** (patrón `TextPageEditor`/`CodePageEditor`; sin flush se pierde el último cambio al cambiar de tab).
4. **Acción primaria única** — `<Button>` "Publicar acuerdo" (o "Publicar versión N"), con `useConfirm({ tone: "warning" })`. Cuando ya está publicado, el primario pasa a ser **"Recordar a los pendientes (N)"** y publicar-de-nuevo baja a `variant="outline"`.
5. **Roster** — `Table resizable` con `useTableSort` + `usePagination` + `DataPagination` + `TableSkeleton` + `TableEmpty`. Flujo obligatorio **filtrar → ordenar → paginar**, con `sort.resetKey` appendeado al `resetKey` de la paginación. Columnas (**P7:** 8 columnas, 160px declarados):

   | Col | Ancho | Notas |
   |---|---|---|
   | Estudiante | `flex-1` | única celda flexible; sin adornos `shrink-0` |
   | Código | `w-28 hidden md:table-cell` | |
   | Estado | `w-40` | `StatusBadge` (`aceptado` / `con_observaciones` / `pendiente` / `version_anterior` / `anulado`) |
   | Fecha y hora | `w-40 hidden sm:table-cell` | `<DateCell variant="datetime" />` |
   | Versión | `w-20 hidden lg:table-cell` | |
   | Observación | `w-12` | ícono + `Tooltip`; `markdownToPlainPreview` no aplica (texto plano) |
   | Acciones | `w-20` | 2 acciones ⇒ `RowAction` inline, no `RowActionsMenu`: "Ver detalle" y "Anular conformidad" (`tone="destructive"`) |

   Grupo aparte al final: **"Ya no matriculados"** — quien firmó y luego fue desmatriculado (el desmatriculado es `DELETE` físico de `course_enrollments`; la firma sobrevive porque cuelga de `auth.users`). Sin este grupo esas firmas caen en silencio y el "N de M" **baja** sin explicación.
6. **Detalle técnico** — `Collapsible` "Detalle técnico" visible solo a Admin/SuperAdmin (**P6**) con IP, navegador y huella completa. Nunca en el roster normal ni en el export.
7. **Exportar** — dos botones `variant="outline"`: "CSV" (`toCSV`/`downloadCSV` de `@/shared/lib/csv`, sin IP ni user-agent) y "Constancia (Word)" (`composeTemplateHtml(version) ⊕ rosterHtml` → `downloadReportAsWord` de `@/modules/reports/report-download`). **No PDF/imprimir** en v1: el "PDF" del proyecto es `window.print()`, y no aporta nada sobre el .docx.

### 3.2 Estudiante

**Ruta nueva: `src/routes/app.student.agreement.$agreementId.tsx`**

- RBAC: **no requiere cambios** — la regla genérica `{ prefix: "/app/student", roles: ["Estudiante"] }` la cubre.
- `PREFIX_TO_MODULE` en `src/shared/components/ModuleRouteGuard.tsx`: `["/app/student/agreement/", "courses"]`. **Sin** entrada en `NAV_PATH_TO_MODULE` y **sin** `ModuleKey` nuevo (precedente: `/app/student/workshop/`, `/app/student/review/`, `/app/student/take/` son rutas de detalle y solo están en `PREFIX_TO_MODULE`) ⇒ el guardrail `module-catalog.test.ts` no se toca.
- Layout: `<PageHeader backTo="/app/student/courses" icon={<FileSignature className="h-6 w-6" />} title subtitle />` (**P3:** el ícono solo `h-6 w-6`, sin color crudo) + `iframe` con `srcDoc={composeTemplateHtml(version)}`, `className="w-full h-[70dvh]"` y **`sandbox=""`** — es HTML autoral de staff renderizado a un alumno, superficie de confianza que hoy no existe; sin scripts y sin same-origin el CSS y las imágenes data-URI siguen funcionando.
- **Card de conformidad** debajo, con el `Alert` honesto (texto en §4), `Checkbox` "Leí el documento" (gatea los botones), `Textarea` opcional de observaciones, y dos botones: primario **"Registrar mi conformidad"** y `variant="outline"` **"Aceptar con observaciones"**. `useConfirm({ tone: "warning" })` antes de llamar el RPC. Errores con `friendlyError` de `@/shared/lib/db-errors` (los `RAISE` del RPC son P0001 y pasan su mensaje en español tal cual).
- **Después de firmar** la card se reemplaza por el resumen (fecha, versión, código de verificación, observación si hubo) + "Descargar constancia". Si publicaron una versión nueva: `Alert` "Se publicó una versión nueva de este acuerdo. Tu conformidad quedó registrada sobre la versión N." + el botón vuelve a habilitarse para la vigente.

**Punto de entrada: `src/routes/app.student.courses.tsx`** — dentro del tablero del curso (el `return` de la vista de tablero, ~línea 903), arriba del material: card con `FileSignature` que muestra "Acuerdo pedagógico — pendiente de tu conformidad" (con `Badge` y `Link` a la ruta) o, ya firmado, una línea apagada "Conformidad registrada el <fecha>". Effect con el guard `let cancelled = false`.

Segundo punto de entrada: la **notificación** `kind='agreement'` (con correo), que deep-linkea a la ruta. El dashboard del estudiante **no** se toca (patrón rígido 4+2).

---

## 4. Los textos honestos (literales)

**Aviso antes de registrar (es):**
> Al continuar queda registrado que **tu usuario** declaró estar de acuerdo con **esta versión** del documento, con la fecha y hora del servidor. No es una firma digital ni una firma electrónica certificada: es una constancia interna de conformidad dentro de ExamLab, y **no acredita la identidad de la persona** detrás de la cuenta. Guardamos la fecha, la versión del documento, tu dirección IP y el navegador desde el que lo hiciste.

**Confirmación (`tone: "warning"`):** título "¿Registrar tu conformidad?" — cuerpo: "Queda con fecha y hora, y no podés quitarla por tu cuenta: si hay un error, pedile a tu docente que la anule. Esta acción no se puede deshacer."

**Después de registrar:** "Conformidad registrada · 24 ago 2026, 14:32 · versión 1" / "Código de verificación: `a1b2c3d4e5f6`".

**Pie de la constancia exportada:** "Constancia interna generada por ExamLab · Acuerdo pedagógico, versión 1 · Código de verificación a1b2c3d4e5f6 · Registrado el 24 ago 2026, 14:32 (hora del servidor). No constituye firma digital ni firma electrónica certificada, y no acredita la identidad de la persona detrás de la cuenta."

**Confirmación al publicar (docente):** "Al publicar, el texto queda congelado y los estudiantes podrán registrar su conformidad. Si más adelante lo editás se publica una versión nueva: las conformidades ya registradas quedan atadas a la versión que aceptaron y esos estudiantes vuelven a contar como pendientes de la nueva."

**Anular (docente, `tone: "destructive"`):** "Se anula la conformidad de {{name}}. El registro no se borra: queda marcado como anulado, con quién lo anuló y cuándo, y se le avisa al estudiante. Esta acción no se puede deshacer."

**Empty state del roster:** "Todavía nadie registró su conformidad."

---

## 5. i18n — namespace `agreement` en `src/i18n/locales/{es,en}.json`

```
agreement.tabLabel                  "Acuerdo"                              | "Agreement"
agreement.pageTitle                 "Acuerdo pedagógico"                   | "Teaching agreement"
agreement.subtitlePending           "{{count}} de {{total}} registraron su conformidad"
                                    | "{{count}} of {{total}} recorded their agreement"
agreement.statusDraft               "Borrador"                             | "Draft"
agreement.statusPublished           "Publicado"                            | "Published"
agreement.statusWithdrawn           "Retirado"                             | "Withdrawn"
agreement.versionLabel              "Versión {{n}}"                        | "Version {{n}}"
agreement.publishedOn               "Publicada el {{date}}"                | "Published on {{date}}"
agreement.verificationCode          "Código de verificación"               | "Verification code"
agreement.verificationCodeHint      "Identifica la versión exacta del texto que aceptaron los estudiantes."
                                    | "Identifies the exact version of the text students agreed to."
agreement.prefillFromTemplate       "Traer de la plantilla Acuerdo Pedagógico"
                                    | "Load from the Teaching Agreement template"
agreement.prefillDone               "Borrador cargado desde la plantilla"  | "Draft loaded from the template"
agreement.publish                   "Publicar acuerdo"                     | "Publish agreement"
agreement.publishNewVersion         "Publicar versión {{n}}"               | "Publish version {{n}}"
agreement.publishConfirmTitle       "¿Publicar el acuerdo?"                | "Publish the agreement?"
agreement.publishConfirmBody        (texto de §4)                          | (translation)
agreement.remindPending             "Recordar a los pendientes ({{count}})"| "Remind pending ({{count}})"
agreement.remindResult              "Avisamos a {{sent}}. {{skipped}} ya tenían un aviso de las últimas 24 horas."
                                    | "Notified {{sent}}. {{skipped}} were already reminded in the last 24 hours."
agreement.rosterEmpty               "Todavía nadie registró su conformidad."| "No one has recorded their agreement yet."
agreement.colStudent                "Estudiante"                           | "Student"
agreement.colCode                   "Código"                               | "ID number"
agreement.colState                  "Estado"                               | "State"
agreement.colDateTime               "Fecha y hora"                         | "Date and time"
agreement.colVersion                "Versión"                              | "Version"
agreement.colObservation            "Observación"                          | "Note"
agreement.groupUnenrolled           "Ya no matriculados"                   | "No longer enrolled"
agreement.technicalDetail           "Detalle técnico"                      | "Technical detail"
agreement.exportCsv                 "CSV"                                  | "CSV"
agreement.exportWord                "Constancia (Word)"                    | "Record (Word)"
agreement.revoke                    "Anular conformidad"                   | "Void agreement record"
agreement.revokeConfirmTitle        "¿Anular la conformidad?"              | "Void this record?"
agreement.revokeConfirmBody         (texto de §4)                          | (translation)
agreement.revokeReasonLabel         "Motivo (opcional)"                    | "Reason (optional)"
agreement.student.pendingCard       "Acuerdo pedagógico — pendiente de tu conformidad"
                                    | "Teaching agreement — your agreement is pending"
agreement.student.signedCard        "Conformidad registrada el {{date}}"   | "Agreement recorded on {{date}}"
agreement.student.readCheckbox      "Leí el documento"                     | "I have read the document"
agreement.student.notice            (aviso de §4)                          | (translation)
agreement.student.sign              "Registrar mi conformidad"             | "Record my agreement"
agreement.student.signWithNotes     "Aceptar con observaciones"            | "Accept with notes"
agreement.student.notesLabel        "Tus observaciones"                    | "Your notes"
agreement.student.notesRequired     "Escribí tu observación para poder registrarla."
                                    | "Write your note so it can be recorded."
agreement.student.confirmTitle      "¿Registrar tu conformidad?"           | "Record your agreement?"
agreement.student.confirmBody       (texto de §4)                          | (translation)
agreement.student.recorded          "Conformidad registrada · {{date}} · versión {{n}}"
                                    | "Agreement recorded · {{date}} · version {{n}}"
agreement.student.newVersion        "Se publicó una versión nueva de este acuerdo. Tu conformidad quedó registrada sobre la versión {{n}}."
                                    | "A new version of this agreement was published. Your record is attached to version {{n}}."
agreement.student.download          "Descargar constancia"                 | "Download record"
agreement.constanciaFooter          (pie de §4)                            | (translation)
agreement.notifTitle                "Acuerdo pedagógico por revisar"       | "Teaching agreement to review"
agreement.notifBody                 "{{course}}: revisá el acuerdo pedagógico y registrá tu conformidad."
                                    | "{{course}}: review the teaching agreement and record your agreement."
```

Además, extender los dos mapas centrales (no inventar un badge por pantalla):

- `src/components/ui/status-badge.tsx` → `STATUS_META`: `aceptado: { variant: "secondary", icon: CheckCircle2 }`, `con_observaciones: { variant: "outline", icon: MessageSquare }`, `version_anterior: { variant: "outline", icon: History }`, `anulado: { variant: "destructive", icon: AlertTriangle }` (`pendiente` ya existe).
- `src/shared/utils/status-labels.ts` → `STATUS_MAP`: las 4 entradas con `es`/`en`. *(Gap preexistente: `StatusBadge` llama `statusLabel(status)` con `lang="es"` por default, así que el badge sale en español aunque la app esté en inglés. No lo arregla este cambio; se hereda igual que el resto de los estados.)*

---

## 6. Tests — helpers puros, sin DOM ni base

**`src/modules/agreements/agreement-state.ts`** + **`agreement-state.test.ts`**:

```ts
export type AgreementSignatureState =
  | "sin_firmar" | "firmado_vigente" | "firmado_version_anterior" | "anulado";

/** Estado del alumno frente al acuerdo. Única fuente del semáforo (roster + card). */
export function agreementSignatureState(input: {
  signature: { agreement_version_id: string; revoked_at: string | null } | null;
  currentVersionId: string | null;
}): AgreementSignatureState;

/** Conteos del roster. `pendientes` cuenta solo quien NO tiene conformidad activa
 *  sobre la versión VIGENTE — publicar v2 sube este número, y el confirm lo dice. */
export function agreementRosterStats(rows: RosterRow[]): {
  total: number; aceptadas: number; conObservaciones: number;
  versionAnterior: number; pendientes: number; anuladas: number; noMatriculados: number;
};

/** Espejo cliente de los guards 9 y 10 del RPC (invariante cross-file). */
export function validateSignInput(i: { status: string; observations: string | null }):
  | { ok: true }
  | { ok: false; reason: "bad_status" | "observations_required" | "observations_too_long" };

/** Código de verificación mostrado al usuario: 12 hex minúsculas, "—" si falta. */
export function verificationCode(hash: string | null | undefined): string;

/** RECETA CANÓNICA de la huella. En v1 NADIE hashea desde TS (solo SQL);
 *  esto es la ESPECIFICACIÓN, y el test la compara contra el texto de la
 *  migración para que no drifteen. */
export function canonicalHashInput(v: {
  version_no: number; title: string; page_size: string;
  page_orientation: string; css: string; body_html: string;
}): string;

/** Filas del CSV: NUNCA ip ni user_agent. */
export function agreementCsvRows(rows: RosterRow[]): Record<string, string>[];
```

**`src/modules/agreements/prefill.ts`** + **`prefill.test.ts`**:

```ts
/** Quita del HTML CRUDO de la plantilla el bloque `{{#each estudiantes}}…{{/each}}`
 *  (la hoja de firmas en papel) y el salto de página que lo precede. El roster de
 *  conformidades NO es parte del documento congelado: crece, y si entrara al hash
 *  la huella cambiaría con cada firma. */
export function stripRosterBlock(rawTemplateHtml: string): string;
```

**`src/modules/agreements/canonical-hash.sync.test.ts`** — lee `supabase/migrations/20261740000000_course_agreements.sql` del disco y afirma que el orden de concatenación del `extensions.digest(...)` coincide con `canonicalHashInput`. Mismo patrón que `src/modules/tutor/tutor-default-prompt.test.ts` (normalizar CRLF del checkout en Windows antes de comparar). Sin este test la sincronía depende de acordarse.

Correr con `bun test` (jsdom); `bun tsc --noEmit` debe seguir en 1 error (el de `vite.config.ts`). Y `bun test src/shared/lib/module-catalog.test.ts` para confirmar que el guardrail sigue verde (no se agregó `ModuleKey`).

---

## 7. Privacidad — cambio exacto en `src/modules/legal/PrivacyPolicyContent.tsx`

Sí se guardan IP y user-agent ⇒ la edición va **en la misma entrega**, nunca después. El archivo es un documento legal en español a propósito (no se traduce; solo los rótulos van por i18n).

**a) Sección 3 "Datos que recopilamos" — bullet NUEVO:**
> "Constancia de conformidad con el acuerdo pedagógico: cuando registrás tu conformidad con el acuerdo de un curso guardamos la fecha y hora del servidor, la versión exacta del documento, tu nombre, correo institucional, código y documento tal como estaban en ese momento, tu dirección IP y el navegador desde el que lo hiciste. La IP y el navegador no se imprimen en el documento: solo los ve el personal administrativo de tu institución."

**b) Sección 3 — reemplazar el bullet "Datos técnicos"** (cierra además una recolección **hoy no declarada**: `_audit_client_ip()` ya guarda la IP en `audit_logs.metadata` en cada override de nota):
> "Datos técnicos: identificador de sesión, preferencias (tema, idioma, ajustes de las listas), registros de auditoría con fecha, autor y acción, y la dirección IP desde la que se hicieron cambios sensibles (calificaciones y conformidad con el acuerdo pedagógico)."

**c) Sección 4 "Finalidad del tratamiento" — bullet NUEVO:**
> "Registrar la conformidad de cada estudiante con el acuerdo pedagógico del curso, y permitir a la institución acreditar cuándo se registró y sobre qué versión del documento."

**d) Sección de conservación** (la que cita los 30 días de `purge_deleted_items`) — agregar:
> "Las constancias de conformidad con el acuerdo pedagógico se conservan aunque el curso se elimine, porque son el respaldo de un acto que ocurrió."

**e)** Bumpear `PRIVACY_LAST_UPDATED` (hoy `"22 de agosto de 2026"`) y agregar a la lista del docblock "Regla al editar este archivo": *"la IP y el navegador de la conformidad con el acuerdo salen de `_audit_client_ip()` / `_signature_user_agent()` en `sign_course_agreement`"*.

---

## 8. Fuera de v1 (y por qué)

| Fuera | Por qué |
|---|---|
| Enlace público / firma por correo sin login | La propia migración de encuestas públicas lo dice: con identidad por correo —adivinable— alguien se adelanta y responde por otro; "un instrumento sensible no debería publicarse por enlace". |
| Código de un solo uso al correo (OTP) | Es lo único que de verdad reforzaría la identidad, pero arrastra deliverability y el proyecto ya tuvo incidente de rebotes. Queda como el camino correcto de v2. |
| Trazo manuscrito en canvas | Agrega la **apariencia** de firma legal y cero integridad — es el cambio que más haría creer que es vinculante. Si algún día entra: bucket privado + su hash dentro de la fila de firma, para que quede atado a la misma cadena y no flotando al lado. |
| Página `/verify/<code>` pública | Solo hace falta si el documento sale de la institución. Antes hay que arreglar dos defectos del precedente: el `payload_hash` de certificados mete `now()` adentro (es un nonce, no un digest recomputable) y la página verifica "existe un registro que dice X", no "este PDF es auténtico". |
| PDF del acuerdo | El "PDF" del proyecto es `window.print()`; el .docx de `htmlToDocxBlob` es OOXML real y alcanza. Y un PDF armado en el navegador por la parte interesada no prueba nada. |
| Conformidad registrada por el docente ("el alumno no tiene computador") | Es la vía más corta a evidencia fabricada. Si algún día entra: columnas separadas `signed_by` / `user_id`, `method='registrada_por_docente'` obligatorio, render distinto en toda lista y export, y audit `category='integrity'`. |
| Gate (bloquear curso/notas/entregas hasta firmar) | Consentimiento coaccionado destruye el valor probatorio; y el techo de 100k req/día (error 1027) más el diálogo bloqueante de contraseña ya son dos formas de quedar afuera por causa técnica. Si algún día se gatea, se gatea **un entregable** (forma `IntroVideoGate`), nunca el curso. |
| El acuerdo como 9ª entidad de Papelera | El set de 8 está cableado en 6 lugares sincronizados (`trash_restore_item`, `trash_hard_delete_item`, `purge_deleted_items`, `TrashTable`, `TRASH_TABLE_LABEL`/`NAME_COL`/`COURSE_COL`) y abriría un camino de hard-delete sobre las firmas. `deleted_at` = "retirado" desde su propio módulo. |
| Que el estudiante pueda retirar su conformidad | No es corregir un error, es retirar el consentimiento después del hecho. Otro acto, otro nombre, su propio rastro. |
| Versionado del documento con historial navegable / diff entre versiones | Las versiones ya son append-only y visibles; un diff pide un motor que el repo no tiene (no existe versionado en NINGÚN flujo de contenido: "nueva versión" = reemplazar). |
| Multi-firmante (docente que refrenda, vocero, director) | Las tres `.sig-line` del documento siguen en papel; modelarlas pide roles de firmante y un flujo de orden que triplica el alcance. |
| Cerrar el gap de `report-context.ts:651` (exponer `estudiante.id`) | No lo necesita este diseño: el roster lo renderiza el módulo nuevo. Queda documentado como latente para quien quiera el estado dentro de una plantilla. |
| Congelar `profiles.full_name`/`documento` para quien ya firmó | Cambio de comportamiento con blast radius sobre `profiles`; el snapshot en la firma ya neutraliza el repudio por renombre, y la UI muestra ambos nombres cuando difieren. |
| Guardar la constancia en Storage | Se reconstruye del snapshot en cualquier momento (molde certificados: el binario no se guarda). Un bucket nuevo trae la trampa del 403-sin-policy-de-SELECT por nada. |

---

### Archivos que toca (todos con path absoluto de repo)

**Nuevos:** `supabase/migrations/20261740000000_course_agreements.sql` · `src/modules/agreements/CourseAgreementPanel.tsx` · `src/modules/agreements/agreement-state.ts` (+`.test.ts`) · `src/modules/agreements/prefill.ts` (+`.test.ts`) · `src/modules/agreements/canonical-hash.sync.test.ts` · `src/modules/agreements/constancia-html.ts` · `src/routes/app.student.agreement.$agreementId.tsx`

**Modificados:** `src/routes/app.teacher.reports.tsx` (tab + gate del `actions`) · `src/routes/app.student.courses.tsx` (card del tablero) · `src/shared/components/ModuleRouteGuard.tsx` (`PREFIX_TO_MODULE`) · `src/components/ui/status-badge.tsx` · `src/shared/utils/status-labels.ts` · `src/modules/notifications/notification-email.ts` · `supabase/functions/send-email/index.ts` · `src/modules/admin/AdminEmailSettingsPanel.tsx` · `src/modules/legal/PrivacyPolicyContent.tsx` · `src/i18n/locales/es.json` · `src/i18n/locales/en.json` · `CLAUDE.md` (fila nueva en la tabla de invariantes cross-file: receta de la huella SQL ↔ `canonicalHashInput`; y `validateSignInput` ↔ guards 9-10 del RPC).

**Cierre obligatorio:** agente `consistencia` + `bun tsc --noEmit` (EXIT 0 salvo el error de `vite.config.ts`) + `bun test`.
