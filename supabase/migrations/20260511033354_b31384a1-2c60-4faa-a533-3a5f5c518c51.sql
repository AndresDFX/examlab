UPDATE public.generated_contents
SET status = 'queued',
    error = 'Auto-recuperado: la ejecución previa fue interrumpida'
WHERE status = 'processing'
  AND updated_at < now() - interval '5 minutes';