# Lambda container image para ejecutar Java en AWS Lambda.
#
# Base: imagen oficial de AWS Lambda Python 3.13 (Amazon Linux 2023).
# Encima instalamos Amazon Corretto 21 (OpenJDK LTS) que está en los
# repos de AL2023 sin firma de terceros.
#
# Capacidades:
#  - Modo `run` (default): compila + ejecuta Java por consola.
#  - Modo `gui_screenshot`: ejecuta Java Swing/AWT/JavaFX bajo Xvfb
#    (display virtual sin pantalla) y captura un PNG del frame, base64
#    al cliente. Ver opción 2 en docs/JAVA-GUI-OPTIONS.md.
#
# Tamaño final: ~620MB (sube ~140MB respecto al modo solo-consola por
# Xvfb + ImageMagick + libs X11). Cabe holgado en ECR si mantienes
# pocas tags antiguas — el deploy script setea lifecycle policy.
#
# Build (AMD64 — Lambda x86_64 por defecto):
#   docker build --platform linux/amd64 -t examlab-code-runner .

FROM public.ecr.aws/lambda/python:3.13

# OpenJDK 21 LTS + Xvfb (X virtual framebuffer) + ImageMagick (binario
# `import` para capturar el root window) + fuentes (Swing necesita al
# menos una font genérica o pinta vacío).
#
# A diferencia del modo solo-consola, NO removemos las libs X11 — son
# necesarias para que la JVM pueda crear ventanas Swing/AWT contra el
# DISPLAY virtual.
RUN dnf install -y \
      java-21-amazon-corretto-devel \
      xorg-x11-server-Xvfb \
      ImageMagick \
      dejavu-sans-fonts \
      dejavu-serif-fonts \
      liberation-sans-fonts \
 && dnf clean all \
 && rm -rf /var/cache/dnf /var/log/dnf* \
 # Slim: demos/man/src/jmods (no se usan en Lambda).
 && JAVA_HOME=$(dirname $(dirname $(readlink -f $(which javac)))) \
 && rm -rf "$JAVA_HOME/demo" "$JAVA_HOME/man" "$JAVA_HOME/sample" "$JAVA_HOME/jmods" \
 && rm -rf /usr/lib/jvm/*/lib/src.zip

# ImageMagick 7 viene con policy.xml restrictiva por CVE-2016-3714
# (ghostscript / PS / EPS / PDF). Para `import -window root → PNG` no
# tocamos esos formatos, pero a veces el binario falla si la policy
# bloquea coders genéricos. Permitimos PNG explícitamente.
RUN if [ -f /etc/ImageMagick-7/policy.xml ]; then \
      sed -i 's|<policy domain="coder" rights="none" pattern="PNG"|<policy domain="coder" rights="read\|write" pattern="PNG"|g' /etc/ImageMagick-7/policy.xml || true; \
    fi

# Sanity check — falla el build si algo falta.
RUN java -version \
 && javac -version \
 && which Xvfb \
 && which import

# Handler de Lambda (Python wrapper que llama a javac + java).
COPY app.py ${LAMBDA_TASK_ROOT}/

# Lambda invoca este módulo:función al recibir un request.
CMD ["app.handler"]
