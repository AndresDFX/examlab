# Wrapper para correr el restore completo dentro de Docker.
#
# Lee variables desde docker/restore.env (que tú creas copiando
# docker/restore.env.example), construye la imagen si no existe, y
# corre el container con el repo montado en /workspace.
#
# Uso:
#   .\scripts\restore.ps1                     # Restore completo
#   .\scripts\restore.ps1 -SkipRestore        # Solo users + edge functions
#   .\scripts\restore.ps1 -SkipMigrateUsers   # Restore + edge functions, sin users
#   .\scripts\restore.ps1 -SkipDeployFn       # Restore + users, sin edge functions
#   .\scripts\restore.ps1 -DryRunUsers        # Migra users en dry-run
#   .\scripts\restore.ps1 -Rebuild            # Fuerza rebuild de la imagen Docker
#
# Pre-requisito único: Docker Desktop instalado y corriendo.

[CmdletBinding()]
param(
    [string]$EnvFile = "docker/restore.env",
    [switch]$SkipRestore,
    [switch]$SkipMigrateUsers,
    [switch]$SkipDeployFn,
    [switch]$DryRunUsers,
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"

# ─── Verificar Docker ────────────────────────────────────────────
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
    Write-Error "Docker no está instalado o no está en PATH. Instala Docker Desktop desde https://www.docker.com/products/docker-desktop"
    exit 1
}
$dockerVersion = docker info --format '{{.ServerVersion}}' 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker esta instalado pero no esta corriendo. Abre Docker Desktop y vuelve a intentar."
    exit 1
}

# ─── Cargar env vars desde el archivo ───────────────────────────
if (-not (Test-Path $EnvFile)) {
    Write-Error "No existe $EnvFile. Cópialo desde docker/restore.env.example y completa los valores."
    exit 1
}

$envVars = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
        $key = $matches[1]
        $val = $matches[2].Trim()
        # Quitar comillas envolventes si las hay
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or
            ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $envVars[$key] = $val
    }
}

# Validar requeridos
$required = @(
    "NEW_SUPABASE_PROJECT_REF",
    "NEW_SUPABASE_DB_PASSWORD",
    "NEW_SUPABASE_REGION",
    "NEW_SUPABASE_SERVICE_ROLE_KEY",
    "NEW_SUPABASE_ACCESS_TOKEN"
)
$missing = $required | Where-Object { -not $envVars.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($envVars[$_]) }
if ($missing.Count -gt 0) {
    Write-Error "Faltan variables en ${EnvFile}: $($missing -join ', ')"
    exit 1
}

# ─── Construir imagen Docker si hace falta ──────────────────────
$imageName = "examlab-restore:latest"
# `docker images --format` siempre tiene exit 0 (no escribe a stderr si
# no hay match, solo devuelve lista vacia), asi evitamos que PowerShell
# trate el stderr como excepcion por el $ErrorActionPreference=Stop.
$existingImages = docker images --format '{{.Repository}}:{{.Tag}}' 2>$null
$imageExists = $existingImages -contains $imageName
if ($Rebuild -or -not $imageExists) {
    Write-Host "Construyendo imagen Docker (3-5 min primer build)..." -ForegroundColor Cyan
    docker build -f docker/restore.Dockerfile -t $imageName .
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Fallo el build de la imagen Docker."
        exit 1
    }
} else {
    Write-Host "Imagen $imageName ya existe (usa -Rebuild para forzar rebuild)." -ForegroundColor DarkGray
}

# ─── Armar docker run ───────────────────────────────────────────
$dockerArgs = @(
    "run", "--rm", "-it",
    # Mount del repo. Anonymous volume sobre node_modules para que el
    # container use el suyo (el del host tiene binarios Windows).
    "-v", "${PWD}:/workspace",
    "-v", "/workspace/node_modules",
    "-w", "/workspace"
)

# Inyectar todas las vars del .env como -e KEY=VALUE
foreach ($key in $envVars.Keys) {
    $dockerArgs += @("-e", "${key}=$($envVars[$key])")
}

# Toggles del CLI
if ($SkipRestore)       { $dockerArgs += @("-e", "SKIP_RESTORE=true") }
if ($SkipMigrateUsers)  { $dockerArgs += @("-e", "SKIP_MIGRATE_USERS=true") }
if ($SkipDeployFn)      { $dockerArgs += @("-e", "SKIP_DEPLOY_FN=true") }
if ($DryRunUsers)       { $dockerArgs += @("-e", "DRY_RUN_USERS=true") }

$dockerArgs += $imageName

# ─── Ejecutar ───────────────────────────────────────────────────
Write-Host ""
Write-Host "Ejecutando restore en Docker..." -ForegroundColor Cyan
Write-Host ""
& docker @dockerArgs
$exit = $LASTEXITCODE
if ($exit -ne 0) {
    Write-Host ""
    Write-Error "El restore termino con codigo $exit. Revisa los logs arriba."
    exit $exit
}
