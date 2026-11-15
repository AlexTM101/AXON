param([switch]$Browser, [string]$DotnetPath = 'dotnet', [string]$NodePath = 'node')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dotnet = (Get-Command $DotnetPath -ErrorAction Stop).Source
$node = (Get-Command $NodePath -ErrorAction Stop).Source
foreach ($project in @('Axon.Core.Tests', 'Axon.Desktop.Tests')) {
    & $dotnet run --project (Join-Path $repo ('tests/' + $project)) -c Release
    if ($LASTEXITCODE -ne 0) { throw ('Tests failed: ' + $project) }
}
& $node --test (Join-Path $repo 'tests/graph.test.cjs') (Join-Path $repo 'tests/scene.test.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Graph/scene tests failed.' }
if ($Browser) {
    & $node (Join-Path $repo 'tests/scene-browser.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Browser renderer tests failed.' }
}
