-- ═══════════════════════════════════════════════════════════════════════════════
-- ExamLab — Inicialización de Base de Datos
--
-- Esta script se ejecuta automáticamente cuando PostgreSQL inicia en Docker
-- Crea las extensiones y esquema base necesarios para ExamLab
-- ═══════════════════════════════════════════════════════════════════════════════

-- Extensiones requeridas
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Crear esquema
CREATE SCHEMA IF NOT EXISTS public;

-- Tabla: users
-- Almacena información de usuarios (estudiantes, profesores, administradores)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE,
    INDEX idx_users_email (email),
    INDEX idx_users_role (role)
);

-- Tabla: exams
-- Almacena información de exámenes creados por profesores
CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    subject VARCHAR(255),
    teacher_id UUID NOT NULL REFERENCES users(id),
    duration_minutes INTEGER NOT NULL,
    total_points DECIMAL(10, 2) NOT NULL DEFAULT 100,
    passing_score DECIMAL(10, 2) NOT NULL DEFAULT 60,
    navigation_type VARCHAR(50) NOT NULL DEFAULT 'sequential' CHECK (navigation_type IN ('sequential', 'free')),
    show_answers BOOLEAN DEFAULT FALSE,
    shuffle_questions BOOLEAN DEFAULT FALSE,
    shuffle_options BOOLEAN DEFAULT TRUE,
    is_published BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    INDEX idx_exams_teacher_id (teacher_id),
    INDEX idx_exams_is_published (is_published)
);

-- Tabla: exam_questions
-- Almacena preguntas de exámenes
CREATE TABLE IF NOT EXISTS exam_questions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    question_type VARCHAR(50) NOT NULL CHECK (question_type IN ('multiple_choice', 'true_false', 'short_answer', 'essay')),
    points DECIMAL(10, 2) NOT NULL DEFAULT 1,
    order_index INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_questions_exam_id (exam_id),
    INDEX idx_exam_questions_order (order_index)
);

-- Tabla: exam_options
-- Almacena opciones de respuesta para preguntas de opción múltiple
CREATE TABLE IF NOT EXISTS exam_options (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    question_id UUID NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
    option_text TEXT NOT NULL,
    is_correct BOOLEAN DEFAULT FALSE,
    order_index INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_options_question_id (question_id)
);

-- Tabla: exam_submissions
-- Almacena intentos/respuestas de estudiantes en exámenes
CREATE TABLE IF NOT EXISTS exam_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exam_id UUID NOT NULL REFERENCES exams(id),
    student_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(50) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'graded', 'cancelled')),
    answers JSONB DEFAULT '{}',
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    submitted_at TIMESTAMP WITH TIME ZONE,
    graded_at TIMESTAMP WITH TIME ZONE,
    score DECIMAL(10, 2),
    is_flagged BOOLEAN DEFAULT FALSE,
    flagged_reason VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_submissions_exam_id (exam_id),
    INDEX idx_exam_submissions_student_id (student_id),
    INDEX idx_exam_submissions_status (status),
    INDEX idx_exam_submissions_submitted_at (submitted_at)
);

-- Tabla: exam_feedback
-- Almacena retroalimentación generada por IA para respuestas
CREATE TABLE IF NOT EXISTS exam_feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    submission_id UUID NOT NULL REFERENCES exam_submissions(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES exam_questions(id),
    feedback_text TEXT NOT NULL,
    generated_by VARCHAR(50) DEFAULT 'ai' CHECK (generated_by IN ('ai', 'teacher', 'manual')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_feedback_submission_id (submission_id)
);

-- Tabla: audit_logs
-- Registra eventos importantes para auditoría y troubleshooting
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    event_type VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id UUID,
    action VARCHAR(50),
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_logs_user_id (user_id),
    INDEX idx_audit_logs_event_type (event_type),
    INDEX idx_audit_logs_created_at (created_at)
);

-- Crear índices para búsqueda full-text
CREATE INDEX idx_exams_title_search ON exams USING GIN (to_tsvector('english', title));
CREATE INDEX idx_questions_search ON exam_questions USING GIN (to_tsvector('english', question_text));

-- Crear funciones trigger para updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar trigger a tablas
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_exams_updated_at
    BEFORE UPDATE ON exams
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_exam_questions_updated_at
    BEFORE UPDATE ON exam_questions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_exam_submissions_updated_at
    BEFORE UPDATE ON exam_submissions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Crear vista para estadísticas de exámenes
CREATE OR REPLACE VIEW exam_statistics AS
SELECT
    e.id,
    e.title,
    COUNT(DISTINCT es.student_id) as total_students,
    COUNT(DISTINCT CASE WHEN es.status = 'submitted' THEN es.student_id END) as completed_students,
    AVG(CASE WHEN es.score IS NOT NULL THEN es.score ELSE NULL END) as average_score,
    MAX(CASE WHEN es.score IS NOT NULL THEN es.score ELSE NULL END) as highest_score,
    MIN(CASE WHEN es.score IS NOT NULL THEN es.score ELSE NULL END) as lowest_score
FROM exams e
LEFT JOIN exam_submissions es ON e.id = es.exam_id
GROUP BY e.id, e.title;

-- Permisos (si usas Supabase RLS)
-- Descomentar si necesitas RLS habilitado
/*
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Políticas de ejemplo (descomentar según necesites)
CREATE POLICY "Users can view their own profile" ON users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Teachers can view exams they created" ON exams
    FOR SELECT USING (auth.uid() = teacher_id OR auth.role() = 'admin');

CREATE POLICY "Students can view their own submissions" ON exam_submissions
    FOR SELECT USING (auth.uid() = student_id);
*/

-- Confirmación
COMMIT;
