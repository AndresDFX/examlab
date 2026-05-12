# Imagen one-shot para restaurar la DB + migrar users + desplegar edge
# functions a un Supabase NUEVO, sin tener que instalar psql/bun/CLI en
# el host.
#
# Se construye una sola vez (~3 min primer build, después usa caché) y
# se invoca desde scripts/restore.ps1.
#
# Contenido:
#   - psql 17 (cliente PostgreSQL) — para el restore del dump.
#   - bun — para correr scripts/migrate-users.ts.
#   - supabase CLI — para desplegar edge functions.
#   - El script orquestador en /usr/local/bin/restore.sh.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Dependencias base + repo PGDG para psql 17 (Debian bookworm trae 15).
# `unzip` lo necesita el instalador de bun (paso siguiente).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg lsb-release tar unzip \
  && sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list' \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

# Bun (lo necesitamos para scripts/migrate-users.ts).
# Lo instalamos a /opt/bun para que sea predecible (no depende de $HOME).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
ENV PATH="/opt/bun/bin:${PATH}"

# Supabase CLI desde release oficial (binario único, sin npm).
RUN ARCH=$(dpkg --print-architecture) \
  && case "$ARCH" in \
       amd64) SUPA_ARCH="amd64" ;; \
       arm64) SUPA_ARCH="arm64" ;; \
       *) echo "Arquitectura no soportada: $ARCH" && exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${SUPA_ARCH}.tar.gz" \
       -o /tmp/supabase.tar.gz \
  && tar -xzf /tmp/supabase.tar.gz -C /usr/local/bin supabase \
  && rm /tmp/supabase.tar.gz \
  && supabase --version

WORKDIR /workspace

COPY docker/restore.sh /usr/local/bin/restore.sh
RUN chmod +x /usr/local/bin/restore.sh

ENTRYPOINT ["/usr/local/bin/restore.sh"]
