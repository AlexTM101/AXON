param(
    [string]$Output = (Join-Path $PSScriptRoot 'dist/AXON'),
    [string]$DotnetPath = 'dotnet',
    [string]$RestoreSource
)
$ErrorActionPreference = 'Stop'
$dotnet = (Get-Command $DotnetPath -ErrorAction Stop).Source
$version = & $dotnet --version
if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'10.0.100' -or ([version]$version).Major -ne 10) {
    throw '.NET SDK 10.0.100 or newer in the 10.x branch is required.'
}
$publish = @(
    'publish', (Join-Path $PSScriptRoot 'src/Axon.Desktop/Axon.Desktop.csproj'),
    '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', $Output,
    '-p:DebugType=None', '-p:DebugSymbols=false', '-p:Deterministic=true',
    '-p:IncludeSourceRevisionInInformationalVersion=false',
    ('-p:PathMap=' + $PSScriptRoot + '=/_/AXON')
)
if ($RestoreSource) { $publish += @('--source', $RestoreSource) }
& $dotnet @publish
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
$licenseDir = Join-Path $Output 'licenses'
New-Item -ItemType Directory -Path $licenseDir -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'licenses') -File |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $licenseDir -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'docs/USAGE.md') -Destination (Join-Path $Output 'README-RU.md') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.md') -Destination $Output -Force
Write-Output ('Build ready: ' + [IO.Path]::GetFullPath($Output))
