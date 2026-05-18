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
# `headless` evita libs gráficas innecesarias (~150MB de ahorro).
RUN dnf install -y java-21-amazon-corretto-headless \
 && dnf clean all \
 && rm -rf /var/cache/dnf /var/log/dnf*

# Sanity check — falla el build si javac no está disponible.
RUN java -version && javac -version

# Handler de Lambda (Python wrapper que llama a javac + java).
COPY app.py ${LAMBDA_TASK_ROOT}/

# Lambda invoca este módulo:función al recibir un request.
CMD ["app.handler"]
