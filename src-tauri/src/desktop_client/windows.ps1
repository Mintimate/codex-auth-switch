# 只查询映像路径、父进程与启动时间，不读取 CommandLine。通过环境变量传参，禁止脚本插值。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-ExecutableVersionInfo([string]$path) {
    return [Diagnostics.FileVersionInfo]::GetVersionInfo($path)
}

function Test-CodexDesktop([string]$path) {
    if (-not $path -or [IO.Path]::GetFileName($path) -ine 'Codex.exe') { return $false }
    $version = Get-ExecutableVersionInfo $path
    return $version.ProductName -eq 'Codex' -and $version.CompanyName -match '^OpenAI(?:\b|$)'
}

function Get-CodexProcessRows {
    # 明确限定返回字段，避免 CIM 默认取回命令行等与退出判断无关的数据。
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Codex.exe'" `
        -Property ProcessId, ParentProcessId, ExecutablePath, CreationDate, Name -ErrorAction Stop)
    foreach ($row in $rows) {
        if (-not $row.ExecutablePath) { throw 'inaccessible process' }
        if (Test-CodexDesktop $row.ExecutablePath) { $row }
    }
}

function Get-CodexRoots([object[]]$rows) {
    $byId = @{}
    foreach ($row in $rows) {
        $key = [string]$row.ProcessId
        if ($null -eq $row.ProcessId -or $null -eq $row.ParentProcessId -or
            [long]$row.ProcessId -le 0 -or [long]$row.ParentProcessId -lt 0 -or
            $row.CreationDate -isnot [datetime] -or $byId.ContainsKey($key)) {
            throw 'invalid process tree'
        }
        $byId[$key] = $row
    }
    foreach ($row in $rows) {
        $current = $row
        $seen = @{}
        while ($null -ne $current) {
            $key = [string]$current.ProcessId
            if ($seen.ContainsKey($key)) { throw 'invalid process tree' }
            $seen[$key] = $true
            $parent = $byId[[string]$current.ParentProcessId]
            # PID 可以复用；另一安装路径或晚于子进程创建的进程不是真正的父进程。
            if ($null -eq $parent -or $parent.ExecutablePath -ine $current.ExecutablePath -or
                $parent.CreationDate.ToUniversalTime() -gt $current.CreationDate.ToUniversalTime()) {
                if ($current.ProcessId -eq $row.ProcessId) { $row }
                break
            }
            $current = $parent
        }
    }
}

function Test-ProcessGone([int]$processId) {
    # Get-Process / CloseMainWindow 失败不等于进程退出。仅新快照明确无此 PID 时放行。
    # processId 是已验证的整数，不能把调用方字符串拼进 CIM 查询。
    $current = @(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $processId) `
        -Property ProcessId, ParentProcessId, ExecutablePath, CreationDate, Name -ErrorAction Stop)
    return $current.Count -eq 0
}

function Close-CodexInstance([object[]]$rows, [object[]]$roots) {
    $targetId = 0
    if (-not [int]::TryParse($env:CODEX_SWITCH_PID, [ref]$targetId) -or $targetId -le 0) {
        throw 'invalid application'
    }
    $targets = @($rows | Where-Object { $_.ProcessId -eq $targetId })
    if ($targets.Count -eq 0) {
        if (Test-ProcessGone $targetId) { return 'true' }
        throw 'application changed'
    }
    if ($targets.Count -ne 1 -or $roots.Count -ne 1 -or $roots[0].ProcessId -ne $targetId -or
        $targets[0].ExecutablePath -ine $env:CODEX_SWITCH_PATH) { throw 'application changed' }
    try {
        $process = Get-Process -Id $targetId -ErrorAction Stop
        $started = [string]$process.StartTime.ToUniversalTime().Ticks
    } catch {
        if (Test-ProcessGone $targetId) { return 'true' }
        throw 'process inspection failed'
    }
    if ($started -cne $env:CODEX_SWITCH_STARTED) { throw 'application changed' }
    try {
        $requested = $process.CloseMainWindow()
    } catch {
        if (Test-ProcessGone $targetId) { return 'true' }
        throw 'quit request failed'
    }
    if (-not $requested -and -not (Test-ProcessGone $targetId)) { throw 'quit request failed' }
    # 返回只说明请求已发送或原进程已退出。Rust 仍需等待所有同映像工作进程结束。
    return 'true'
}

function Invoke-CodexDesktop([string]$action) {
    if ($action -eq 'validate') {
        if (-not (Test-CodexDesktop $env:CODEX_SWITCH_PATH)) { throw 'invalid application' }
        return 'true'
    }
    $rows = @(Get-CodexProcessRows)
    if ($action -eq 'stopped') {
        if (@($rows | Where-Object { $_.ExecutablePath -ieq $env:CODEX_SWITCH_PATH }).Count -eq 0) {
            return 'true'
        }
        return 'false'
    }
    $roots = @(Get-CodexRoots $rows)
    if ($action -eq 'detect') {
        $items = @($roots | ForEach-Object {
            $process = Get-Process -Id $_.ProcessId -ErrorAction Stop
            @{ pid = [int]$_.ProcessId; path = $_.ExecutablePath; executable = $_.ExecutablePath; started = [string]$process.StartTime.ToUniversalTime().Ticks }
        })
        return (ConvertTo-Json -InputObject $items -Compress)
    }
    if ($action -ne 'close') { throw 'invalid action' }
    return (Close-CodexInstance $rows $roots)
}

Invoke-CodexDesktop $env:CODEX_SWITCH_ACTION
