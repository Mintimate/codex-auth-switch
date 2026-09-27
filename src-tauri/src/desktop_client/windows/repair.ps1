# 固定的当前用户修复流程。参数只由 Rust 后端设置，禁止命令/路径字符串插值。
# 不查询认证文件或进程命令行，不记录原始异常，不下载、不重置、不卸载。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Reply([string]$status, $target = $null) {
    ConvertTo-Json -InputObject @{ status = $status; target = $target } -Compress -Depth 4
}

function Stop-Inspection([string]$status) {
    # 只抛内部固定代码；外层不会输出 PowerShell 原始错误。
    throw [InvalidOperationException]::new($status)
}

function Read-InstalledTarget {
    # 兼容性白名单，必须核实发行包后才能扩展，不能按显示名/模糊 Codex 搜索。
    # https://github.com/openai/codex/issues/28667
    # https://github.com/openai/codex/issues/46622
    $packageName = 'OpenAI.Codex'
    $publisherId = '2p2nqsd0c76g0'
    $publisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
    $family = 'OpenAI.Codex_2p2nqsd0c76g0'
    # 不指定 -User / -AllUsers：只查询当前用户。
    # https://learn.microsoft.com/powershell/module/appx/get-appxpackage
    $packages = @(Get-AppxPackage -Name $packageName -PackageTypeFilter Main -ErrorAction Stop)
    if ($packages.Count -eq 0) { Stop-Inspection 'notFound' }
    if ($packages.Count -ne 1) { Stop-Inspection 'ambiguous' }
    $package = $packages[0]
    if ($package.Name -cne $packageName -or $package.PublisherId -cne $publisherId -or
        $package.Publisher -ine $publisher -or $package.PackageFamilyName -cne $family -or
        [string]$package.SignatureKind -cne 'Store' -or $package.IsDevelopmentMode -ne $false -or
        $package.IsFramework -ne $false -or $package.IsResourcePackage -ne $false -or
        $package.IsPartiallyStaged -ne $false -or [string]$package.ResourceId -ne '') {
        Stop-Inspection 'inspectFailed'
    }
    $version = [string]$package.Version
    $architecture = ([string]$package.Architecture).ToLowerInvariant()
    $fullName = 'OpenAI.Codex_' + $version + '_' + $architecture + '__' + $publisherId
    if ($package.PackageFullName -cne $fullName -or $architecture -notin @('x64', 'arm64', 'x86', 'neutral')) {
        Stop-Inspection 'inspectFailed'
    }
    if (-not $package.InstallLocation -or $package.InstallLocation -notmatch '^[A-Za-z]:[\\/]') {
        Stop-Inspection 'inspectFailed'
    }
    $location = [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd([char]'\')
    $manifestPath = [IO.Path]::Combine($location, 'AppxManifest.xml')
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Stop-Inspection 'inspectFailed' }
    # 仅解析现有包内清单，禁用 DTD/外部实体并限制大小。
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.MaxCharactersInDocument = 1048576
    $reader = [Xml.XmlReader]::Create($manifestPath, $settings)
    try {
        $manifest = [Xml.XmlDocument]::new()
        $manifest.XmlResolver = $null
        $manifest.Load($reader)
    } finally { $reader.Dispose() }
    $namespaces = [Xml.XmlNamespaceManager]::new($manifest.NameTable)
    $namespaces.AddNamespace('p', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
    $identities = $manifest.SelectNodes('/p:Package/p:Identity', $namespaces)
    if ($identities.Count -ne 1) { Stop-Inspection 'inspectFailed' }
    $identity = $identities[0]
    if ($identity.GetAttribute('Name') -cne $packageName -or
        $identity.GetAttribute('Publisher') -ine $publisher -or
        $identity.GetAttribute('Version') -cne $version -or
        $identity.GetAttribute('ProcessorArchitecture') -ine $architecture -or
        $identity.GetAttribute('ResourceId') -ne '') { Stop-Inspection 'inspectFailed' }

    $applications = $manifest.SelectNodes('/p:Package/p:Applications/p:Application', $namespaces)
    if ($applications.Count -ne 1) { Stop-Inspection 'ambiguous' }
    $applicationId = $applications[0].GetAttribute('Id')
    $relativeExecutable = $applications[0].GetAttribute('Executable')
    if ($applicationId -cnotmatch '^[A-Za-z][A-Za-z0-9.]{0,63}$' -or
        [string]::IsNullOrWhiteSpace($relativeExecutable) -or
        [IO.Path]::IsPathRooted($relativeExecutable) -or $relativeExecutable.Contains(':') -or
        @($relativeExecutable -split '[\\/]' | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0) {
        Stop-Inspection 'inspectFailed'
    }
    $executable = [IO.Path]::GetFullPath([IO.Path]::Combine($location, $relativeExecutable))
    if (-not $executable.StartsWith($location + '\', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($executable) -notin @('Codex.exe', 'ChatGPT.exe') -or
        -not (Test-Path -LiteralPath $executable -PathType Leaf)) { Stop-Inspection 'inspectFailed' }
    # 不依赖可变的产品显示名，信任 Windows 已验证的 Store 签名和固定包发布者。
    return @{
        packageFullName = $fullName
        appUserModelId = $family + '!' + $applicationId
        installLocation = $location
        executable = $executable
        version = $version
    }
}

function Assert-NotRunning($target) {
    # 只请求映像/名称，涵盖同一包目录内 Electron 子进程；不读取 CommandLine。
    $rows = @(Get-CimInstance -ClassName Win32_Process -Property Name, ExecutablePath -ErrorAction Stop)
    $prefix = $target.installLocation + '\'
    foreach ($row in $rows) {
        if (-not $row.ExecutablePath) {
            if ($row.Name -in @('Codex.exe', 'ChatGPT.exe')) { Stop-Inspection 'inspectFailed' }
            continue
        }
        if ($row.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Inspection 'running'
        }
    }
}

function Test-ExpectedTarget($target) {
    return $target.packageFullName -ceq $env:CODEX_REPAIR_PACKAGE -and
        $target.appUserModelId -ceq $env:CODEX_REPAIR_AUMID -and
        $target.installLocation -ceq $env:CODEX_REPAIR_LOCATION -and
        $target.executable -ceq $env:CODEX_REPAIR_EXECUTABLE -and
        $target.version -ceq $env:CODEX_REPAIR_VERSION
}

$registrationStarted = $false
$registrationCompleted = $false
try {
    if ($env:CODEX_REPAIR_ACTION -notin @('inspect', 'register')) { Stop-Inspection 'inspectFailed' }
    $target = Read-InstalledTarget
    if ($env:CODEX_REPAIR_ACTION -eq 'register' -and -not (Test-ExpectedTarget $target)) {
        Stop-Inspection 'staleCheck'
    }
    Assert-NotRunning $target
    if ($env:CODEX_REPAIR_ACTION -eq 'inspect') {
        Write-Reply 'ready' $target
        exit
    }
    $registrationStarted = $true
    # 仅重新注册当前用户的已安装包；不强制退出，不下载依赖或恢复用户数据。
    # https://learn.microsoft.com/powershell/module/appx/add-appxpackage#example-3-add-a-disabled-app-package-in-development-mode
    Add-AppxPackage -Path ([IO.Path]::Combine($target.installLocation, 'AppxManifest.xml')) `
        -Register -DisableDevelopmentMode -ErrorAction Stop | Out-Null
    $registrationCompleted = $true
    $after = Read-InstalledTarget
    if (-not (Test-ExpectedTarget $after)) { Stop-Inspection 'repairUncertain' }
    Write-Reply 'registered' $after
} catch {
    $status = 'inspectFailed'
    if ($registrationCompleted) {
        $status = 'repairUncertain'
    } elseif ($registrationStarted) {
        $status = 'repairFailed'
    } elseif ($_.Exception.Message -cin @('notFound', 'ambiguous', 'running', 'staleCheck')) {
        $status = $_.Exception.Message
    }
    Write-Reply $status
}
