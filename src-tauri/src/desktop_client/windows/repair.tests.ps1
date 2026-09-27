# 隔离测试：只加载函数定义，真实 Appx / CIM / 注册命令均不会被调用。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($env:CODEX_REPAIR_TEST_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'repair script has syntax errors' }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($definition in $functions) { . ([ScriptBlock]::Create($definition.Extent.Text)) }

function Get-AppxPackage { return $script:packages }
function Get-CimInstance { return $script:rows }
function Add-AppxPackage {
    [CmdletBinding()]
    param([string]$Path, [switch]$Register, [switch]$DisableDevelopmentMode)
    if (-not $Register -or -not $DisableDevelopmentMode) { throw 'unsafe registration options' }
    $script:registrationCalls += 1
    $script:registeredPath = $Path
}
function Assert-Error([ScriptBlock]$action, [string]$expected) {
    $message = $null
    try { & $action | Out-Null } catch { $message = $_.Exception.Message }
    # 此测试只使用本文件的模拟包和临时文件，错误不含真实应用或认证内容。
    if ($message -cne $expected) { throw ('expected ' + $expected + ', got: ' + $message) }
}

$fullName = 'OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0'
# Rust 临时目录可能使用 RUNNER~1 等短路径，.NET Framework 会规范化该路径。
# fixture 与实际检测使用相同路径格式，避免把同一个目录误判为不同目标。
$location = [IO.Path]::GetFullPath((Join-Path $env:CODEX_REPAIR_TEST_ROOT $fullName))
$null = [IO.Directory]::CreateDirectory((Join-Path $location 'app'))
[IO.File]::WriteAllText((Join-Path $location 'app\ChatGPT.exe'), 'synthetic executable')
$xml = @'
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="OpenAI.Codex" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" Version="26.915.4065.0" ProcessorArchitecture="x64" />
  <Applications><Application Id="App" Executable="app\ChatGPT.exe" /></Applications>
</Package>
'@
$manifestPath = Join-Path $location 'AppxManifest.xml'
[IO.File]::WriteAllText($manifestPath, $xml)
$validPackage = [PSCustomObject]@{
    Name = 'OpenAI.Codex'; PublisherId = '2p2nqsd0c76g0'
    Publisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
    PackageFamilyName = 'OpenAI.Codex_2p2nqsd0c76g0'
    SignatureKind = 'Store'; IsDevelopmentMode = $false
    IsFramework = $false; IsResourcePackage = $false; IsPartiallyStaged = $false
    ResourceId = ''; Version = '26.915.4065.0'; Architecture = 'X64'
    PackageFullName = $fullName; InstallLocation = $location
}
$script:packages = @($validPackage)
$script:rows = @()
$target = Read-InstalledTarget
if ($target.appUserModelId -cne 'OpenAI.Codex_2p2nqsd0c76g0!App' -or
    $target.executable -cne (Join-Path $location 'app\ChatGPT.exe')) { throw 'unexpected target' }
Assert-NotRunning $target

foreach ($change in @(
    @{ Property = 'PublisherId'; Value = 'otherpublisher' },
    @{ Property = 'Publisher'; Value = 'CN=Fake OpenAI' },
    @{ Property = 'PackageFamilyName'; Value = 'OpenAI.ChatGPT_2p2nqsd0c76g0' },
    @{ Property = 'SignatureKind'; Value = 'Developer' },
    @{ Property = 'SignatureKind'; Value = 'None' },
    @{ Property = 'IsDevelopmentMode'; Value = $true },
    @{ Property = 'IsPartiallyStaged'; Value = $true }
)) {
    $changed = $validPackage.PSObject.Copy()
    $changed.($change.Property) = $change.Value
    $script:packages = @($changed)
    Assert-Error { Read-InstalledTarget } 'inspectFailed'
}
$script:packages = @()
Assert-Error { Read-InstalledTarget } 'notFound'
$script:packages = @($validPackage, $validPackage)
Assert-Error { Read-InstalledTarget } 'ambiguous'
$script:packages = @($validPackage)

foreach ($relative in @('..\ChatGPT.exe', 'C:\Other\ChatGPT.exe', 'app\..\ChatGPT.exe', 'app\Other.exe')) {
    [IO.File]::WriteAllText($manifestPath, $xml.Replace('app\ChatGPT.exe', $relative))
    Assert-Error { Read-InstalledTarget } 'inspectFailed'
}
[IO.File]::WriteAllText($manifestPath, $xml.Replace('Version="26.915.4065.0"', 'Version="26.915.4066.0"'))
Assert-Error { Read-InstalledTarget } 'inspectFailed'
[IO.File]::WriteAllText($manifestPath, $xml.Replace('</Applications>', '<Application Id="Second" Executable="app\ChatGPT.exe" /></Applications>'))
Assert-Error { Read-InstalledTarget } 'ambiguous'
[IO.File]::WriteAllText($manifestPath, $xml)

# 即使是包内任意辅助进程也必须先退出；另一位置的 ChatGPT 不会误判为此包。
$script:rows = @([PSCustomObject]@{ Name = 'helper.exe'; ExecutablePath = (Join-Path $location 'app\helper.exe') })
Assert-Error { Assert-NotRunning $target } 'running'
$script:rows = @([PSCustomObject]@{ Name = 'ChatGPT.exe'; ExecutablePath = 'C:\Other\ChatGPT.exe' })
Assert-NotRunning $target
$script:rows = @([PSCustomObject]@{ Name = 'ChatGPT.exe'; ExecutablePath = $null })
Assert-Error { Assert-NotRunning $target } 'inspectFailed'

$env:CODEX_REPAIR_PACKAGE = $target.packageFullName
$env:CODEX_REPAIR_AUMID = $target.appUserModelId
$env:CODEX_REPAIR_LOCATION = $target.installLocation
$env:CODEX_REPAIR_EXECUTABLE = $target.executable
$env:CODEX_REPAIR_VERSION = $target.version
if (-not (Test-ExpectedTarget $target)) { throw 'valid snapshot rejected' }
$env:CODEX_REPAIR_VERSION = '26.915.4066.0'
if (Test-ExpectedTarget $target) { throw 'stale snapshot accepted' }

# 执行真实入口控制流，但保留上面的查询/部署替身，确认所有拒绝发生在注册之前。
$entryText = ($ast.EndBlock.Statements | Where-Object {
    $_ -isnot [Management.Automation.Language.FunctionDefinitionAst]
} | ForEach-Object { $_.Extent.Text }) -join "`n"
$entry = [ScriptBlock]::Create($entryText)
$env:CODEX_REPAIR_ACTION = 'register'
$script:rows = @()
$script:packages = @($validPackage)
$script:registrationCalls = 0
$reply = (& $entry) | ConvertFrom-Json
if ($reply.status -cne 'staleCheck' -or $script:registrationCalls -ne 0) { throw 'stale registration executed' }
$env:CODEX_REPAIR_VERSION = $target.version
$script:rows = @([PSCustomObject]@{ Name = 'ChatGPT.exe'; ExecutablePath = $target.executable })
$reply = (& $entry) | ConvertFrom-Json
if ($reply.status -cne 'running' -or $script:registrationCalls -ne 0) { throw 'running application registered' }
$script:rows = @()
$changed = $validPackage.PSObject.Copy()
$changed.PublisherId = 'otherpublisher'
$script:packages = @($changed)
$reply = (& $entry) | ConvertFrom-Json
if ($reply.status -cne 'inspectFailed' -or $script:registrationCalls -ne 0) { throw 'untrusted package registered' }
$script:packages = @($validPackage)
$reply = (& $entry) | ConvertFrom-Json
if ($reply.status -cne 'registered' -or $script:registrationCalls -ne 1 -or
    $script:registeredPath -cne $manifestPath) { throw 'known package registration did not complete' }
'passed'
