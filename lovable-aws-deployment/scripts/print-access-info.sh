#!/bin/bash

###############################################################################
# print-access-info.sh — Mostrar información de acceso después del despliegue
#
# Ejecutar cuando necesites ver la información nuevamente:
# $ bash scripts/print-access-info.sh
###############################################################################

set -e

# Source variables
source "$(dirname "$0")/../cloudshell-vars.env"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  📊 INFORMACIÓN DE ACCESO - $PROJECT_NAME ($ENVIRONMENT)             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Obtener información de los stacks
echo -e "${BLUE}Obteniendo información de CloudFormation...${NC}"
echo ""

# ALB DNS
ALB_DNS=$(aws cloudformation describe-stacks \
    --stack-name "$EC2_STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`ALBDNSName`].OutputValue' \
    --output text 2>/dev/null || echo "❌ Aún no disponible (espera 5 min)")

# RDS Endpoint
RDS_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$RDS_STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`RDSEndpoint`].OutputValue' \
    --output text 2>/dev/null || echo "❌ Aún no disponible")

# EC2 Status
EC2_STATUS=$(aws ec2 describe-instances \
    --filters "Name=tag:aws:cloudformation:stack-name,Values=$EC2_STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text 2>/dev/null || echo "❌ Desconocido")

# Print information
echo "🌐 ACCESO A LA APLICACIÓN:"
echo "   URL: http://$ALB_DNS"
echo ""

echo "🔑 ACCESO SSH A EC2:"
echo "   Comando:"
echo "   ssh -i ~/.ssh/$SSH_KEY_NAME.pem ec2-user@$ALB_DNS"
echo ""
echo "   O si prefieres por nombre de instancia:"
echo "   aws ssm start-session --target <instance-id> --region $AWS_REGION"
echo ""

echo "💾 BASE DE DATOS (RDS PostgreSQL):"
echo "   Endpoint: $RDS_ENDPOINT"
echo "   Port:     5432"
echo "   Database: $DB_NAME"
echo "   User:     $DB_USERNAME"
echo "   Region:   $AWS_REGION"
echo ""

echo "🖥️  ESTADO DE EC2:"
echo "   Instancias: $EC2_STATUS"
echo "   Stack:      $EC2_STACK_NAME"
echo ""

echo "📍 INFORMACIÓN ADICIONAL:"
echo "   VPC Stack:      $VPC_STACK_NAME"
echo "   RDS Stack:      $RDS_STACK_NAME"
echo "   Región:         $AWS_REGION"
echo "   Proyecto:       $PROJECT_NAME"
echo "   Ambiente:       $ENVIRONMENT"
echo ""

# Health check
if [ "$ALB_DNS" != "❌ Aún no disponible (espera 5 min)" ]; then
    echo -e "${BLUE}🏥 Health Check:${NC}"
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://$ALB_DNS/health" 2>/dev/null || echo "000")

    if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✅ ALB respondiendo correctamente"
    else
        echo "   ⏳ ALB no responde aún (HTTP $HTTP_CODE)"
        echo "   💡 Espera 2-3 minutos más y prueba de nuevo"
    fi
    echo ""
fi

# SSH key check
if [ -f ~/.ssh/$SSH_KEY_NAME.pem ]; then
    echo "✅ Clave SSH encontrada: ~/.ssh/$SSH_KEY_NAME.pem"
else
    echo "❌ Clave SSH NO encontrada: ~/.ssh/$SSH_KEY_NAME.pem"
    echo "   Debe estar en: ~/.ssh/$SSH_KEY_NAME.pem"
fi
echo ""

echo -e "${GREEN}📚 PRÓXIMOS PASOS:${NC}"
echo "   1. Prueba en navegador:"
echo "      http://$ALB_DNS"
echo ""
echo "   2. Conecta por SSH:"
echo "      ssh -i ~/.ssh/$SSH_KEY_NAME.pem ec2-user@$ALB_DNS"
echo ""
echo "   3. Ver logs de la aplicación:"
echo "      sudo tail -f /var/log/examlab/app.log"
echo ""
echo "   4. Ver estado de servicios:"
echo "      sudo systemctl status nginx"
echo "      sudo systemctl status examlab"
echo ""
echo -e "${YELLOW}⏱️  Si algo no responde, espera 3-5 minutos más y prueba de nuevo${NC}"
echo ""

