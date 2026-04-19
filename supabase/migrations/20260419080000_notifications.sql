-- ============================================================
-- MIGRATION: Notifications system
-- ============================================================

CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info', -- info | exam | workshop | grade | system
  link TEXT, -- optional route to navigate to
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_notifications_user ON public.notifications(user_id);
CREATE INDEX idx_notifications_unread ON public.notifications(user_id, read) WHERE read = false;

-- Users see own notifications
CREATE POLICY "Users see own notifications"
  ON public.notifications FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Users update own notifications (mark read)
CREATE POLICY "Users update own notifications"
  ON public.notifications FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

-- Teachers/Admins can insert notifications for anyone
CREATE POLICY "Teachers insert notifications"
  ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
    OR auth.uid() = user_id
  );

-- Enable Realtime for push notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- ============================================================
-- Helper: Notify all students in a course
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_course_students(
  _course_id UUID,
  _title TEXT,
  _body TEXT,
  _kind TEXT DEFAULT 'info',
  _link TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT ce.user_id, _title, _body, _kind, _link
  FROM public.course_enrollments ce
  WHERE ce.course_id = _course_id;

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;
