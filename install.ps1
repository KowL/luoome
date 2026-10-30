# luoome 一键安装脚本（Windows）—— 无需 git clone，PowerShell 一条命令装好 luoome
#
# 用法（PowerShell 5.1+ / PowerShell 7+）：
#   irm https://raw.githubusercontent.com/KowL/luoome/main/install.ps1 | iex
#
# 可覆盖项（环境变量）：
#   LUOOME_REF      源码 ref（分支 / tag / commit），默认 main
#   LUOOME_HOME     数据与源码根目录，默认 ~\.luoome（源码放在 $LUOOME_HOME\src）
#
# 重复执行即升级到最新 $LUOOME_REF。
#
# 注意：luoome 已无独立 CLI，只以 DSH 插件安装（见 packages/dsh-luoome/README.md）。
# 本脚本只负责把源码与工作区依赖装好，不再生成任何命令入口。

$ErrorActionPreference = 'Stop'
# PS5.1 默认 TLS 1.0，GitHub 要求 TLS 1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'KowL/luoome'
$Ref = if ($env:LUOOME_REF) { $env:LUOOME_REF } else { 'main' }
$LuoomeHome = if ($env:LUOOME_HOME) { $env:LUOOME_HOME } else { Join-Path $HOME '.luoome' }
$SrcDir = Join-Path $LuoomeHome 'src'

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

# 4. 无独立 CLI：luoome 只以 DSH 插件安装
Log ''
Log '==> 源码与依赖已就绪（luoome 不再提供独立 CLI）'
Log "    安装 DSH 插件：见 $SrcDir\packages\dsh-luoome\README.md"
Log ''
Log "源码：$SrcDir"
Log '升级：重新执行本脚本即可；卸载：删除该目录'
