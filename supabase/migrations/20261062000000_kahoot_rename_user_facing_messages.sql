-- ══════════════════════════════════════════════════════════════════════
-- Renombrado legal de la marca "Kahoot" en MENSAJES VISIBLES AL USUARIO.
--
-- Contexto: se removió "Kahoot" (marca registrada) del texto visible en el
-- frontend (i18n) y edges. Faltaban los mensajes `RAISE EXCEPTION` de varias
-- RPCs/triggers, que llegan al usuario vía P0001/friendlyError (ej. "El Kahoot
-- no tiene preguntas"). Se reemplaza "Kahoot" → "reto en vivo" SOLO en esos
-- mensajes.
--
-- Enfoque: en vez de copiar a mano el cuerpo de cada función (frágil), se lee
-- su definición REAL en la DB con pg_get_functiondef, se reemplazan únicamente
-- los fragmentos con "Kahoot" en MAYÚSCULA (que solo existen en los mensajes de
-- error — los identificadores internos son `kahoot_*` en minúscula, intactos) y
-- se re-ejecuta el CREATE OR REPLACE. Idempotente (re-correr no encuentra
-- "Kahoot" que cambiar) y robusto (respeta el cuerpo vigente en cada entorno).
-- El FOR salta las funciones que no existan → guard implícito estilo Lovable.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  d text;
BEGIN
  FOR d IN
    SELECT pg_get_functiondef(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'add_questions_from_bank_to_kahoot',
        'kahoot_create_game',
        'kahoot_join_game',
        'kahoot_join_game_by_id',
        'tg_kahoot_block_edit_when_live'
      )
      AND pg_get_functiondef(p.oid) LIKE '%Kahoot%'
  LOOP
    d := replace(d, 'de tipo Kahoot',                'de tipo reto en vivo');
    d := replace(d, 'El Kahoot no tiene preguntas',  'El reto en vivo no tiene preguntas');
    d := replace(d, 'pregunta del Kahoot',           'pregunta del reto en vivo');
    d := replace(d, 'editar el Kahoot',              'editar el reto en vivo');
    d := replace(d, 'este Kahoot',                   'este reto en vivo');
    -- Salvaguarda: cualquier "Kahoot" residual en un mensaje → "reto en vivo".
    d := replace(d, 'Kahoot',                        'reto en vivo');
    EXECUTE d;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
