# 隔离测试：仅加载生产函数，CIM、进程对象和文件元信息全部替换为合成数据。
# 不调用真实 Get-Process / CloseMainWindow，不读取认证文件或进程命令行。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($env:CODEX_DESKTOP_TEST_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'desktop script has syntax errors' }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($definition in $functions) { . ([ScriptBlock]::Create($definition.Extent.Text)) }

function Assert-Equal($actual, $expected, [string]$context) {
    if ($actual -cne $expected) { throw ('assertion failed: ' + $context) }
}
function Assert-Error([ScriptBlock]$action, [string]$expected) {
    $message = $null
    try { & $action | Out-Null } catch { $message = $_.Exception.Message }
    if ($message -cne $expected) { throw ('unexpected error for: ' + $expected) }
}

function Get-ExecutableVersionInfo([string]$path) {
    if ($script:untrustedPaths -contains $path) {
        return [PSCustomObject]@{ ProductName = 'Other'; CompanyName = 'Other' }
    }
    return [PSCustomObject]@{ ProductName = 'Codex'; CompanyName = 'OpenAI' }
}
function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter, [string[]]$Property)
    Assert-Equal $ClassName 'Win32_Process' 'CIM class'
    Assert-Equal (($Property | Sort-Object) -join ',') 'CreationDate,ExecutablePath,Name,ParentProcessId,ProcessId' 'CIM property allowlist'
    if ($Filter -ceq "Name = 'Codex.exe'") {
        return @($script:rows | Where-Object { $_.Name -ieq 'Codex.exe' })
    }
    if ($Filter -match '^ProcessId = ([0-9]+)$') {
        if ($script:confirmationDenied) { throw 'confirmation denied' }
        $queriedId = [int]$Matches[1]
        return @($script:liveRows | Where-Object { $_.ProcessId -eq $queriedId })
    }
    throw 'unexpected CIM filter'
}
function Get-Process {
    [CmdletBinding()]
    param([int]$Id)
    if (-not $script:processes.ContainsKey([string]$Id)) { throw 'synthetic process lookup failure' }
    return $script:processes[[string]$Id]
}

function New-Row([int]$id, [int]$parent, [datetime]$created, [string]$path, [string]$name = 'Codex.exe') {
    return [PSCustomObject]@{
        ProcessId = $id; ParentProcessId = $parent; CreationDate = $created
        ExecutablePath = $path; Name = $name
    }
}
function New-Process([int]$id, [datetime]$started) {
    $process = [PSCustomObject]@{ Id = $id; StartTime = $started }
    $process | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {
        $script:closeCalls += $this.Id
        switch ($script:closeBehavior) {
            'normal' { return $true }
            'false' { return $false }
            'throw' { throw 'synthetic close failure' }
            'exit-false' {
                $closedId = $this.Id
                $script:liveRows = @($script:liveRows | Where-Object { $_.ProcessId -ne $closedId })
                return $false
            }
            'exit-throw' {
                $closedId = $this.Id
                $script:liveRows = @($script:liveRows | Where-Object { $_.ProcessId -ne $closedId })
                throw 'synthetic already exited'
            }
            default { throw 'unexpected close behavior' }
        }
    }
    return $process
}

$script:appPath = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'codex-desktop-fixture', 'Codex.exe')
$script:otherPath = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'codex-other-fixture', 'Codex.exe')
$script:started = [datetime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
function Reset-Fixture {
    $script:rows = @(
        (New-Row 100 5 $script:started $script:appPath),
        (New-Row 101 100 $script:started.AddSeconds(1) $script:appPath)
    )
    $script:liveRows = @($script:rows)
    $script:processes = @{
        '100' = (New-Process 100 $script:started)
        '101' = (New-Process 101 $script:started.AddSeconds(1))
    }
    $script:closeBehavior = 'normal'
    $script:closeCalls = @()
    $script:confirmationDenied = $false
    $script:untrustedPaths = @()
    $env:CODEX_SWITCH_PATH = $script:appPath
    $env:CODEX_SWITCH_PID = '100'
    $env:CODEX_SWITCH_STARTED = [string]$script:started.Ticks
}

# 正常树仅识别主进程，请求只发给该进程；子进程尚存时不得报告完全退出。
Reset-Fixture
$detected = @((Invoke-CodexDesktop 'detect') | ConvertFrom-Json)
Assert-Equal $detected.Count 1 'one main process'
Assert-Equal $detected[0].pid 100 'main PID'
Assert-Equal $detected[0].started $env:CODEX_SWITCH_STARTED 'exact process start time'
Assert-Equal (Invoke-CodexDesktop 'close') 'true' 'normal close request'
Assert-Equal ($script:closeCalls -join ',') '100' 'only original main process signaled'
Assert-Equal (Invoke-CodexDesktop 'stopped') 'false' 'live process blocks stop'
$script:rows = @($script:rows | Where-Object { $_.ProcessId -eq 101 })
Assert-Equal (Invoke-CodexDesktop 'stopped') 'false' 'orphaned same-image worker blocks stop'
$detected = @((Invoke-CodexDesktop 'detect') | ConvertFrom-Json)
Assert-Equal $detected[0].pid 101 'orphan is not silently ignored'

# 独立报告器和更新器不会进入 Codex.exe 扫描，即使位于同一目录。
Reset-Fixture
$script:rows = @(
    (New-Row 200 0 $script:started ([IO.Path]::Combine([IO.Path]::GetDirectoryName($script:appPath), 'crashpad_handler.exe')) 'crashpad_handler.exe'),
    (New-Row 201 0 $script:started ([IO.Path]::Combine([IO.Path]::GetDirectoryName($script:appPath), 'Updater.exe')) 'Updater.exe')
)
Assert-Equal (Invoke-CodexDesktop 'detect') '[]' 'independent helpers do not become main app'
Assert-Equal (Invoke-CodexDesktop 'stopped') 'true' 'independent helpers do not block stopped'

# 同名非 OpenAI 程序被排除；无法取得路径的候选必须保守拒绝。
Reset-Fixture
$script:untrustedPaths = @($script:appPath)
Assert-Equal (Invoke-CodexDesktop 'detect') '[]' 'untrusted metadata excluded'
$script:rows = @((New-Row 100 5 $script:started $null))
Assert-Error { Invoke-CodexDesktop 'detect' } 'inaccessible process'

# 父 PID 复用或来自另一安装目录时不能把独立实例错误并入进程树。
Reset-Fixture
$script:rows[0].CreationDate = $script:started.AddSeconds(2)
Assert-Equal (@(Get-CodexRoots $script:rows).Count) 2 'newer reused parent PID'
Reset-Fixture
$script:rows[0].ExecutablePath = $script:otherPath
Assert-Equal (@(Get-CodexRoots $script:rows).Count) 2 'different executable parent'
Reset-Fixture
$script:rows[1].ExecutablePath = $script:appPath.ToUpperInvariant()
Assert-Equal (@(Get-CodexRoots $script:rows).Count) 1 'Windows executable path is case insensitive'
Reset-Fixture
$script:rows[0].ParentProcessId = 100
Assert-Error { Get-CodexRoots $script:rows } 'invalid process tree'
Reset-Fixture
$script:rows[0].ParentProcessId = 101
$script:rows[1].CreationDate = $script:started
Assert-Error { Get-CodexRoots $script:rows } 'invalid process tree'

# 主进程在 CIM 与 Get-Process 之间退出，仅返回请求阶段成功；残留 worker 仍阻塞。
Reset-Fixture
$script:processes.Remove('100')
$script:liveRows = @($script:liveRows | Where-Object { $_.ProcessId -ne 100 })
# detect 不能直接跳过消失的根，否则快照中的存活子进程会被旧父子关系藏掉。
Assert-Error { Invoke-CodexDesktop 'detect' } 'synthetic process lookup failure'
Assert-Equal (Invoke-CodexDesktop 'close') 'true' 'process disappears before lookup'
Assert-Equal $script:closeCalls.Count 0 'no signal after disappearance'
Assert-Equal (Invoke-CodexDesktop 'stopped') 'false' 'stale snapshot is not treated as fully stopped'

# CloseMainWindow 返回 false/抛出异常后，只有新的快照确认 PID 消失才放行。
foreach ($behavior in @('exit-false', 'exit-throw')) {
    Reset-Fixture
    $script:closeBehavior = $behavior
    Assert-Equal (Invoke-CodexDesktop 'close') 'true' 'process exits during close request'
    Assert-Equal ($script:closeCalls -join ',') '100' 'single close request'
}
foreach ($behavior in @('false', 'throw')) {
    Reset-Fixture
    $script:closeBehavior = $behavior
    Assert-Error { Invoke-CodexDesktop 'close' } 'quit request failed'
}

# 查不到 Process 对象但 CIM 仍有该 PID，不得把访问失败当退出。
Reset-Fixture
$script:processes.Remove('100')
Assert-Error { Invoke-CodexDesktop 'close' } 'process inspection failed'
Reset-Fixture
$script:closeBehavior = 'false'
$script:confirmationDenied = $true
Assert-Error { Invoke-CodexDesktop 'close' } 'confirmation denied'

# 身份变化时不能关闭意外的新进程；包括 PID 被非 Codex 程序复用。
Reset-Fixture
$script:processes['100'].StartTime = $script:started.AddSeconds(2)
Assert-Error { Invoke-CodexDesktop 'close' } 'application changed'
Assert-Equal $script:closeCalls.Count 0 'changed start time never signaled'
Reset-Fixture
$env:CODEX_SWITCH_PATH = $script:otherPath
Assert-Error { Invoke-CodexDesktop 'close' } 'application changed'
Assert-Equal $script:closeCalls.Count 0 'changed image never signaled'
Reset-Fixture
$script:rows += (New-Row 200 0 $script:started.AddSeconds(2) $script:appPath)
Assert-Error { Invoke-CodexDesktop 'close' } 'application changed'
Assert-Equal $script:closeCalls.Count 0 'unexpected new root never signaled'
Reset-Fixture
$script:rows = @()
$script:liveRows = @((New-Row 100 5 $script:started.AddSeconds(2) 'replacement.exe' 'replacement.exe'))
Assert-Error { Invoke-CodexDesktop 'close' } 'application changed'
Assert-Equal $script:closeCalls.Count 0 'reused PID never signaled'
Reset-Fixture
$script:rows = @()
$script:liveRows = @()
Assert-Equal (Invoke-CodexDesktop 'close') 'true' 'already absent target'
Assert-Equal $script:closeCalls.Count 0 'absent target never signaled'

'passed'
