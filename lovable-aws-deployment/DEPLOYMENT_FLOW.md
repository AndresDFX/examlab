# Deployment Flow - Flujo visual completo

Cómo funciona el despliegue de extremo a extremo.

## 📋 Fase 1: CloudShell Setup (5 minutos)

```mermaid
graph LR
    A["cloudshell-setup.sh"] 
    B["Validar<br/>variables"]
    C["Generar<br/>SSH keys"]
    D["GitHub<br/>SSH setup"]
    E["Clonar<br/>repo"]
    F["Import key<br/>a AWS"]
    G["Generar<br/>parámetros CF"]
    H["Deploy script<br/>listo"]
    
    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G --> H
    
    style A fill:#FF9900,stroke:#333,color:#000
    style H fill:#00CC00,stroke:#333,color:#000
```

**Resultado**: Infraestructura lista para desplegarse

---

## 🏗️ Fase 2: CloudFormation Stacks (7 minutos)

```mermaid
graph TB
    subgraph Deploy["deploy-cf.sh"]
        VPC["<b>VPC Stack</b><br/>VPC + 6 Subnets<br/>IGW + NAT<br/>Route Tables"]
        RDS["<b>RDS Stack</b><br/>PostgreSQL 15.4<br/>Backups automáticos<br/>KMS Encryption"]
        EC2["<b>EC2 Stack</b><br/>ALB + ASG<br/>Launch Template<br/>Security Groups"]
    end
    
    Output["✅ Infraestructura AWS<br/>completa y funcional"]
    
    VPC -.->|en paralelo| Output
    RDS -.->|en paralelo| Output
    EC2 -.->|en paralelo| Output
    
    style Deploy fill:#FF9900,stroke:#333,color:#000
    style Output fill:#00CC00,stroke:#333,color:#000
```

### Detalle del VPC Stack
```mermaid
graph TB
    VPC["VPC<br/>10.0.0.0/16"]
    
    subgraph Public["Public Subnets (ALB/EC2)"]
        PUB1["Public 1<br/>10.0.1.0/24"]
        PUB2["Public 2<br/>10.0.2.0/24"]
    end
    
    subgraph Private["Private Subnets (App)"]
        PRV1["Private 1<br/>10.0.10.0/24"]
        PRV2["Private 2<br/>10.0.11.0/24"]
    end
    
    subgraph Database["Database Subnets (RDS)"]
        DB1["DB 1<br/>10.0.20.0/24"]
        DB2["DB 2<br/>10.0.21.0/24"]
    end
    
    IGW["Internet Gateway"]
    NAT["NAT Gateway<br/>(Opcional)"]
    
    VPC --> Public
    VPC --> Private
    VPC --> Database
    Public --> IGW
    Private --> NAT
    
    style VPC fill:#FF9900,stroke:#333,color:#000
    style IGW fill:#4A90E2,stroke:#333,color:#fff
    style NAT fill:#4A90E2,stroke:#333,color:#fff
```

### Detalle del RDS Stack
```mermaid
graph TB
    RDS["RDS PostgreSQL"]
    
    Config["<b>Configuración</b><br/>Instance: db.t3.micro<br/>Storage: 20-100 GB<br/>Version: 15.4"]
    
    Security["<b>Seguridad</b><br/>KMS Encryption<br/>Security Group<br/>Parameter Group"]
    
    HA["<b>Disponibilidad</b><br/>Backups: 7 días<br/>Multi-AZ: Opcional<br/>CloudWatch Logs"]
    
    RDS --> Config
    RDS --> Security
    RDS --> HA
    
    style RDS fill:#146EB4,stroke:#333,color:#fff
```

### Detalle del EC2 Stack
```mermaid
graph TB
    EC2["EC2 Stack"]
    
    ALB["<b>ALB</b><br/>DNS: examlab-alb-*.elb<br/>Health Check: /health<br/>Port: 80/443"]
    
    ASG["<b>Auto Scaling Group</b><br/>Min: 1 instancia<br/>Max: 2 instancias<br/>Initial: 1 instancia"]
    
    LT["<b>Launch Template</b><br/>AMI: Amazon Linux 2<br/>Type: t3.small<br/>SSH Key: examlab-prod"]
    
    UserData["<b>User Data</b><br/>Node.js v20<br/>Nginx<br/>App init"]
    
    SG["<b>Security Groups</b><br/>ALB: 80/443<br/>EC2: 22/80<br/>RDS: 5432"]
    
    EC2 --> ALB
    EC2 --> ASG
    EC2 --> LT
    EC2 --> SG
    LT --> UserData
    
    style EC2 fill:#FF9900,stroke:#333,color:#000
    style ASG fill:#FFA500,stroke:#333,color:#000
```

**Resultado**: Infraestructura AWS completa y funcional

---

## 🚀 Fase 3: Inicialización de EC2 (3 minutos)

```mermaid
graph TB
    A["yum update -y"]
    B["Instalar Node.js v20"]
    C["Instalar Nginx"]
    D["Crear directorios"]
    E["Clonar repo"]
    F["npm install"]
    G["npm build"]
    H["Configurar Nginx"]
    I["Systemd service"]
    J["Iniciar servicios"]
    K["✅ EC2 lista"]
    
    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I --> J
    J --> K
    
    style A fill:#4A90E2,stroke:#333,color:#fff
    style K fill:#00CC00,stroke:#333,color:#000
```

**Resultado**: EC2 lista con aplicación corriendo

---

## 🔄 Fase 4: Health Checks (1 minuto)

```mermaid
graph TB
    Check["Health Check"]
    
    ALB["<b>ALB</b><br/>curl /health<br/>HTTP 200 OK"]
    EC2["<b>EC2 Instances</b><br/>State = running<br/>2/2 health"]
    RDS["<b>RDS Database</b><br/>nc -zv port 5432<br/>Conexión OK"]
    APP["<b>Aplicación</b><br/>curl /<br/>Response 200"]
    SG["<b>Security Groups</b><br/>Puertos abiertos<br/>22/80/443"]
    
    Check --> ALB
    Check --> EC2
    Check --> RDS
    Check --> APP
    Check --> SG
    
    ALB -->|✅| Result["Infraestructura operativa"]
    EC2 -->|✅| Result
    RDS -->|✅| Result
    APP -->|✅| Result
    SG -->|✅| Result
    
    style Check fill:#FF9900,stroke:#333,color:#000
    style Result fill:#00CC00,stroke:#333,color:#000
```

**Resultado**: Confirmación de que todo está online

---

## 💾 Fase 5: Backup (en cualquier momento)

```mermaid
graph TB
    Backup["backup-lovable.sh"]
    
    RDSFull["<b>Método 1: RDS Completo</b><br/>pg_dump + gzip<br/>Backup completo"]
    
    Supabase["<b>Método 2: Supabase</b><br/>SQL Editor<br/>JSON export"]
    
    CSV["<b>Método 3: CSV</b><br/>COPY per table<br/>Excel compatible"]
    
    Restore["<b>Restauración</b><br/>psql < backup.sql<br/>Datos previos"]
    
    S3["(Opcional)<br/>Subir a S3<br/>Long-term storage"]
    
    Backup --> RDSFull
    Backup --> Supabase
    Backup --> CSV
    
    RDSFull --> S3
    RDSFull --> Restore
    Supabase --> Restore
    CSV --> Restore
    
    style Backup fill:#FF9900,stroke:#333,color:#000
    style Restore fill:#00CC00,stroke:#333,color:#000
```

**Resultado**: Datos protegidos y recuperables

---

## 📊 Arquitectura final

```mermaid
graph TB
    Internet["🌐 Internet (80/443)"]
    
    Internet --> ALB["⚖️ ALB<br/>examlab-alb-*.elb"]
    
    ALB --> ASG["🏃 Auto Scaling Group<br/>Min: 1 | Max: 2"]
    
    ASG -->|CPU > 75%<br/>Scale UP| EC2_1["EC2 #1<br/>t3.small<br/>Nginx + Node.js"]
    ASG -->|CPU < 25%<br/>Scale DOWN| EC2_2["EC2 #2<br/>t3.small<br/>Nginx + Node.js"]
    
    EC2_1 --> RDS["🗄️ RDS PostgreSQL<br/>db.t3.micro<br/>20-100 GB<br/>7-day backups<br/>KMS Encrypted"]
    EC2_2 --> RDS
    
    subgraph Supabase["☁️ Supabase Cloud"]
        Auth["🔐 Auth"]
        EdgeFn["⚡ Edge Functions<br/>AI"]
    end
    
    EC2_1 --> Auth
    EC2_1 --> EdgeFn
    EC2_2 --> Auth
    EC2_2 --> EdgeFn
    
    style Internet fill:#4A90E2,stroke:#333,color:#fff
    style ALB fill:#FF9900,stroke:#333,color:#000
    style ASG fill:#FFA500,stroke:#333,color:#000
    style RDS fill:#146EB4,stroke:#333,color:#fff
    style Supabase fill:#00CC00,stroke:#333,color:#000
```

**VPC Networking:**
- VPC: `10.0.0.0/16`
- Public Subnets: `10.0.1-2.0/24` (ALB, EC2)
- Private Subnets: `10.0.10-11.0/24` (App)
- DB Subnets: `10.0.20-21.0/24` (RDS)

**Security:**
- ALB: 80, 443 ← 0.0.0.0/0
- EC2: 22 (SSH), 80 (from ALB)
- RDS: 5432 (from EC2)

---

## 📈 Escalamiento automático

```mermaid
graph LR
    A["CPU: 30%"]
    B["CPU: 50%"]
    C["CPU: 80%"]
    D["CPU: 90%"]
    E["CPU: 60%"]
    F["CPU: 20%"]
    
    A -->|1 instancia| B
    B -->|1 instancia| C
    C -->|Scale UP<br/>Agregar instancia| D
    D -->|2 instancias| E
    E -->|CPU < 75%| F
    F -->|Scale DOWN<br/>Quitar instancia| A
    
    style A fill:#00CC00,stroke:#333,color:#000
    style C fill:#FFD700,stroke:#333,color:#000
    style D fill:#FF4444,stroke:#333,color:#fff
    style F fill:#4A90E2,stroke:#333,color:#fff
```

**Reglas:**
- Si CPU > 75% durante 5 min → Scale UP
- Si CPU < 25% durante 10 min → Scale DOWN
- Máximo: 2 instancias
- Mínimo: 1 instancia

---

## 🔁 Ciclo de vida de un request

```mermaid
graph TB
    A["👤 User Request<br/>HTTP/HTTPS"]
    B["🌐 Internet"]
    C["⚖️ ALB<br/>Route 53 optional"]
    D["🖥️ EC2<br/>Nginx Reverse Proxy<br/>localhost:3000"]
    E["🚀 Node.js App<br/>Express/Next.js<br/>Middleware"]
    F["🗄️ RDS PostgreSQL<br/>Query execution<br/>Transaction handling"]
    G["📤 Response<br/>to client"]
    
    A --> B
    B --> C
    C -->|Health check /health| D
    C -->|sticky sessions| D
    D -->|compression gzip| E
    E -->|SQL| F
    F --> E
    E --> D
    D --> C
    C --> G
    
    style A fill:#4A90E2,stroke:#333,color:#fff
    style C fill:#FF9900,stroke:#333,color:#000
    style D fill:#FFA500,stroke:#333,color:#000
    style F fill:#146EB4,stroke:#333,color:#fff
    style G fill:#00CC00,stroke:#333,color:#000
```

---

## 🔄 Acceso a tu aplicación

**Después del despliegue, el script mostrará:**

```
📍 ACCESO A TU APLICACIÓN:
   HTTP:  http://examlab-alb-prod-123.us-east-1.elb.amazonaws.com

🔑 ACCESO SSH A EC2:
   ssh -i ~/.ssh/examlab-production.pem ec2-user@examlab-alb-prod-123...

💾 BASE DE DATOS:
   Host:     examlab-postgres.xxxxx.us-east-1.rds.amazonaws.com
```

**Para mostrar esta información de nuevo:**
```bash
bash scripts/print-access-info.sh
```

---

## 📋 Checklist de despliegue

- [ ] Editar `cloudshell-vars.env` con tus valores
- [ ] Ejecutar `bash cloudshell-setup.sh`
- [ ] Verificar SSH key agregada a GitHub
- [ ] Ejecutar `bash scripts/deploy-cf.sh`
- [ ] Esperar ~5 minutos a CloudFormation
- [ ] Ejecutar `bash scripts/health-check.sh`
- [ ] Acceder a ALB DNS en navegador
- [ ] Hacer SSH a EC2
- [ ] Configurar dominio (opcional)
- [ ] Habilitar HTTPS (recomendado)
- [ ] Configurar backups automáticos

---

## ⏱️ Tiempos estimados

| Fase | Tiempo | Descripción |
|------|--------|-------------|
| CloudShell Setup | 5 min | Variables, SSH, GitHub |
| CloudFormation Deploy | 7 min | Crear stacks AWS |
| EC2 Initialization | 3 min | Node.js, Nginx, App |
| Health Checks | 1 min | Verificar infraestructura |
| **Total** | **~16 minutos** | Desde cero a producción |

---

## 💰 Costos durante despliegue

| Servicio | Cantidad | Costo/hora | Costo/mes |
|----------|----------|-----------|-----------|
| EC2 t3.small | 1-2 | $0.0208 | $15/instancia |
| ALB | 1 | $0.0225 | $16.20 |
| RDS db.t3.micro | 1 | $0.0175 | $13.14 |
| Data transfer | varies | variable | $0-50 |
| **Total mínimo** | - | - | **~$30** |
| **Total recomendado** | - | - | **~$130** |

