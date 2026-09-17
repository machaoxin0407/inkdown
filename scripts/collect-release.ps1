$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot
$releasePath = Join-Path $projectRoot 'release'
$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force $releasePath | Out-Null
Copy-Item -LiteralPath 'src-tauri\target\release\inkdown.exe' -Destination (Join-Path $releasePath 'Inkdown.exe')
Copy-Item -LiteralPath "src-tauri\target\release\bundle\nsis\Inkdown_${version}_x64-setup.exe" -Destination $releasePath
Copy-Item -LiteralPath 'README.md','VALIDATION.md','THIRD_PARTY_NOTICES.txt','LICENSE' -Destination $releasePath
Copy-Item -LiteralPath 'examples' -Destination $releasePath -Recurse -Force
$archiveItems = @('Inkdown.exe','README.md','VALIDATION.md','THIRD_PARTY_NOTICES.txt','LICENSE','examples') | ForEach-Object { Join-Path $releasePath $_ }
Compress-Archive -LiteralPath $archiveItems -DestinationPath (Join-Path $releasePath "Inkdown_${version}_x64-standalone.zip") -Force
$publishedFiles = @('Inkdown.exe',"Inkdown_${version}_x64-setup.exe", "Inkdown_${version}_x64-standalone.zip",'LICENSE','THIRD_PARTY_NOTICES.txt')
$publishedFiles | ForEach-Object { Get-Item -LiteralPath (Join-Path $releasePath $_) } | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  '{0}  {1}' -f $hash, $_.Name
} | Set-Content (Join-Path $releasePath 'SHA256SUMS.txt') -Encoding utf8
Get-ChildItem $releasePath -File | Select-Object Name,Length
