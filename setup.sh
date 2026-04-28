#!/bin/bash

###############################################################################
# setup.sh — Setup interactivo para ExamLab
#
# Uso:
# $ bash setup.sh
#
# Pregunta usuario final por:
# - PROJECT_NAME (nombre del proyecto)
# - DB_PASSWORD (contraseña para Postgres/Supabase)
# - AWS_REGION (región AWS)
# - AWS_ACCOUNT_ID (ID de cuenta AWS)
#
# Genera:
# - .env (variables de entorno)
# - docker-compose.override.yml (overrides personalizados)
# - Instrucciones para siguiente paso
###############################################################################

set -e

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Helper functions
header() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║ $1${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
    exit 1
}

info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

# Verificar Docker
header "Verificando requisitos"

if ! command -v docker &> /dev/null; then
    error "Docker no está instalado. Descárgalo desde https://docker.com"
fi
success "Docker instalado"

if ! command -v docker-compose &> /dev/null; then
    error "Docker Compose no está instalado"
fi
success "Docker Compose instalado"

# Setup interactivo
header "Configuración de ExamLab"

echo "Responde las siguientes preguntas para configurar tu proyecto."
echo "Los valores entre [corchetes] son valores por defecto."
echo ""

# 1. Nombre del proyecto
read -p "Nombre del proyecto [examlab]: " PROJECT_NAME
PROJECT_NAME=${PROJECT_NAME:-examlab}
success "Proyecto: $PROJECT_NAME"

# 2. Contraseña de base de datos
echo ""
read -sp "Contraseña de Postgres (mín. 12 caracteres): " DB_PASSWORD
echo ""

# Validar contraseña
if [ ${#DB_PASSWORD} -lt 12 ]; then
    error "Contraseña muy corta (mínimo 12 caracteres)"
fi
success "Contraseña configurada"

# 3. Región AWS
echo ""
read -p "Región AWS [us-east-1]: " AWS_REGION
AWS_REGION=${AWS_REGION:-us-east-1}
success "Región AWS: $AWS_REGION"

# 4. AWS Account ID (para deploy)
echo ""
read -p "AWS Account ID (12 dígitos, sin guiones): " AWS_ACCOUNT_ID

# Validar Account ID
if ! [[ $AWS_ACCOUNT_ID =~ ^[0-9]{12}$ ]]; then
    error "Account ID inválido (debe ser 12 dígitos)"
fi
success "AWS Account ID: $AWS_ACCOUNT_ID"

# Confirmar
echo ""
echo -e "${YELLOW}Resumen de configuración:${NC}"
echo "  Proyecto:        $PROJECT_NAME"
echo "  Base de datos:   $DB_PASSWORD (****)"
echo "  Región AWS:      $AWS_REGION"
echo "  Account ID:      $AWS_ACCOUNT_ID"
echo ""

read -p "¿Es correcto? (s/n): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    info "Setup cancelado"
    exit 0
fi

# Generar .env
header "Generando archivo .env"

cat > .env << EOF
# ExamLab Configuration
PROJECT_NAME=$PROJECT_NAME
ENVIRONMENT=production
AWS_REGION=$AWS_REGION
AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID

# Supabase & Database
SUPABASE_URL=http://localhost:8000
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4YW1sYWIiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTYwMzk0OTgwMCwiZXhwIjoxNjM0NDgwODAwfQ.MOCK_KEY_CHANGE_IN_SUPABASE
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4YW1sYWIiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNjAzOTQ5ODAwLCJleHAiOjE2MzQ0ODA4MDB9.MOCK_KEY_CHANGE_IN_SUPABASE
POSTGRES_PASSWORD=$DB_PASSWORD
POSTGRES_DB=$PROJECT_NAME
POSTGRES_USER=postgres

# Application
NODE_ENV=production
APP_PORT=3000
HOST=0.0.0.0

# AI Functions (Supabase Edge Functions)
SUPABASE_AI_GENERATE_FUNCTION=ai-generate
SUPABASE_AI_GRADE_FUNCTION=ai-grade
SUPABASE_AI_FEEDBACK_FUNCTION=ai-feedback

# AWS
AWS_ACCESS_KEY_ID=YOUR_KEY_HERE
AWS_SECRET_ACCESS_KEY=YOUR_SECRET_HERE

# Backup
BACKUP_ENABLED=true
BACKUP_SCHEDULE=daily
EOF

success ".env creado"

# Generar docker-compose.override.yml
header "Generando configuración Docker personalizada"

cat > docker-compose.override.yml << EOF
version: '3.9'

services:
  app:
    environment:
      PROJECT_NAME: $PROJECT_NAME
      POSTGRES_PASSWORD: $DB_PASSWORD
      POSTGRES_DB: $PROJECT_NAME

  postgres:
    environment:
      POSTGRES_PASSWORD: $DB_PASSWORD
      POSTGRES_DB: $PROJECT_NAME

  supabase:
    environment:
      PROJECT_NAME: $PROJECT_NAME
EOF

success "docker-compose.override.yml creado"

# Crear .gitignore actualizado
if [ -f .gitignore ]; then
    if ! grep -q ".env" .gitignore; then
        echo ".env" >> .gitignore
        success "Agregado .env a .gitignore"
    fi
else
    cat > .gitignore << EOF
# Environment
.env
.env.local
.env.*.local

# Dependencies
node_modules/
.pnp

# Build
dist/
build/

# Docker
.docker/
*.log

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Backups
backups/
*.sql
*.sql.gz
EOF
    success ".gitignore creado"
fi

# Instrucciones finales
header "✅ Setup completado"

echo "Próximos pasos:"
echo ""
echo "1️⃣  Levantar Supabase y la app:"
echo "   ${YELLOW}docker-compose up -d${NC}"
echo ""
echo "2️⃣  Esperar ~30 segundos a que todo inicie"
echo ""
echo "3️⃣  Verificar que todo está funcionando:"
echo "   ${YELLOW}docker-compose ps${NC}"
echo ""
echo "4️⃣  Acceder a la app:"
echo "   ${YELLOW}http://localhost:3000${NC}"
echo ""
echo "5️⃣  Acceder a Supabase Studio:"
echo "   ${YELLOW}http://localhost:8000${NC}"
echo "   Email: admin@example.com"
echo "   Password: password"
echo ""
echo "6️⃣  Cuando esté listo, desplegar a AWS:"
echo "   ${YELLOW}bash deploy-to-aws.sh${NC}"
echo ""
echo "📖 Para más información:"
echo "   Ver: ${YELLOW}SETUP_SIMPLE.md${NC}"
echo ""
