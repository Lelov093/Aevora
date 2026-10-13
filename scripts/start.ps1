param([switch]$Dev)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:AEVORA_PROJECT_ROOT = $root
$env:CARGO_TARGET_DIR = Join-Path $root '.cache\cargo-target'
Push-Location (Join-Path $root 'apps\desktop')
try {
    if ($Dev) { npm run tauri -- dev } else { npm run tauri -- build --debug --no-bundle; if($LASTEXITCODE -ne 0){throw 'Build failed'}; & (Join-Path $env:CARGO_TARGET_DIR 'debug\aevora-desktop.exe') }
} finally { Pop-Location }
