param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectPath '.sites-runtime'
$entryPath = Join-Path $PSScriptRoot 'run-framework.mjs'
$pidPath = Join-Path $runtimePath 'workbench-server.pid'
$url = 'http://127.0.0.1:5173/'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
if ($Stop) {
    if (Test-Path -LiteralPath $pidPath) {
        $serverProcessId = [int]([System.IO.File]::ReadAllText($pidPath).Trim())
        $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
        if ($serverProcess -and $serverProcess.CommandLine.Contains($entryPath)) {
            & taskkill.exe /PID $serverProcessId /T /F | Out-Null
            Write-Host '本机工作台已停止，学习记录已保留。'
        } else { Write-Host '本机工作台已经停止。' }
    } else { Write-Host '没有由快捷方式启动的工作台服务。' }
    exit
}
try {
    $existingPage = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    if ($existingPage.Content -match '一刻') { Start-Process $url; exit }
    throw '端口 5173 被其他程序占用，请关闭该程序后再试。'
} catch {
    if ($_.Exception.Message -match '端口 5173') { throw }
}
if (-not (Test-Path (Join-Path $projectPath 'node_modules/vinext'))) { throw '缺少依赖，请先按 README.md 安装。' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $entryPath + '" dev') -WorkingDirectory $projectPath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'workbench.log') -RedirectStandardError (Join-Path $runtimePath 'workbench-error.log')
[System.IO.File]::WriteAllText($pidPath, [string]$process.Id)
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw ('启动失败，请查看 ' + (Join-Path $runtimePath 'workbench-error.log')) }
    try {
        $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        if ($page.StatusCode -eq 200 -and $page.Content -match '一刻') { Start-Process $url; Write-Host '工作台已在浏览器打开。'; exit }
    } catch { }
}
throw '启动超时，请查看 .sites-runtime/workbench-error.log。'
