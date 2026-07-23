[CmdletBinding()]
param(
    [switch]$FullValidation
)

$ErrorActionPreference = 'Stop'
$pnpmVersion = '9.15.9'
$sourceRoot = $PSScriptRoot
$corepackCacheRoot = Join-Path $env:LOCALAPPDATA "node\corepack\v1\pnpm\$pnpmVersion"
$pnpmEntry = Join-Path $corepackCacheRoot 'bin\pnpm.cjs'
$shimDirectory = Join-Path $env:TEMP "inkos-pnpm-$pnpmVersion"
$shimPath = Join-Path $shimDirectory 'pnpm.cmd'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 20 or newer is required.'
}

if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
    throw 'Corepack is required to provision the repository pnpm version.'
}

& corepack "pnpm@$pnpmVersion" --version | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pnpmEntry -PathType Leaf)) {
    throw "Unable to provision pnpm $pnpmVersion through Corepack."
}

New-Item -ItemType Directory -Path $shimDirectory -Force | Out-Null
$shimLines = @(
    '@echo off',
    "node `"$pnpmEntry`" %*"
)
[System.IO.File]::WriteAllLines($shimPath, $shimLines, [System.Text.Encoding]::ASCII)
$env:Path = "$shimDirectory;$env:Path"

Push-Location -LiteralPath $sourceRoot
try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

    pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

    if ($FullValidation) {
        pnpm typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed.' }

        pnpm test
        if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }

        pnpm verify:publish-manifests
        if ($LASTEXITCODE -ne 0) { throw 'Publish manifest verification failed.' }
    }
}
finally {
    Pop-Location
}
