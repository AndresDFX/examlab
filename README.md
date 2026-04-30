# ExamLab

Plataforma web para la creación, administración y calificación de exámenes y talleres
académicos con asistencia de IA.

![Status](https://img.shields.io/badge/status-active-brightgreen)
![Stack](https://img.shields.io/badge/stack-React%2019%20%2B%20TanStack%20%2B%20Supabase-blue)
![Platform](https://img.shields.io/badge/platform-Lovable-purple)

---

## ✨ Características

### Para docentes
- 📝 **Creación de exámenes** — preguntas abiertas, opción múltiple, código (Java, Python, etc.) y diagramas
- 🤖 **Generación de preguntas con IA** — describe un tema y la IA crea preguntas con rúbricas
- 🎯 **Calificación asistida** — la IA pre-califica respuestas y propone justificaciones
- 📊 **Gradebook** — vista consolidada de calificaciones por curso
- 👀 **Monitor en vivo** — supervisa exámenes en curso con detección de actividad sospechosa
- 🛠️ **Talleres con archivos** — los estudiantes suben PDF/ZIP/código, la IA califica el contenido

### Para estudiantes
- ⏱️ **Toma de exámenes con timer** — sincronizado en tiempo real
- 💾 **Autoguardado** — las respuestas se persisten cada 1.5 segundos (resistente a pérdida de conexión)
- 📵 **Modo offline** — IndexedDB guarda respuestas sin internet, las sincroniza al volver
- 🔒 **Proctoring** — bloqueo de cambio de pestaña, copia/pega y atajos
- 📂 **Subida de proyectos** — talleres con archivos comprimidos (hasta 50 MB)
- 🌐 **Multi-idioma** — interfaz en español e inglés (i18n)

### Para administradores
- 👥 **Gestión de usuarios** — importación masiva por CSV
- 📚 **Gestión de cursos** — múltiples cursos con configuraciones independientes
- 🔑 **Roles y permisos** — Admin, Docente, Estudiante (RLS en PostgreSQL)
- 📅 **Notificaciones diarias** — recordatorios automáticos de exámenes próximos

---

## 🧱 Stack tecnológico

### Frontend
| Tecnología | Uso |
|------------|-----|
| **React 19** | UI |
| **TypeScript** | Type safety |
| **TanStack Router v1** | Routing file-based |
| **TanStack Query** | Estado del servidor + cache |
| **TanStack Start** | SSR/SSG |
| **Vite 7** | Bundler + dev server |
| **shadcn/ui** + Tailwind v4 | Componentes y estilos |
| **Monaco Editor** | Editor de código (con Java, Python, etc.) |
| **react-i18next** | Internacionalización |
| **idb-keyval** | IndexedDB para offline |
| **Mermaid** | Diagramas |
| **sonner** | Toasts |

### Backend
| Tecnología | Uso |
|------------|-----|
| **Supabase** | PostgreSQL + Auth + Realtime + Storage |
| **PostgreSQL 15** | Base de datos relacional con RLS |
| **Edge Functions (Deno)** | Lógica server-side, integración con IA |
| **Google Gemini** | Generación y calificación con IA (vía API OpenAI-compatible) |

---

## 📁 Estructura del proyecto

```
examlab/
├── src/
│   ├── routes/                  # Rutas TanStack (file-based)
│   │   ├── app.admin.*          # Vistas de admin
│   │   ├── app.teacher.*        # Vistas de docente
│   │   ├── app.student.*        # Vistas de estudiante
│   │   └── app.storage-test.tsx # Página de prueba de storage
│   ├── components/              # Componentes reutilizables (UI shadcn)
│   ├── hooks/                   # Custom hooks (use-auth, use-realtime-timer, ...)
│   ├── integrations/supabase/   # Cliente Supabase + tipos generados
│   ├── lib/                     # Utilities (offline-sync, i18n, ...)
│   └── utils/                   # proctoring, formato, helpers
│
├── supabase/
│   ├── migrations/              # SQL migrations (versionadas, aplicadas en orden alfabético)
│   ├── functions/               # Edge functions (Deno)
│   │   ├── ai-generate-questions/
│   │   ├── ai-grade-submission/
│   │   ├── seed-data/           # Carga datos demo
│   │   ├── bulk-import-users/   # Importación masiva CSV
│   │   ├── execute-code/        # Ejecutor de código sandboxeado
│   │   └── ...
│   └── config.toml              # Config de Supabase local
│
├── public/                      # Assets estáticos
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md                    # Este archivo
```

---

## 🛠️ Desarrollo

ExamLab está hospedado en **[Lovable.dev](https://lovable.dev)**, que gestiona Supabase
automáticamente. El flujo de trabajo es:

### Editar en Lovable

1. Abre el proyecto en Lovable
2. Edita con prompts en lenguaje natural o directamente en el editor de código
3. Lovable aplica cambios y los empuja a GitHub automáticamente

### Editar localmente

Para hacer cambios desde tu IDE:

```bash
# Clonar el repo
git clone https://github.com/vivetori/examlab.git
cd examlab

# Instalar dependencias
npm install --legacy-peer-deps

# Variables de entorno (copia .env.example y completa)
cp .env.example .env
# Edita .env con tu VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY

# Iniciar dev server
npm run dev
# → http://localhost:3000
```

Tras hacer cambios:

```bash
git add .
git commit -m "feat: tu cambio"
git push origin main
```

Lovable detecta el push y sincroniza el proyecto. Click en **Publish** dentro de Lovable
para aplicar las migraciones SQL y desplegar.

### Migraciones SQL

Las migraciones van en `supabase/migrations/` con formato `YYYYMMDDHHMMSS_descripcion.sql`.
Lovable las aplica en orden alfabético cuando se hace **Publish**.

```bash
# Ejemplo de nueva migración
echo "ALTER TABLE exams ADD COLUMN difficulty TEXT;" \
  > supabase/migrations/$(date +%Y%m%d%H%M%S)_add_exam_difficulty.sql
git add supabase/migrations/
git commit -m "feat(db): add exam difficulty column"
git push
# Click 'Publish' en Lovable
```

### Edge functions

Las edge functions están en `supabase/functions/`. Cada una tiene su `index.ts` (Deno).
Lovable las despliega automáticamente con **Publish**.

---

## 🧪 Testing

```bash
npm run test         # vitest watch mode
npm run test:run     # vitest single run
npm run lint         # eslint
npm run format       # prettier
```

---

## 🔐 Seguridad

- **Row Level Security (RLS)** en todas las tablas — un estudiante nunca ve datos de otro
- **Auth con Supabase** — JWT con refresh automático
- **Proctoring opcional** — bloquea Ctrl+C, cambio de pestaña, etc. durante exámenes
- **Storage con signed URLs** — los archivos no son públicos, requieren token temporal
- **Edge functions con verificación JWT** — solo usuarios autenticados llaman a la IA

---

## 🚀 Despliegue

ExamLab puede correr en **Lovable** (recomendado, gestionado) o desplegarse en
**AWS** auto-hospedado. Para AWS, ver `lovable-aws-deployment/README.md`.

---

## 📝 Licencia

MIT — ver [LICENSE](LICENSE)

---

## 🤝 Contribuir

1. Fork el repo
2. Crea una rama: `git checkout -b feature/tu-feature`
3. Commit: `git commit -m "feat: descripción"`
4. Push: `git push origin feature/tu-feature`
5. Abre un Pull Request

---

## 📞 Soporte

- **Issues:** [GitHub Issues](https://github.com/vivetori/examlab/issues)
- **Lovable:** Editor en [lovable.dev](https://lovable.dev)
