# 只查询映像路径、父进程与启动时间，不读取 CommandLine。通过环境变量传参，禁止脚本插值。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Test-CodexDesktop([string]$path) {
    if (-not $path -or [IO.Path]::GetFileName($path) -ine 'Codex.exe') { return $false }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($path)
    return $version.ProductName -eq 'Codex' -and $version.CompanyName -match '^OpenAI(?:\b|$)'
}
if ($env:CODEX_SWITCH_ACTION -eq 'validate') {
    if (-not (Test-CodexDesktop $env:CODEX_SWITCH_PATH)) { throw 'invalid application' }
    'true'
    exit
}
$rows = @(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe'" | Where-Object {
    if (-not $_.ExecutablePath) { throw 'inaccessible process' }
    Test-CodexDesktop $_.ExecutablePath
})
if ($env:CODEX_SWITCH_ACTION -eq 'stopped') {
    if (@($rows | Where-Object { $_.ExecutablePath -eq $env:CODEX_SWITCH_PATH }).Count -eq 0) { 'true' } else { 'false' }
    exit
}
$roots = @($rows | Where-Object {
    $parentId = $_.ParentProcessId
    @($rows | Where-Object { $_.ProcessId -eq $parentId }).Count -eq 0
})
if ($env:CODEX_SWITCH_ACTION -eq 'detect') {
    $items = @($roots | ForEach-Object {
        $process = Get-Process -Id $_.ProcessId
        @{ pid = [int]$_.ProcessId; path = $_.ExecutablePath; executable = $_.ExecutablePath; started = [string]$process.StartTime.ToUniversalTime().Ticks }
    })
    ConvertTo-Json -InputObject $items -Compress
    exit
}
if ($env:CODEX_SWITCH_ACTION -ne 'close') { throw 'invalid action' }
foreach ($row in $roots) {
    $process = Get-Process -Id $row.ProcessId
    if ([string]$row.ProcessId -ne $env:CODEX_SWITCH_PID -or $row.ExecutablePath -ne $env:CODEX_SWITCH_PATH -or
        [string]$process.StartTime.ToUniversalTime().Ticks -ne $env:CODEX_SWITCH_STARTED) { throw 'application changed' }
    if (-not $process.CloseMainWindow()) { throw 'quit request failed' }
}
'true'
