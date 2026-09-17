param([ValidateSet('dev','build','test')][string]$Action = 'dev')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot
if (Test-Path "$projectRoot\.tools\cargo\bin\cargo.exe") {
  $env:RUSTUP_HOME = "$projectRoot\.tools\rustup"
  $env:CARGO_HOME = "$projectRoot\.tools\cargo"
  $env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
}
if ($Action -eq 'test') { cargo test --manifest-path src-tauri/Cargo.toml } else { & npm.cmd run tauri -- $Action }
exit $LASTEXITCODE
