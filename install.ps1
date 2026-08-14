# luoome 一键安装脚本（Windows）—— 无需 git clone，PowerShell 一条命令装好 luoome
#
# 用法（PowerShell 5.1+ / PowerShell 7+）：
#   irm https://raw.githubusercontent.com/KowL/luoome/main/install.ps1 | iex
#
# 可覆盖项（环境变量）：
#   LUOOME_REF      源码 ref（分支 / tag / commit），默认 main
#   LUOOME_HOME     数据与源码根目录，默认 ~\.luoome（源码放在 $LUOOME_HOME\src）
#   LUOOME_BIN_DIR  luoome 命令安装目录，默认 $LUOOME_HOME\bin
#
# 重复执行即升级到最新 $LUOOME_REF。

$ErrorActionPreference = 'Stop'
# PS5.1 默认 TLS 1.0，GitHub 要求 TLS 1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'KowL/luoome'
$Ref = if ($env:LUOOME_REF) { $env:LUOOME_REF } else { 'main' }
$LuoomeHome = if ($env:LUOOME_HOME) { $env:LUOOME_HOME } else { Join-Path $HOME '.luoome' }
$SrcDir = Join-Path $LuoomeHome 'src'
$BinDir = if ($env:LUOOME_BIN_DIR) { $env:LUOOME_BIN_DIR } else { Join-Path $LuoomeHome 'bin' }
$CliEntry = Join-Path $SrcDir 'packages/cli/src/index.ts'

function Log($Msg) { Write-Host $Msg }
# 经 irm | iex 执行时 exit 会关掉用户终端，统一用 throw 中止
function Fail($Msg) { throw "error: $Msg" }

# 1. Bun：luoome 全程跑裸 Bun TS 解释 + bun:sqlite，Bun 是硬运行时依赖
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  $LocalBunBin = Join-Path $HOME '.bun\bin'
  if (Test-Path (Join-Path $LocalBunBin 'bun.exe')) {
    $env:PATH = "$LocalBunBin;$env:PATH"
  } else {
    Log '==> 未找到 bun，开始安装 Bun'
    irm bun.sh/install.ps1 | iex
    $env:PATH = "$LocalBunBin;$env:PATH"
  }
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Fail 'Bun 安装失败，请手动安装：https://bun.sh'
}
Log "==> Bun $(bun --version)"

# 2. 下载源码 zip（codeload 支持分支 / tag / commit，不需要 git）
Log "==> 下载 luoome 源码（$Repo @ $Ref）"
New-Item -ItemType Directory -Force -Path $LuoomeHome | Out-Null
$Zip = Join-Path $LuoomeHome "install-$PID.zip"
$ExtractDir = Join-Path $LuoomeHome "install-$PID-extract"
try {
  Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/$Ref" -OutFile $Zip -UseBasicParsing
} catch {
  Fail "源码下载失败，请检查 ref 是否存在：$Ref"
}
try {
  if (Test-Path $ExtractDir) { Remove-Item -Recurse -Force $ExtractDir }
  Expand-Archive -Path $Zip -DestinationPath $ExtractDir -Force
  $Inner = Get-ChildItem $ExtractDir | Select-Object -First 1
  if ($null -eq $Inner) { Fail '源码解压结果为空' }
  if (Test-Path $SrcDir) { Remove-Item -Recurse -Force $SrcDir }
  Move-Item $Inner.FullName $SrcDir
} finally {
  Remove-Item -Force $Zip -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $ExtractDir -ErrorAction SilentlyContinue
}

# 3. 工作区依赖
Log '==> 安装依赖（bun install --frozen-lockfile）'
Push-Location $SrcDir
try {
  bun install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Fail "bun install 失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
}

# 4. luoome 命令 shim（.cmd，PowerShell / cmd 都能直接调）
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Shim = Join-Path $BinDir 'luoome.cmd'
# cmd 按系统代码页读批处理，shim 内容保持纯 ASCII
$ShimContent = @"
@echo off
where bun >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
  ) else (
    echo error: bun not found, install from https://bun.sh 1>&2
    exit /b 1
  )
)
bun "$CliEntry" %*
"@
Set-Content -Path $Shim -Value $ShimContent -Encoding ascii

# 5. 加入用户 PATH（当前会话即时生效，新终端由用户环境变量生效）
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($UserPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', "$UserPath;$BinDir", 'User')
  Log "已将 $BinDir 加入用户 PATH（新开的终端生效）"
}
$env:PATH = "$BinDir;$env:PATH"

# 6. 验证（直接跑 CLI 入口，不经过 shim，避免受当前会话 PATH 影响）
Log '==> 验证安装'
bun $CliEntry --version | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'luoome 安装后无法运行，请查看上方输出' }

Log ''
Log '安装完成：'
Log "  源码：$SrcDir"
Log "  命令：$Shim"
Log ''
Log '下一步（重新打开终端让 PATH 生效）：'
Log '  luoome start        # 启动 Web + 长驻盯盘（浏览器打开 http://127.0.0.1:5173）'
Log '  luoome --help       # 查看全部命令'
Log ''
Log "升级：重新执行本脚本即可；卸载：删除 $SrcDir 与 $Shim"
