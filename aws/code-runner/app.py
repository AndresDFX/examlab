"""
AWS Lambda handler — compila y ejecuta código Java del estudiante.

Invocado vía Lambda Function URL (sin API Gateway). El edge function
`execute-code` de Supabase llama esta URL con shared secret en
`X-API-Key`. El handler valida, compila con javac, ejecuta con java,
y retorna stdout/stderr/exitCode.

Seguridad:
 - Lambda corre en Firecracker microVM (sandbox real por invocación).
 - IAM role del Lambda NO tiene permisos AWS — el código del alumno
   no puede llamar S3, DynamoDB, etc.
 - Sin VPC attachment — sin acceso a tu infra.
 - Timeout duro (Lambda timeout + subprocess timeout en Python).
 - Memoria límite (Lambda OOM-kill si pasa 1GB).
 - Tamaño máx del código limitado para evitar bombs.
"""

import json
import os
import re
import shlex
import subprocess
import tempfile
import time

# Shared secret — el cliente debe mandarlo en X-API-Key. Si la env var
# está vacía rechazamos TODAS las llamadas para evitar despliegues
# accidentales sin auth.
API_KEY = os.environ.get("API_KEY", "")

# Timeouts en segundos. La compilación raramente excede 5s; la ejecución
# del código del alumno tiene su propio límite. Combinados deben caber
# en el timeout de Lambda (configurable en CloudFormation).
COMPILE_TIMEOUT_S = 15
EXECUTE_TIMEOUT_S = 15
MAX_SOURCE_BYTES = 100_000  # 100 KB
MAX_STDIN_BYTES = 10_000

# Captura del nombre de la clase pública para invocar `java <Name>`.
# Si no encuentra, asume `Main` (convención del editor del alumno).
CLASS_RE = re.compile(r"public\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)")


def _resp(status: int, body: dict) -> dict:
    """Formato de respuesta de Lambda Function URL."""
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _truncate(s: str, limit: int = 50_000) -> str:
    """Trunca strings largos para no inflar respuestas (ej. loops que imprimen MB)."""
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n... [truncado, +{len(s) - limit} caracteres]"


def handler(event, _context):
    # ── Auth: X-API-Key ──
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    provided = headers.get("x-api-key", "")
    if not API_KEY:
        return _resp(503, {"error": "Runner sin API_KEY configurada"})
    if provided != API_KEY:
        return _resp(401, {"error": "Unauthorized"})

    # ── Method check ──
    method = (
        event.get("requestContext", {}).get("http", {}).get("method", "POST")
    )
    if method.upper() != "POST":
        return _resp(405, {"error": "Method not allowed"})

    # ── Parse body ──
    body_raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64
        body_raw = base64.b64decode(body_raw).decode("utf-8", "replace")
    try:
        body = json.loads(body_raw)
    except json.JSONDecodeError:
        return _resp(400, {"error": "Body no es JSON válido"})

    source = body.get("sourceCode", "")
    stdin = body.get("stdin", "") or ""
    if not isinstance(source, str) or not source.strip():
        return _resp(400, {"error": "sourceCode requerido"})
    if not isinstance(stdin, str):
        return _resp(400, {"error": "stdin debe ser string"})
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        return _resp(400, {"error": f"Código demasiado largo (máx {MAX_SOURCE_BYTES} bytes)"})
    if len(stdin.encode("utf-8")) > MAX_STDIN_BYTES:
        return _resp(400, {"error": f"stdin demasiado largo (máx {MAX_STDIN_BYTES} bytes)"})

    # ── Derivar nombre de la clase pública ──
    m = CLASS_RE.search(source)
    main_class = m.group(1) if m else "Main"

    start = time.time()
    # /tmp es escribible en Lambda (512MB-10GB ephemeral); TemporaryDirectory
    # se borra al salir del with.
    with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
        source_path = os.path.join(tmp, f"{main_class}.java")
        with open(source_path, "w", encoding="utf-8") as f:
            f.write(source)

        # ── Compilar ──
        try:
            compile_proc = subprocess.run(
                ["javac", "-encoding", "UTF-8", "-d", tmp, source_path],
                capture_output=True,
                text=True,
                timeout=COMPILE_TIMEOUT_S,
                cwd=tmp,
            )
        except subprocess.TimeoutExpired:
            return _resp(200, {
                "stdout": "",
                "stderr": f"Compilación excedió el tiempo límite ({COMPILE_TIMEOUT_S}s).",
                "exitCode": 124,
                "executionTimeMs": int((time.time() - start) * 1000),
            })

        if compile_proc.returncode != 0:
            # Compile error: stderr de javac trae línea + columna + mensaje.
            # Lo devolvemos tal cual (es exactamente lo que el alumno necesita ver).
            return _resp(200, {
                "stdout": "",
                "stderr": _truncate(compile_proc.stderr or "Error de compilación"),
                "exitCode": compile_proc.returncode,
                "executionTimeMs": int((time.time() - start) * 1000),
            })

        # ── Ejecutar ──
        # -Xmx512m limita el heap; Lambda matará si pasa el memoryLimit
        # general, pero esto da error JVM-friendly en lugar de OOM-kill.
        try:
            run_proc = subprocess.run(
                ["java", "-Xmx512m", "-cp", tmp, main_class],
                input=stdin,
                capture_output=True,
                text=True,
                timeout=EXECUTE_TIMEOUT_S,
            )
            return _resp(200, {
                "stdout": _truncate(run_proc.stdout),
                "stderr": _truncate(run_proc.stderr),
                "exitCode": run_proc.returncode,
                "executionTimeMs": int((time.time() - start) * 1000),
            })
        except subprocess.TimeoutExpired:
            return _resp(200, {
                "stdout": "",
                "stderr": f"Ejecución excedió el tiempo límite ({EXECUTE_TIMEOUT_S}s). ¿Bucle infinito?",
                "exitCode": 124,
                "executionTimeMs": EXECUTE_TIMEOUT_S * 1000,
            })
