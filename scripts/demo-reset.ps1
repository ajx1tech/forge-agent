# scripts/demo-reset.ps1
# Resets the demo workspace to a completely clean baseline state

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "=========================================="
Write-Host "Forge Demo Reset Script"
Write-Host "=========================================="

$DemoDir = Join-Path $RepoRoot ".demo/flask"

# 1. Reset .demo/flask git working tree if present
if (Test-Path (Join-Path $DemoDir ".git")) {
    Write-Host "Discarding all changes in $DemoDir..."
    git -C $DemoDir checkout .
    git -C $DemoDir clean -fd

    $GitStatus = (git -C $DemoDir status --porcelain)
    if ($GitStatus) {
        Write-Warning "Working tree not clean: $GitStatus"
    } else {
        Write-Host "Git working tree in .demo/flask is completely clean."
    }

    # Clean Python caches
    Get-ChildItem -Path $DemoDir -Recurse -Include "__pycache__", ".pytest_cache" -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    # Verify baseline tests
    $VenvPython = Join-Path $DemoDir ".venv/Scripts/python.exe"
    if (Test-Path $VenvPython) {
        Write-Host "Running baseline verification test: pytest tests/test_cli.py -q..."
        & $VenvPython -m pytest (Join-Path $DemoDir "tests/test_cli.py") -q
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Baseline pytest verification passed."
        } else {
            Write-Warning "Baseline pytest test returned code $LASTEXITCODE."
        }
    }
} else {
    Write-Host ".demo/flask repository not found. Run scripts/setup-flask.ps1 to initialize."
}

# 2. Reset staged temporary files in repository
Get-ChildItem -Path $RepoRoot -Recurse -Include "*.tmp", "*.orig" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "=========================================="
Write-Host "Demo environment reset complete. Ready for evaluation."
Write-Host "=========================================="
