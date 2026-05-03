-- Add cascade FKs so deleting a project_submission also removes its files and attachments.
ALTER TABLE public.project_submission_files
  ADD CONSTRAINT project_submission_files_submission_fk
  FOREIGN KEY (submission_id) REFERENCES public.project_submissions(id) ON DELETE CASCADE;

ALTER TABLE public.project_submission_files
  ADD CONSTRAINT project_submission_files_file_fk
  FOREIGN KEY (file_id) REFERENCES public.project_files(id) ON DELETE CASCADE;

ALTER TABLE public.project_submission_attachments
  ADD CONSTRAINT project_submission_attachments_psf_fk
  FOREIGN KEY (project_submission_file_id) REFERENCES public.project_submission_files(id) ON DELETE CASCADE;