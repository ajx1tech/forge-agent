# scripts/setup-flask.ps1
# Setup script for Pallets Flask 3.1.3 demo environment

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$DemoDir = Join-Path $RepoRoot ".demo/flask"
$ExpectedCommitPrefix = "22d92470"

# 1. Clone pallets/flask tag 3.1.3 if not already present
if (-not (Test-Path (Join-Path $DemoDir ".git"))) {
    Write-Host "Cloning pallets/flask tag 3.1.3 into $DemoDir..."
    $ParentDir = Split-Path -Parent $DemoDir
    if (-not (Test-Path $ParentDir)) {
        New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
    }
    git clone https://github.com/pallets/flask.git --branch 3.1.3 --depth 1 $DemoDir
    if ($LASTEXITCODE -ne 0) {
        throw "git clone failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host ".demo/flask already exists."
}

# 2. Verify git rev-parse HEAD starts with 22d92470
$CommitSha = (git -C $DemoDir rev-parse HEAD).Trim()
Write-Host "HEAD commit is $CommitSha"
if (-not $CommitSha.StartsWith($ExpectedCommitPrefix)) {
    throw "Commit $CommitSha does not start with expected prefix $ExpectedCommitPrefix"
}
Write-Host "Commit verification passed: starts with $ExpectedCommitPrefix"

Push-Location $DemoDir
try {
    # 3. Create .demo/flask/.venv
    $VenvPython = Join-Path $DemoDir ".venv/Scripts/python.exe"
    if (-not (Test-Path $VenvPython)) {
        Write-Host "Creating virtual environment at .venv..."
        python -m venv .venv
        if ($LASTEXITCODE -ne 0) {
            throw "python -m venv failed with exit code $LASTEXITCODE"
        }
    } else {
        Write-Host "Virtual environment already exists."
    }

    # 4. Install pip, -e ., and pytest (pinning pytest < 9 for Flask 3.1.3 monkeypatch compatibility)
    Write-Host "Upgrading pip..."
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) {
        throw "pip upgrade failed with exit code $LASTEXITCODE"
    }

    Write-Host "Installing -e . and pytest..."
    & $VenvPython -m pip install -e . "pytest<9"
    if ($LASTEXITCODE -ne 0) {
        throw "pip install -e . pytest failed with exit code $LASTEXITCODE"
    }

    # 5. Run baseline CLI tests
    Write-Host "Running pytest tests/test_cli.py -q..."
    & $VenvPython -m pytest tests/test_cli.py -q
    if ($LASTEXITCODE -ne 0) {
        throw "pytest failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Host "Flask setup and baseline CLI tests passed successfully."
