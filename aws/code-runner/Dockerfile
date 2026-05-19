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
# menos una font genérica o pinta vacío) + libs X11 nativas para AWT.
#
# A diferencia del modo solo-consola, NO removemos las libs X11 — son
# necesarias para que la JVM pueda crear ventanas Swing/AWT contra el
# DISPLAY virtual.
#
# Por qué libXi/libXtst son OBLIGATORIOS — antes el build pasaba pero
# en runtime aparecía:
#   java.lang.UnsatisfiedLinkError: Can't load library:
#     /usr/lib/jvm/.../lib/libawt_xawt.so
# El `libawt_xawt.so` que despacha AWT al display X requiere
#   libXi.so.6  (input device extension — punteros / teclados)
#   libXtst.so.6 (test extension — synthetic events; Swing lo usa
#     internamente aunque la app no genere eventos sintéticos)
# Ambos NO vienen como dependencia transitiva de
# `xorg-x11-server-Xvfb`. Hay que pedirlos explícitamente.
#
# Nota: la imagen base `public.ecr.aws/lambda/python:3.13` (Amazon Linux
# 2023 minimal) NO incluye el binario `which`. Antes intentábamos
# `which javac` para derivar JAVA_HOME y el build fallaba con
#   /bin/sh: line 1: which: command not found
# Usamos `command -v` (built-in POSIX, disponible siempre) en su lugar.
# IMPORTANTE — Hay que pedir EXPLÍCITAMENTE `java-21-amazon-corretto`.
# Si solo se instala `java-21-amazon-corretto-devel`, dnf arrastra como
# dependencia solo `java-21-amazon-corretto-headless` (JRE SIN AWT/Swing
# nativos). En ese caso `libawt_xawt.so` NO está en el filesystem y AWT
# explota con `UnsatisfiedLinkError`. El paquete `java-21-amazon-corretto`
# (sin sufijo) es la JRE completa que incluye los `.so` de AWT.
# Llamada doble: `corretto` + `corretto-devel` upgrade el headless al full
# y agrega javac al mismo tiempo.
RUN dnf install -y \
      java-21-amazon-corretto \
      java-21-amazon-corretto-devel \
      xorg-x11-server-Xvfb \
      libXi \
      libXtst \
      libXrender \
      libXrandr \
      libXcomposite \
      libXcursor \
      libXfixes \
      libXft \
      libXt \
      libXext \
      libX11 \
      freetype \
      fontconfig \
      ImageMagick \
      dejavu-sans-fonts \
      dejavu-serif-fonts \
      liberation-sans-fonts \
 && dnf clean all \
 && rm -rf /var/cache/dnf /var/log/dnf* \
 # Slim: demos/man/src/jmods (no se usan en Lambda).
 && JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")" \
 && rm -rf "$JAVA_HOME/demo" "$JAVA_HOME/man" "$JAVA_HOME/sample" "$JAVA_HOME/jmods" \
 && rm -rf /usr/lib/jvm/*/lib/src.zip

# ImageMagick 7 viene con policy.xml restrictiva por CVE-2016-3714
# (ghostscript / PS / EPS / PDF). Para `import -window root → PNG` no
# tocamos esos formatos, pero a veces el binario falla si la policy
# bloquea coders genéricos. Permitimos PNG explícitamente.
RUN if [ -f /etc/ImageMagick-7/policy.xml ]; then \
      sed -i 's|<policy domain="coder" rights="none" pattern="PNG"|<policy domain="coder" rights="read\|write" pattern="PNG"|g' /etc/ImageMagick-7/policy.xml || true; \
    fi

# Sanity check — falla el build si algo falta. `command -v` reemplaza a
# `which` porque la imagen base AL2023 minimal no lo trae.
#
# Verificación CRÍTICA: `ldd libawt_xawt.so` lista las dependencias
# dinámicas que el .so necesita. Si alguna aparece como "not found",
# el AWT explota en runtime con UnsatisfiedLinkError aunque el binario
# exista. Fallamos el build si pasa eso para no enviar una imagen rota
# a ECR. La JVM está bajo /usr/lib/jvm/java-21-amazon-corretto.<arch>/
# — descubrimos el path con un glob en lugar de hardcodearlo.
RUN java -version \
 && javac -version \
 && command -v Xvfb \
 && command -v import \
 && AWT_XAWT="$(ls /usr/lib/jvm/java-21-amazon-corretto*/lib/libawt_xawt.so 2>/dev/null | head -n1)" \
 && if [ -z "$AWT_XAWT" ] || [ ! -f "$AWT_XAWT" ]; then \
      echo "ERROR: libawt_xawt.so NO EXISTE en el filesystem." >&2 ; \
      echo "Esto suele pasar cuando solo se instala 'java-21-amazon-corretto-devel'" >&2 ; \
      echo "porque dnf arrastra '-headless' (JRE sin AWT). Asegúrate de tener" >&2 ; \
      echo "'java-21-amazon-corretto' (sin sufijo) en el dnf install." >&2 ; \
      echo "Contenido actual de /usr/lib/jvm/:" >&2 ; \
      ls -la /usr/lib/jvm/ >&2 || true ; \
      exit 1 ; \
    fi \
 # libjvm.so vive en <JDK>/lib/server/, no en <JDK>/lib/. El ldd directo
 # falla con "libjvm.so => not found" porque no tiene el LD_LIBRARY_PATH
 # que la JVM setea al arrancar. Esto es FALSO POSITIVO — en runtime
 # Java carga libjvm primero (es ELLA), así que cuando dlopen carga
 # libawt_xawt la dependencia ya está resuelta. Para validar las DEMÁS
 # deps (libXi, libXtst, etc.) replicamos el LD_LIBRARY_PATH real.
 && JDK_LIB_DIR="$(dirname "$AWT_XAWT")" \
 && if [ ! -f "$JDK_LIB_DIR/server/libjvm.so" ]; then \
      echo "ERROR: libjvm.so no está en $JDK_LIB_DIR/server/" >&2 ; \
      ls -la "$JDK_LIB_DIR" >&2 || true ; \
      exit 1 ; \
    fi \
 && echo "Validando deps de $AWT_XAWT (LD_LIBRARY_PATH=$JDK_LIB_DIR:$JDK_LIB_DIR/server)…" \
 && LDD_OUT="$(LD_LIBRARY_PATH="$JDK_LIB_DIR:$JDK_LIB_DIR/server" ldd "$AWT_XAWT")" \
 && if echo "$LDD_OUT" | grep -q "not found"; then \
      echo "ERROR: libawt_xawt.so tiene dependencias faltantes:" >&2 ; \
      echo "$LDD_OUT" | grep "not found" >&2 ; \
      exit 1 ; \
    else \
      echo "✓ libawt_xawt.so existe y resuelve todas sus deps" ; \
    fi

# Handler de Lambda (Python wrapper que llama a javac + java).
COPY app.py ${LAMBDA_TASK_ROOT}/

# Lambda invoca este módulo:función al recibir un request.
CMD ["app.handler"]
