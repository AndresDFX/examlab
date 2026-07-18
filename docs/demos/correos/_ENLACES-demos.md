# Enlaces canónicos de los demos (publicidad)

Fuente única de los enlaces que se embeben en los correos/WhatsApp de
`docs/demos/correos/`. Si un enlace cambia, **actualízalo acá y en el cuerpo de
cada correo** (van embebidos como `[texto](enlace)` para no mostrar la URL
cruda). La **presentación general** es la que se comparte siempre por ahora.

> **Links estables**: videos en el bucket `help-videos` y presentaciones en
> `help-docs` (ambos públicos, Supabase Storage). Si un archivo cambia, se
> re-sube al MISMO nombre (upsert) y el enlace se mantiene — no usar
> Drive/Slides, cuyos links cambian por archivo.

| Recurso | Enlace |
|---|---|
| **Presentación general** | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/presentacion-general.pptx |
| **Presentación comercial** (vigente, sin versión en el nombre) | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/presentacion-comercial.pptx |
| **Presentación aliados** | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/presentacion-aliados.pptx |
| **Presentación comercial administrada** | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/presentacion-comercial-administrada.pptx |
| **Presentación independientes** | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/presentacion-independientes.pptx |
| **Presentación modelo modular** | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/presentacion-modelo-modular.pptx |
| **Demo general** (modulo-overview) | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/general.mp4 |
| **Serie Administrador** (completa) | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-admin.mp4 |
| **Serie Docente** (completa) | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-docente.mp4 |
| **Serie Estudiante** (completa) | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-estudiante.mp4 |
| **Serie SuperAdmin** (completa) | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-videos/serie-superadmin.mp4 |
| **Manual de usuario** (índice, general) | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/manual.pdf |
| **Manual — Administrador** | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/manual-administrador.pdf |
| **Manual — Docente** | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/manual-docente.pdf |
| **Manual — Estudiante** | https://uxxpzfsfcnqiwwdxoelm.supabase.co/storage/v1/object/public/help-docs/manual-estudiante.pdf |

> Los **manuales de usuario** (PDF) ya se incluyen en los correos donde aplica: el manual **por rol** en los correos de onboarding de ese rol (docente/estudiante/institución) y **los cuatro** en los correos a socios/aliados. Se sirven desde `help-docs` (público, link estable por nombre). Al cambiar un `.md` se regeneran con `node scripts/gen-manual-pdfs.mjs` y se re-suben al mismo nombre (upsert).

> Los `.mp4` locales (`docs/demos/.../*.mp4`) son los archivos fuente; los
> enlaces de arriba (Supabase Storage / Google Slides) son los que se comparten en los correos.
