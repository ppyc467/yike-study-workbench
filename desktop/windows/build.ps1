$ErrorActionPreference = 'Stop'
$frameworkPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $frameworkPath 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'Requires Windows with .NET Framework 4.x (64-bit).'
}
$outputPath = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$references = @(
    'System.dll', 'System.Core.dll', 'System.Drawing.dll',
    'System.Windows.Forms.dll', 'System.Web.Extensions.dll',
    (Join-Path $frameworkPath 'WPF\UIAutomationClient.dll'),
    (Join-Path $frameworkPath 'WPF\UIAutomationTypes.dll'),
    (Join-Path $frameworkPath 'WPF\WindowsBase.dll')
)
$compilerArguments = @('/nologo', '/target:winexe', '/platform:anycpu', '/codepage:65001', ('/out:' + (Join-Path $outputPath 'YikeMiniTimer.exe')))
foreach ($reference in $references) { $compilerArguments += '/reference:' + $reference }
$compilerArguments += Join-Path $PSScriptRoot 'MiniTimer.cs'
& $compiler @compilerArguments
if ($LASTEXITCODE -ne 0) { throw 'Desktop timer compilation failed.' }
$configPath = Join-Path $outputPath 'launcher.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launcher.example.json') -Destination $configPath
}
Write-Output ('Built: ' + (Join-Path $outputPath 'YikeMiniTimer.exe'))
