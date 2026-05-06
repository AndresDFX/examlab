
CREATE POLICY "Docentes/Admins insert submissions"
ON public.submissions FOR INSERT TO authenticated
WITH CHECK (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

CREATE POLICY "Docentes/Admins insert workshop submissions"
ON public.workshop_submissions FOR INSERT TO authenticated
WITH CHECK (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

CREATE POLICY "Docentes/Admins update submissions"
ON public.submissions FOR UPDATE TO authenticated
USING (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

CREATE POLICY "Docentes/Admins update workshop submissions"
ON public.workshop_submissions FOR UPDATE TO authenticated
USING (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));
