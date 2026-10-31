$ErrorActionPreference = 'Continue'
Set-Location 'C:\Users\HP\Desktop\New folder (3)\stockpulse'
$logDir = 'qa-security-suite\.artifacts'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$out = Join-Path $logDir 'backend-run.log'

$bin  = (Resolve-Path 'node_modules\@embedded-postgres\windows-x64\native\bin').Path
$data = (Resolve-Path '.pgdata').Path
$pgLog = Join-Path $data 'log\pg_ctl.out.log'

function Test-Pg {
  $c = Get-NetTCPConnection -LocalPort 55432 -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

"=== orchestrator start $(Get-Date -Format o) ===" | Tee-Object -FilePath $out
if (-not (Test-Pg)) {
  "starting postgres (pg_ctl start -w) ..." | Tee-Object -FilePath $out -Append
  & (Join-Path $bin 'pg_ctl.exe') start -D $data -l $pgLog -w -t 60 2>&1 |
    Tee-Object -FilePath $out -Append
} else {
  "postgres already listening" | Tee-Object -FilePath $out -Append
}

for ($i = 0; $i -lt 60; $i++) {
  if (Test-Pg) { break }
  Start-Sleep -Seconds 1
}
"listening: $(Test-Pg) after ${i}s" | Tee-Object -FilePath $out -Append

"=== vitest ===" | Tee-Object -FilePath $out -Append
& npx vitest run --project backend 2>&1 | Tee-Object -FilePath $out -Append
"vitest exit: $LASTEXITCODE" | Tee-Object -FilePath $out -Append

"=== stopping postgres ===" | Tee-Object -FilePath $out -Append
& (Join-Path $bin 'pg_ctl.exe') stop -D $data -m fast -w -t 30 2>&1 |
  Tee-Object -FilePath $out -Append
Get-Process | Where-Object { $_.Name -like 'postgres*' } |
  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
"=== orchestrator end $(Get-Date -Format o) ===" | Tee-Object -FilePath $out -Append
