# Lambda container image para ejecutar Java en AWS Lambda.
#
# Base: imagen oficial de AWS Lambda Python 3.13 (Amazon Linux 2023).
# Encima instalamos Amazon Corretto 21 (OpenJDK LTS) que está en los
# repos de AL2023 sin firma de terceros.
#
# Tamaño final: ~480MB (cabe en ECR Always Free de 500MB).
#
# Build (AMD64 — Lambda x86_64 por defecto):
#   docker build --platform linux/amd64 -t examlab-code-runner .

FROM public.ecr.aws/lambda/python:3.13

# OpenJDK 21 LTS via Amazon Corretto (paquete oficial de AL2023).
# IMPORTANTE: usamos `-devel` (JDK completo con javac).
# El paquete `-headless` solo trae la JRE, no el compilador.
# El JDK completo agrega libs X11 (~30MB) — innecesarias para una
# Lambda headless. Las borramos abajo para mantener la image bajo el
# límite de 500MB del ECR Always Free.
RUN dnf install -y java-21-amazon-corretto-devel \
 && dnf clean all \
 && rm -rf /var/cache/dnf /var/log/dnf* \
 # Slim: eliminamos demos/man/src/jmods (no se usan en Lambda) y
 # las libs X11 transitivas que vienen con el JDK no-headless. javac
 # y java siguen funcionando.
 && JAVA_HOME=$(dirname $(dirname $(readlink -f $(which javac)))) \
 && rm -rf "$JAVA_HOME/demo" "$JAVA_HOME/man" "$JAVA_HOME/sample" "$JAVA_HOME/jmods" \
 && rm -rf /usr/lib/jvm/*/lib/src.zip \
 && dnf remove -y libX11 libXext libXi libXrender libXtst 2>/dev/null || true

# Sanity check — falla el build si javac no está disponible.
RUN java -version && javac -version

# Handler de Lambda (Python wrapper que llama a javac + java).
COPY app.py ${LAMBDA_TASK_ROOT}/

# Lambda invoca este módulo:función al recibir un request.
CMD ["app.handler"]
