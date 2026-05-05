-- Permite que el autor del comentario edite su propio cuerpo. La
-- política de DELETE de su propio comentario ya existía en la
-- migración 20260503210000_feedback_threads.sql; faltaba la de
-- UPDATE. Sin ella un dueño podía borrar pero no corregir un typo.
--
-- No condicionamos al estado del hilo (closed): si el dueño quiere
-- corregir su texto incluso después de cerrarse la conversación,
-- es benigno y la auditoría hace match por user_id.

drop policy if exists "feedback_comments update own" on public.feedback_comments;
create policy "feedback_comments update own"
  on public.feedback_comments for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
