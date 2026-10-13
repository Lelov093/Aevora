$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $env:UV_CACHE_DIR = Join-Path $root '.cache\uv'
    uv sync --locked --no-dev
    if ($LASTEXITCODE -ne 0) { throw 'uv sync failed' }
    & '.\.venv\Scripts\python.exe' scripts/generate_protocol.py
    if ($LASTEXITCODE -ne 0) { throw 'Protocol generation failed' }
    Push-Location apps/desktop
    try { npm ci --cache ../../.cache/npm; if($LASTEXITCODE -ne 0){throw 'npm ci failed'} } finally { Pop-Location }
} finally { Pop-Location }
