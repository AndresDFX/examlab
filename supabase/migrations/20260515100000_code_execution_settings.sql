-- Tabla de configuración del proveedor de ejecución de código.
-- Similar a ai_model_settings: solo una fila activa a la vez.
-- Providers: onlinecompiler (OnlineCompiler.io), jdoodle (JDoodle), cheerp (CheerpJ browser-side para Java).

CREATE TABLE code_execution_settings (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  provider    text        NOT NULL CHECK (provider IN ('onlinecompiler', 'jdoodle', 'cheerp')),
  is_active   boolean     NOT NULL DEFAULT false,
  updated_by  uuid        REFERENCES auth.users(id),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Solo un proveedor activo a la vez
CREATE UNIQUE INDEX code_execution_settings_one_active
  ON code_execution_settings (is_active)
  WHERE is_active = true;

-- Semilla: OnlineCompiler.io como proveedor por defecto
INSERT INTO code_execution_settings (provider, is_active)
VALUES ('onlinecompiler', true);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_code_execution_settings_updated_at ON public.code_execution_settings;
CREATE TRIGGER trg_code_execution_settings_updated_at
  BEFORE UPDATE ON public.code_execution_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE code_execution_settings ENABLE ROW LEVEL SECURITY;

-- Cualquier usuario autenticado puede leer (la edge function y el cliente lo necesitan)
CREATE POLICY "Authenticated can read code_execution_settings"
  ON code_execution_settings FOR SELECT
  USING (auth.role() = 'authenticated');

-- Solo Admin puede escribir
CREATE POLICY "Admin can manage code_execution_settings"
  ON code_execution_settings FOR ALL
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));
