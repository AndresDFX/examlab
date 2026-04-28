# 📊 Guía Visual Completa - Todos los Diagramas

Acceso rápido a todos los diagramas Mermaid de la documentación.

## 🎯 Diagramas por categoría

### 🚀 Despliegue y Setup

#### 1. Inicio Rápido (3 pasos)
```mermaid
graph LR
    A["1. CloudShell"]
    B["2. git clone"]
    C["3. bash setup"]
    D["4. Deploy"]
    E["✅ Producción"]
    
    A --> B
    B --> C
    C --> D
    D --> E
    
    style E fill:#00CC00,stroke:#333,color:#000
```

#### 2. CloudShell Setup Phase
```mermaid
graph LR
    A["cloudshell-setup.sh"] 
    B["Validar variables"]
    C["SSH keys"]
    D["GitHub setup"]
    E["Clonar repo"]
    F["Import AWS"]
    G["Parameters"]
    H["✅ Listo"]
    
    A --> B --> C --> D --> E --> F --> G --> H
    
    style H fill:#00CC00,stroke:#333,color:#000
```

#### 3. CloudFormation Stacks (Paralelo)
```mermaid
graph TB
    Setup["deploy-cf.sh<br/>Ejecuta 3 stacks"]
    
    VPC["VPC Stack<br/>Networking<br/>Subnets + IGW"]
    
    RDS["RDS Stack<br/>PostgreSQL<br/>Backups"]
    
    EC2["EC2 Stack<br/>ALB + ASG<br/>Node.js"]
    
    Complete["✅ Infrastructure<br/>Complete"]
    
    Setup -.->|paralelo| VPC
    Setup -.->|paralelo| RDS
    Setup -.->|paralelo| EC2
    
    VPC --> Complete
    RDS --> Complete
    EC2 --> Complete
    
    style Complete fill:#00CC00,stroke:#333,color:#000
```

---

### 🏛️ Arquitectura General

#### 4. AWS + Supabase Integration
```mermaid
graph TB
    Internet["🌐 Internet"]
    
    subgraph AWS["AWS (Tu infraestructura)"]
        EC2["EC2 - Aplicación"]
        RDS["RDS - PostgreSQL"]
    end
    
    subgraph Cloud["Supabase Cloud"]
        Auth["🔐 Auth"]
        EdgeFn["⚡ Edge Functions<br/>IA"]
    end
    
    Internet -->|HTTP/HTTPS| EC2
    EC2 -->|SQL| RDS
    EC2 -->|HTTPS| Auth
    EC2 -->|POST| EdgeFn
    
    style AWS fill:#FF9900,stroke:#333,color:#000
    style Cloud fill:#00CC00,stroke:#333,color:#000
```

#### 5. CloudFormation Stack Overview
```mermaid
graph TD
    VPC["VPC Stack<br/>10.0.0.0/16"]
    
    RDS["RDS Stack<br/>PostgreSQL"]
    
    EC2["EC2 Stack<br/>ALB + ASG"]
    
    ALB["Load Balancer"]
    
    ASG["Auto Scaling<br/>1-2 instancias"]
    
    LT["Launch Template<br/>t3.small"]
    
    VPC --> RDS
    VPC --> ALB
    VPC --> ASG
    ALB --> ASG
    ASG --> LT
    
    style VPC fill:#FF9900,stroke:#333,color:#000
    style RDS fill:#146EB4,stroke:#333,color:#fff
```

---

### 🌐 Networking

#### 6. VPC Architecture (2 AZ)
```mermaid
graph TB
    IGW["🚪 Internet Gateway"]
    NAT["🌐 NAT Gateway"]
    
    subgraph VPC["VPC: 10.0.0.0/16"]
        subgraph AZ1["AZ 1"]
            PUB1["Public 10.0.1.0/24"]
            PRV1["Private 10.0.10.0/24"]
            DB1["DB 10.0.20.0/24"]
        end
        
        subgraph AZ2["AZ 2"]
            PUB2["Public 10.0.2.0/24"]
            PRV2["Private 10.0.11.0/24"]
            DB2["DB 10.0.21.0/24"]
        end
    end
    
    IGW -->|Route| PUB1
    IGW -->|Route| PUB2
    NAT -->|Route| PRV1
    NAT -->|Route| PRV2
    
    style VPC fill:#FF9900,stroke:#333,color:#000
    style AZ1 fill:#FFA500,stroke:#333,color:#000
    style AZ2 fill:#FFA500,stroke:#333,color:#000
```

#### 7. Route Tables
```mermaid
graph LR
    Public["<b>Public Route</b><br/>0.0.0.0/0 → IGW<br/>10.0.0.0/16 → Local"]
    
    Private["<b>Private Route</b><br/>0.0.0.0/0 → NAT<br/>10.0.0.0/16 → Local"]
    
    DB["<b>DB Route</b><br/>10.0.0.0/16 → Local<br/>(No internet)"]
    
    style Public fill:#4A90E2,stroke:#333,color:#fff
    style Private fill:#4A90E2,stroke:#333,color:#fff
    style DB fill:#146EB4,stroke:#333,color:#fff
```

---

### 🔐 Security

#### 8. Security Groups Hierarchy
```mermaid
graph TB
    Internet["🌐 Internet<br/>0.0.0.0/0"]
    
    subgraph ALB_SG["Security Group: ALB"]
        ALB_IN["Ingress:<br/>80 from 0.0.0.0/0<br/>443 from 0.0.0.0/0"]
    end
    
    subgraph EC2_SG["Security Group: EC2"]
        EC2_IN["Ingress:<br/>22 from 0.0.0.0/0<br/>80 from ALB SG"]
    end
    
    subgraph RDS_SG["Security Group: RDS"]
        RDS_IN["Ingress:<br/>5432 from EC2 SG"]
    end
    
    Internet --> ALB_IN
    ALB_IN -->|Port 80| EC2_IN
    EC2_IN -->|Port 5432| RDS_IN
    
    style Internet fill:#4A90E2,stroke:#333,color:#fff
    style ALB_SG fill:#FF4444,stroke:#333,color:#fff
    style EC2_SG fill:#FF6666,stroke:#333,color:#fff
    style RDS_SG fill:#FF8888,stroke:#333,color:#fff
```

#### 9. Security Layers
```mermaid
graph TB
    Layer1["Layer 1: Network<br/>Security Groups<br/>Ports & Access"]
    
    Layer2["Layer 2: Transport<br/>HTTPS/TLS<br/>Certificate"]
    
    Layer3["Layer 3: Application<br/>Authentication<br/>Rate Limiting"]
    
    Layer4["Layer 4: Database<br/>KMS Encryption<br/>Backups"]
    
    Layer1 --> Layer2
    Layer2 --> Layer3
    Layer3 --> Layer4
    
    style Layer1 fill:#FF4444,stroke:#333,color:#fff
    style Layer2 fill:#FF6666,stroke:#333,color:#fff
    style Layer3 fill:#FF8888,stroke:#333,color:#fff
    style Layer4 fill:#146EB4,stroke:#333,color:#fff
```

---

### 💾 Database

#### 10. RDS Architecture
```mermaid
graph TB
    subgraph RDS["RDS Instance"]
        DB["PostgreSQL 15.4<br/>db.t3.micro"]
        
        CONFIG["Config:<br/>shared_buffers<br/>work_mem"]
        
        BACKUP["Backups:<br/>7 days<br/>Point-in-time"]
    end
    
    subgraph Security["Security"]
        KMS["KMS Encryption<br/>At rest"]
        
        CW["CloudWatch<br/>Monitoring"]
    end
    
    DB --> CONFIG
    DB --> BACKUP
    DB --> KMS
    DB --> CW
    
    style RDS fill:#146EB4,stroke:#333,color:#fff
    style Security fill:#0D47A1,stroke:#333,color:#fff
```

---

### 🖥️ Compute

#### 11. EC2 & Auto Scaling
```mermaid
graph TB
    subgraph ALB_L["Load Balancer"]
        ALB["ALB<br/>examlab-alb-prod"]
        TG["Target Group<br/>Health: /health"]
    end
    
    subgraph ASG_L["Auto Scaling"]
        ASG["Min: 1 | Max: 2"]
        SCALE_UP["CPU > 75%<br/>Add instance"]
        SCALE_DOWN["CPU < 25%<br/>Remove instance"]
    end
    
    subgraph LT_L["Launch Template"]
        LT["Amazon Linux 2<br/>t3.small"]
        APP["Node.js v20<br/>Nginx<br/>App"]
    end
    
    ALB --> TG
    TG --> ASG
    ASG --> SCALE_UP
    ASG --> SCALE_DOWN
    SCALE_UP -->|trigger| ASG
    SCALE_DOWN -->|trigger| ASG
    
    ASG --> LT
    LT --> APP
    
    style ALB_L fill:#FF9900,stroke:#333,color:#000
    style ASG_L fill:#FFA500,stroke:#333,color:#000
    style LT_L fill:#FFB84D,stroke:#333,color:#000
```

#### 12. EC2 Instance Lifecycle
```mermaid
graph LR
    A["CloudFormation<br/>Launch"]
    
    B["Download<br/>Amazon Linux 2"]
    
    C["User Data<br/>Execute script"]
    
    D["Install<br/>Node.js v20<br/>Nginx"]
    
    E["Clone repo<br/>npm install"]
    
    F["Start<br/>Application"]
    
    G["Health Check<br/>/health"]
    
    H["✅ InService<br/>Ready"]
    
    A --> B --> C --> D --> E --> F --> G
    G -->|200 OK| H
    
    style A fill:#FF9900,stroke:#333,color:#000
    style H fill:#00CC00,stroke:#333,color:#000
```

---

### 📊 Application Flow

#### 13. Request Lifecycle
```mermaid
graph TB
    Client["👤 Client<br/>Browser"]
    
    Client -->|HTTPS| ALB["⚖️ ALB<br/>Route 53 optional"]
    
    ALB -->|Health| HC["GET /health<br/>Expected: 200"]
    HC -->|OK| ALB
    
    ALB -->|HTTP :80| Nginx["🖥️ Nginx<br/>Reverse Proxy<br/>localhost:3000"]
    
    Nginx -->|:3000| Node["🚀 Node.js<br/>Express/Next.js<br/>Middleware"]
    
    Node -->|SQL| RDS["🗄️ RDS PostgreSQL<br/>Query execution"]
    
    Node -->|HTTPS| Supabase["☁️ Supabase<br/>Auth & Edge Fn"]
    
    RDS -->|Result| Node
    Supabase -->|Result| Node
    
    Node -->|Response| Nginx
    Nginx -->|gzip| ALB
    ALB -->|HTTPS| Client
    
    style Client fill:#4A90E2,stroke:#333,color:#fff
    style ALB fill:#FF9900,stroke:#333,color:#000
    style Nginx fill:#FFA500,stroke:#333,color:#000
    style Node fill:#FFD700,stroke:#333,color:#000
    style RDS fill:#146EB4,stroke:#333,color:#fff
    style Supabase fill:#00CC00,stroke:#333,color:#000
```

#### 14. Request Data Flow (Sequence)
```mermaid
sequenceDiagram
    actor User
    participant ALB
    participant Nginx
    participant App as Node.js
    participant RDS
    participant Supabase

    User->>ALB: HTTP Request
    Note over ALB: Route to healthy instance
    ALB->>Nginx: Forward :80
    
    Nginx->>App: Proxy :3000
    App->>App: Process
    
    par Database
        App->>RDS: SQL Query
        RDS-->>App: Result
    and Authentication
        App->>Supabase: Verify token
        Supabase-->>App: Valid
    end
    
    App->>Nginx: JSON Response
    Nginx->>ALB: HTTP Response
    ALB->>User: HTTPS Response

    Note over User: Render in browser
```

---

### 📈 Scaling

#### 15. Auto Scaling Decision Tree
```mermaid
graph TD
    Monitor["CPU Monitor<br/>Every 60s"]
    
    Check1{"CPU > 75%<br/>for 5 min?"}
    
    Check2{"CPU < 25%<br/>for 10 min?"}
    
    AtMax{"Already<br/>2 instances?"}
    
    AtMin{"Already<br/>1 instance?"}
    
    ScaleUp["Scale UP<br/>Add 1 instance"]
    
    ScaleDown["Scale DOWN<br/>Remove 1 instance"]
    
    Monitor --> Check1
    Monitor --> Check2
    
    Check1 -->|Yes| AtMax
    AtMax -->|No| ScaleUp
    AtMax -->|Yes| Monitor
    
    Check2 -->|Yes| AtMin
    AtMin -->|No| ScaleDown
    AtMin -->|Yes| Monitor
    
    ScaleUp --> Monitor
    ScaleDown --> Monitor
    
    style Monitor fill:#FF9900,stroke:#333,color:#000
    style ScaleUp fill:#FF4444,stroke:#333,color:#fff
    style ScaleDown fill:#4A90E2,stroke:#333,color:#fff
```

#### 16. CPU Scaling Example Timeline
```mermaid
graph LR
    H1["Hora 1<br/>CPU 30%<br/>1 instance"]
    
    H2["Hora 2<br/>CPU 80%<br/>Escala UP"]
    
    H3["Hora 2b<br/>CPU 60%<br/>2 instances"]
    
    H4["Hora 3<br/>CPU 20%<br/>Escala DOWN"]
    
    H5["Hora 4<br/>CPU 90%<br/>Escala UP"]
    
    H1 -->|stable| H2
    H2 -->|scale| H3
    H3 -->|decrease| H4
    H4 -->|stable| H5
    
    style H1 fill:#00CC00,stroke:#333,color:#000
    style H2 fill:#FF4444,stroke:#333,color:#fff
    style H3 fill:#FFA500,stroke:#333,color:#000
    style H4 fill:#4A90E2,stroke:#333,color:#fff
    style H5 fill:#FF4444,stroke:#333,color:#fff
```

---

### 🔄 Deployment

#### 17. Continuous Deployment Flow
```mermaid
graph TB
    A["git push<br/>origin main"]
    
    B["EC2 recibe<br/>webhook"]
    
    C["git pull<br/>npm install<br/>npm build"]
    
    D["systemctl restart<br/>Zero downtime<br/>Nginx keeps running"]
    
    E["ALB checks<br/>/health endpoint"]
    
    F["Health OK?"]
    
    G["Include en<br/>target group"]
    
    H["✅ Nuevo código<br/>en producción"]
    
    I["❌ Mantener<br/>versión anterior"]
    
    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    
    F -->|Sí| G
    F -->|No| I
    
    G --> H
    
    style H fill:#00CC00,stroke:#333,color:#000
    style I fill:#FF4444,stroke:#333,color:#fff
```

---

### 💰 Costs

#### 18. Cost Breakdown
```mermaid
graph TB
    Total["💰 TOTAL<br/>~$30-130/month"]
    
    Compute["Compute<br/>EC2 + ALB<br/>$30-40"]
    
    Database["Database<br/>RDS<br/>$13-30"]
    
    Network["Network<br/>Data transfer<br/>$0-50"]
    
    External["External<br/>Supabase + AI<br/>$0-50"]
    
    Compute --> Total
    Database --> Total
    Network --> Total
    External --> Total
    
    style Total fill:#00CC00,stroke:#333,color:#000
    style Compute fill:#FF9900,stroke:#333,color:#000
    style Database fill:#146EB4,stroke:#333,color:#fff
    style Network fill:#4A90E2,stroke:#333,color:#fff
    style External fill:#4A90E2,stroke:#333,color:#fff
```

---

## 🎓 Cómo leer estos diagramas

1. **Empieza por arriba/izquierda** - El flujo va en esa dirección
2. **Sigue las flechas** - Indican dependencias y flujo
3. **Busca por color**:
   - 🟠 Orange = AWS
   - 🔵 Blue = Externos
   - 🔷 Dark Blue = Database
   - 🟢 Green = Success
4. **Lee los labels** - Contienen detalles técnicos
5. **Zoom si es necesario** - En navegadores puedes hacer zoom

---

## 📚 Referencias cruzadas

| Diagrama | Ubicación | Propósito |
|----------|-----------|-----------|
| 1. Quick Start | README.md | Visión general |
| 2. Setup Phase | DEPLOYMENT_FLOW.md | Fase 1 |
| 3. CloudFormation | DEPLOYMENT_FLOW.md | Fase 2 |
| 4. AWS+Supabase | docs/AI_SUPABASE_ONLY.md | IA |
| 5. Stack Overview | docs/ARCHITECTURE.md | General |
| 6. VPC | docs/ARCHITECTURE.md | Networking |
| 7. Routes | docs/ARCHITECTURE.md | Networks |
| 8. Security Groups | docs/ARCHITECTURE.md | Security |
| 9. Layers | docs/ARCHITECTURE.md | Seguridad |
| 10. RDS | docs/ARCHITECTURE.md | Database |
| 11. EC2 + ASG | docs/ARCHITECTURE.md | Compute |
| 12. Lifecycle | docs/ARCHITECTURE.md | Setup |
| 13. Requests | docs/ARCHITECTURE.md | App Flow |
| 14. Sequence | docs/ARCHITECTURE.md | Detailed |
| 15. Scaling | DEPLOYMENT_FLOW.md | Auto Scaling |
| 16. Timeline | DEPLOYMENT_FLOW.md | Example |
| 17. Deployment | DEPLOYMENT_FLOW.md | CI/CD |
| 18. Costs | docs/ARCHITECTURE.md | Budget |

---

## 🔄 Flujo recomendado de lectura

**Opción A: DevOps (2 horas)**
1. Diagrama 1 (Quick Start) - 5 min
2. Diagramas 2-3 (Deployment) - 15 min
3. Diagramas 4-5 (Architecture) - 20 min
4. Diagramas 6-9 (Networking & Security) - 30 min
5. Diagramas 10-12 (Compute & Database) - 20 min
6. Diagramas 13-18 (Application & Costs) - 30 min

**Opción B: Developer (1 hora)**
1. Diagrama 1 (Quick Start) - 5 min
2. Diagramas 2-3 (Setup & Deploy) - 15 min
3. Diagrama 5 (Stack Overview) - 10 min
4. Diagrama 13 (Request Flow) - 15 min
5. Diagrama 17 (Deployment) - 10 min
6. Ejecutar: `bash cloudshell-setup.sh` - 5 min

**Opción C: PM/Manager (30 min)**
1. Diagrama 1 (Quick Start) - 5 min
2. Diagrama 5 (Stack Overview) - 5 min
3. Diagrama 18 (Costs) - 10 min
4. Diagramas 15-16 (Scaling) - 10 min

---

## 💡 Pro Tips

1. **Exportar diagramas** - Usa `mmdc` para PNG/SVG/PDF
2. **Integrar en Confluence** - Exporta y carga como imagen
3. **Presentar a stakeholders** - Los diagramas 1, 5, 18 son best
4. **Entrenar nuevos devs** - Sigue la ruta A (DevOps)
5. **Troubleshooting** - Consulta docs/TROUBLESHOOTING.md

---

**Última actualización:** 2026-04-28
**Version:** 2.0 (Diagramas Mermaid)

