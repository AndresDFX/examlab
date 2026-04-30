# Arquitectura CloudFormation - Diagramas detallados

Visión completa de la arquitectura desplegada en AWS.

## 🏛️ Stack Overview

```mermaid
graph TB
    subgraph CF["CloudFormation Stacks"]
        VPC_STACK["VPC Stack"]
        RDS_STACK["RDS Stack"]
        EC2_STACK["EC2 Stack"]
    end
    
    subgraph External["Servicios Externos"]
        GitHub["GitHub<br/>Repositorio"]
        Supabase["Supabase<br/>Edge Functions<br/>Auth"]
    end
    
    Users["👥 Usuarios"]
    
    Users -->|HTTP/HTTPS| CF
    CF --> GitHub
    CF --> Supabase
    
    style CF fill:#FF9900,stroke:#333,color:#000
    style External fill:#4A90E2,stroke:#333,color:#fff
```

---

## 🌐 VPC Architecture

```mermaid
graph TB
    IGW["🚪 Internet Gateway"]
    NAT["🌐 NAT Gateway<br/>(Opcional)"]
    
    subgraph VPC["VPC: 10.0.0.0/16"]
        subgraph AZ1["Availability Zone 1 (us-east-1a)"]
            PUB1["Public Subnet<br/>10.0.1.0/24<br/>ALB, NAT"]
            PRV1["Private Subnet<br/>10.0.10.0/24<br/>EC2 App"]
            DB1["DB Subnet<br/>10.0.20.0/24<br/>RDS Primary"]
        end
        
        subgraph AZ2["Availability Zone 2 (us-east-1b)"]
            PUB2["Public Subnet<br/>10.0.2.0/24<br/>ALB"]
            PRV2["Private Subnet<br/>10.0.11.0/24<br/>EC2 App"]
            DB2["DB Subnet<br/>10.0.21.0/24<br/>RDS Replica"]
        end
    end
    
    IGW -->|0.0.0.0/0| PUB1
    IGW -->|0.0.0.0/0| PUB2
    
    PUB1 -->|NAT| NAT
    PUB2 -->|NAT| NAT
    
    NAT -->|Egress| PRV1
    NAT -->|Egress| PRV2
    
    PRV1 -->|5432| DB1
    PRV2 -->|5432| DB2
    
    style VPC fill:#FF9900,stroke:#333,color:#000
    style AZ1 fill:#FFA500,stroke:#333,color:#000
    style AZ2 fill:#FFA500,stroke:#333,color:#000
    style IGW fill:#4A90E2,stroke:#333,color:#fff
    style NAT fill:#4A90E2,stroke:#333,color:#fff
```

### Route Tables

```mermaid
graph LR
    subgraph Public["Public Route Table"]
        PRT1["0.0.0.0/0 → IGW<br/>10.0.0.0/16 → Local"]
    end
    
    subgraph Private["Private Route Table"]
        PRT2["0.0.0.0/0 → NAT<br/>10.0.0.0/16 → Local"]
    end
    
    subgraph DB["DB Route Table"]
        PRT3["10.0.0.0/16 → Local<br/>(No internet)"]
    end
    
    PUB["Public Subnets"] --> Public
    PRV["Private Subnets"] --> Private
    RDS["RDS Subnets"] --> DB
    
    style Public fill:#4A90E2,stroke:#333,color:#fff
    style Private fill:#4A90E2,stroke:#333,color:#fff
    style DB fill:#146EB4,stroke:#333,color:#fff
```

---

## 🔐 Security Architecture

```mermaid
graph TB
    Internet["🌐 Internet"]
    
    subgraph SGW["Security Group: ALB"]
        SG1["Ingress:<br/>80 from 0.0.0.0/0<br/>443 from 0.0.0.0/0<br/><br/>Egress:<br/>All traffic"]
    end
    
    subgraph SGE["Security Group: EC2"]
        SG2["Ingress:<br/>22 from 0.0.0.0/0<br/>80 from ALB SG<br/>443 from ALB SG<br/><br/>Egress:<br/>All traffic"]
    end
    
    subgraph SGD["Security Group: RDS"]
        SG3["Ingress:<br/>5432 from EC2 SG<br/><br/>Egress:<br/>None (default)"]
    end
    
    Internet -->|80/443| SG1
    SG1 -->|80| SG2
    SG2 -->|5432| SG3
    
    style SG1 fill:#FF4444,stroke:#333,color:#fff
    style SG2 fill:#FF6666,stroke:#333,color:#fff
    style SG3 fill:#FF8888,stroke:#333,color:#fff
```

---

## 💾 RDS Architecture

```mermaid
graph TB
    subgraph RDS_Primary["RDS Primary Instance"]
        DB["PostgreSQL 15.4<br/>db.t3.micro<br/>20 GB storage"]
        PG["Parameter Group<br/>shared_buffers<br/>work_mem<br/>max_connections"]
        Backup["Automated Backups<br/>7-day retention<br/>Point-in-time recovery"]
    end
    
    subgraph RDS_Security["Security & Monitoring"]
        KMS["KMS Encryption<br/>at rest"]
        CW["CloudWatch Logs<br/>Enhanced Monitoring<br/>Slow queries"]
        SSN["Subnets<br/>Multi-AZ (optional)"]
    end
    
    DB --> PG
    DB --> Backup
    Backup -->|Restore| DB
    
    DB --> KMS
    DB --> CW
    DB --> SSN
    
    style RDS_Primary fill:#146EB4,stroke:#333,color:#fff
    style RDS_Security fill:#0D47A1,stroke:#333,color:#fff
```

---

## 🖥️ EC2 & Scaling Architecture

```mermaid
graph TB
    subgraph ALB_Config["Application Load Balancer"]
        ALB["ALB<br/>examlab-alb-prod<br/>examlab-alb-*.us-east-1.elb"]
        LISTENER["Listener<br/>Port 80<br/>Forward to TG"]
        TG["Target Group<br/>Port 80<br/>Health: /health<br/>Healthy: 200 OK"]
    end
    
    subgraph ASG_Config["Auto Scaling Group"]
        ASG["ASG: examlab-asg-prod<br/>Min: 1<br/>Max: 2<br/>Initial: 1"]
        CPU_UP["Scale UP<br/>Condition: CPU > 75%<br/>Duration: 5 minutes<br/>Add 1 instance"]
        CPU_DOWN["Scale DOWN<br/>Condition: CPU < 25%<br/>Duration: 10 minutes<br/>Remove 1 instance"]
    end
    
    subgraph LT_Config["Launch Template"]
        LT["examlab-lt-prod<br/>AMI: Amazon Linux 2<br/>Type: t3.small<br/>Storage: 30 GB"]
        SG["Security Group<br/>SSH: 22<br/>HTTP: 80 from ALB"]
        KEY["SSH Key<br/>examlab-production<br/>ed25519"]
        USERDATA["User Data Script<br/>Node.js v20<br/>Nginx<br/>App init"]
    end
    
    ALB --> LISTENER
    LISTENER --> TG
    TG --> ASG
    
    ASG --> CPU_UP
    ASG --> CPU_DOWN
    CPU_UP -->|trigger| ASG
    CPU_DOWN -->|trigger| ASG
    
    ASG --> LT
    LT --> SG
    LT --> KEY
    LT --> USERDATA
    
    style ALB_Config fill:#FF9900,stroke:#333,color:#000
    style ASG_Config fill:#FFA500,stroke:#333,color:#000
    style LT_Config fill:#FFB84D,stroke:#333,color:#000
```

### Instance Lifecycle

```mermaid
graph LR
    A["Launch<br/>CloudFormation"]
    B["↓ Download<br/>Amazon Linux 2<br/>AMI"]
    C["↓ User Data<br/>Script runs<br/>system setup"]
    D["↓ Install<br/>Node.js v20<br/>Nginx"]
    E["↓ Clone<br/>GitHub repo<br/>npm install"]
    F["↓ Start<br/>Application<br/>systemd"]
    G["↓ ALB<br/>Health Check<br/>/health"]
    H["✅ InService<br/>Ready for<br/>traffic"]
    
    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G -->|200 OK| H
    
    style A fill:#FF9900,stroke:#333,color:#000
    style H fill:#00CC00,stroke:#333,color:#000
```

---

## 📊 Application Flow Architecture

```mermaid
graph TB
    Client["👥 Client Browser"]
    
    Client -->|HTTPS Request| ALB["⚖️ ALB<br/>Route 53 optional"]
    
    ALB -->|Health Check| HealthCheck["GET /health<br/>Expected: 200"]
    HealthCheck -->|OK| ALB
    
    ALB -->|HTTP :80| Nginx["🖥️ Nginx<br/>Reverse Proxy<br/>localhost:3000<br/>Compression: gzip"]
    
    Nginx -->|3000| Node["🚀 Node.js<br/>Express/Next.js<br/>Middleware Stack<br/>API Routes"]
    
    Node -->|SQL| RDS["🗄️ RDS PostgreSQL<br/>Query Execution<br/>Transaction Control<br/>Connection Pooling"]
    
    Node -->|HTTPS| Supabase["☁️ Supabase<br/>Auth API<br/>Realtime<br/>Edge Functions"]
    
    RDS -->|Result| Node
    Supabase -->|Result| Node
    
    Node -->|Response| Nginx
    Nginx -->|gzip response| ALB
    ALB -->|HTTPS Response| Client
    
    style Client fill:#4A90E2,stroke:#333,color:#fff
    style ALB fill:#FF9900,stroke:#333,color:#000
    style Nginx fill:#FFA500,stroke:#333,color:#000
    style Node fill:#FFD700,stroke:#333,color:#000
    style RDS fill:#146EB4,stroke:#333,color:#fff
    style Supabase fill:#00CC00,stroke:#333,color:#000
```

---

## 🔄 Data Flow: User Request

```mermaid
sequenceDiagram
    actor User
    participant ALB as Load Balancer
    participant Nginx as Nginx
    participant App as Node.js App
    participant RDS as PostgreSQL
    participant Supabase as Supabase

    User->>ALB: HTTP Request
    Note over ALB: Route to healthy instance
    ALB->>Nginx: Forward :80
    
    Nginx->>Nginx: Decompress gzip
    Nginx->>App: Proxy :3000
    
    App->>App: Route handler
    App->>RDS: SQL Query
    RDS-->>App: Result set
    
    par Parallel
        App->>Supabase: Check auth
        Supabase-->>App: Session valid
    and
        App->>RDS: Fetch data
        RDS-->>App: Data
    end
    
    App->>Nginx: JSON Response
    Nginx->>Nginx: Compress gzip
    Nginx->>ALB: HTTP Response
    ALB->>User: HTTPS Response

    Note over User: Render in browser
```

---

## 🔐 Security Layers

```mermaid
graph TB
    Internet["🌐 Internet"]
    
    layer1["Layer 1: Network<br/>Security Group ALB<br/>80/443 from 0.0.0.0/0"]
    
    layer2["Layer 2: WAF<br/>Optional CloudFront<br/>DDoS Protection"]
    
    layer3["Layer 3: Transport<br/>HTTPS/TLS<br/>Certificate validation"]
    
    layer4["Layer 4: Application<br/>Authentication<br/>Rate limiting<br/>Input validation"]
    
    layer5["Layer 5: Database<br/>Security Group RDS<br/>5432 from EC2 only<br/>KMS Encryption"]
    
    Internet --> layer1
    layer1 --> layer2
    layer2 --> layer3
    layer3 --> layer4
    layer4 --> layer5
    
    style Internet fill:#4A90E2,stroke:#333,color:#fff
    style layer1 fill:#FF4444,stroke:#333,color:#fff
    style layer2 fill:#FF6666,stroke:#333,color:#fff
    style layer3 fill:#FF8888,stroke:#333,color:#fff
    style layer4 fill:#FFAA00,stroke:#333,color:#000
    style layer5 fill:#146EB4,stroke:#333,color:#fff
```

---

## 📈 Performance Architecture

```mermaid
graph TB
    subgraph Cache["Caching Layers"]
        CACHE1["ALB<br/>Sticky sessions"]
        CACHE2["Nginx<br/>Gzip compression<br/>Browser cache headers"]
        CACHE3["App<br/>Memory cache<br/>Redis optional"]
        CACHE4["RDS<br/>Query cache<br/>Connection pool"]
    end
    
    subgraph Monitor["Monitoring & Metrics"]
        CW1["CloudWatch<br/>CPU, Memory, Disk"]
        CW2["RDS Logs<br/>Query performance<br/>Connection activity"]
        CW3["ALB Logs<br/>Request/response times<br/>Status codes"]
    end
    
    subgraph Optimize["Optimization"]
        OPT1["Auto Scaling<br/>CPU-based"]
        OPT2["Parameter tuning<br/>shared_buffers<br/>work_mem"]
        OPT3["Index optimization<br/>Query plans"]
    end
    
    CACHE1 --> CW1
    CACHE2 --> CW1
    CACHE3 --> CW1
    CACHE4 --> CW2
    
    CW1 --> OPT1
    CW2 --> OPT2
    CW3 --> OPT3
    
    style Cache fill:#FFA500,stroke:#333,color:#000
    style Monitor fill:#4A90E2,stroke:#333,color:#fff
    style Optimize fill:#00CC00,stroke:#333,color:#000
```

---

## 🔄 Deployment Architecture

```mermaid
graph LR
    Dev["👨‍💻 Developer"]
    
    Dev -->|git push| GitHub["GitHub<br/>Main Branch"]
    
    GitHub -->|Webhook| CI["CI/CD<br/>Optional<br/>GitHub Actions"]
    
    CI -->|Deploy| EC2["EC2<br/>git pull<br/>npm build<br/>restart"]
    
    EC2 -->|Blue-Green| ALB["ALB<br/>Switch traffic<br/>Zero downtime"]
    
    ALB -->|Health Check| Nginx["Nginx<br/>/ health route"]
    
    Nginx -->|if 200 OK| Traffic["Traffic enabled"]
    Nginx -->|if timeout| Rollback["Rollback<br/>previous version"]
    
    Traffic -->|Monitoring| CW["CloudWatch<br/>Logs & Metrics"]
    CW -->|Alert on error| Dev
    
    style GitHub fill:#000000,stroke:#333,color:#fff
    style CI fill:#FF9900,stroke:#333,color:#000
    style EC2 fill:#FFA500,stroke:#333,color:#000
    style ALB fill:#FFD700,stroke:#333,color:#000
    style Traffic fill:#00CC00,stroke:#333,color:#000
```

---

## 💰 Cost Structure

```mermaid
graph TB
    subgraph Compute["Compute"]
        EC2["EC2 t3.small<br/>$0.0208/hr<br/>~$15/month"]
        ALB["ALB<br/>$0.0225/hr<br/>~$16/month"]
    end
    
    subgraph Database["Database"]
        RDS["RDS db.t3.micro<br/>$0.0175/hr<br/>~$13/month"]
        Storage["Storage<br/>20-100 GB<br/>$0.10/GB/month"]
    end
    
    subgraph Network["Network"]
        Transfer["Data Transfer<br/>varies<br/>$0-50/month"]
        Backup["RDS Backups<br/>Included<br/>$0"]
    end
    
    subgraph External["External Services"]
        Supabase["Supabase<br/>Edge Functions<br/>Free to 2M<br/>$0-10/month"]
        AI["AI API<br/>Anthropic<br/>Pay per token<br/>$10-100/month"]
    end
    
    Total["💰 TOTAL<br/>~$30-130/month"]
    
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

