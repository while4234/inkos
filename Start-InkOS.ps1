[CmdletBinding()]
param(
    [string]$ProjectRoot = 'D:\inkos-data\default',
    [ValidateRange(1, 65535)]
    [int]$Port = 4567
)

$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$cliEntry = Join-Path $sourceRoot 'packages\cli\dist\index.js'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not available on PATH.'
}

if (-not (Test-Path -LiteralPath $cliEntry -PathType Leaf)) {
    throw 'InkOS is not built. Run the documented pnpm 9 install and build commands first.'
}

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $ProjectRoot -Force | Out-Null
}

Push-Location -LiteralPath $ProjectRoot
try {
    & node $cliEntry studio -p $Port
    if ($LASTEXITCODE -ne 0) {
        throw "InkOS Studio exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
