# me2 로컬 실행 스크립트
# 1) Cloudflare 임시 터널을 열어 공개 주소(https://xxxx.trycloudflare.com)를 받고
# 2) 그 주소를 PUBLIC_BASE_URL 로 넣어 서버를 띄웁니다.
#    (스레드에 이미지/영상을 올릴 때 Meta 서버가 이 주소에서 파일을 가져감)
# 사용법: start-local.bat 더블클릭, 또는  powershell -ExecutionPolicy Bypass -File start-local.ps1
# 터널 없이 PC에서만 쓰려면:  start-local.ps1 -NoTunnel
# .env 에 NGROK_DOMAIN(예: xxx.ngrok-free.app)이 있으면 ngrok 고정 주소를 씀 → 재시작해도 주소·로그인 유지

param([switch]$NoTunnel)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host '.env 파일을 새로 만들었습니다. 값(ADMIN_EMAIL, OPENAI_API_KEY 등)을 채운 뒤 다시 실행하세요.' -ForegroundColor Yellow
  notepad .env
  exit 1
}

$port = 3000
$portLine = Select-String -Path '.env' -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }

$tunnel = $null
$ngrokDomain = $null
$ngLine = Select-String -Path '.env' -Pattern '^\s*NGROK_DOMAIN\s*=\s*(\S+)' | Select-Object -First 1
if ($ngLine) { $ngrokDomain = $ngLine.Matches[0].Groups[1].Value -replace '^https?://', '' -replace '/+$', '' }

if (-not $NoTunnel -and $ngrokDomain) {
  if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Write-Host 'ngrok 이 없습니다:  winget install Ngrok.Ngrok' -ForegroundColor Red
    exit 1
  }
  $url = "https://$ngrokDomain"
  $tunnel = Start-Process -FilePath 'ngrok' -ArgumentList @('http', "--url=$url", "$port", '--log=stdout') `
    -WindowStyle Hidden -PassThru
  $env:PUBLIC_BASE_URL = $url
  $env:THREADS_REDIRECT_URI = "$url/auth/callback"
  Write-Host ''
  Write-Host "공개 주소 : $url  (ngrok 고정 주소)" -ForegroundColor Green
  Write-Host "콜백 주소 : $url/auth/callback  (스레드 계정 새로 연결할 때만 Meta 앱에 등록 필요)"
}
elseif (-not $NoTunnel) {
  $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
  $cfPath = if ($cf) { $cf.Source } else { 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
  if (-not (Test-Path $cfPath)) {
    Write-Host 'cloudflared 가 없습니다:  winget install Cloudflare.cloudflared' -ForegroundColor Red
    exit 1
  }

  $log = Join-Path $env:TEMP 'me2-cloudflared.log'
  Remove-Item $log -ErrorAction SilentlyContinue
  $tunnel = Start-Process -FilePath $cfPath `
    -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$port", '--logfile', $log) `
    -WindowStyle Hidden -PassThru

  Write-Host '터널 주소 받는 중...'
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $log) {
      $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value }
    }
  }
  if (-not $url) {
    Write-Host "터널 주소를 받지 못했습니다. 로그: $log" -ForegroundColor Red
    Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
    exit 1
  }

  # 시스템 환경변수는 .env 보다 우선함 (dotenv 기본 동작)
  $env:PUBLIC_BASE_URL = $url
  $env:THREADS_REDIRECT_URI = "$url/auth/callback"
  Write-Host ''
  Write-Host "공개 주소 : $url" -ForegroundColor Green
  Write-Host "콜백 주소 : $url/auth/callback  (스레드 계정 새로 연결할 때만 Meta 앱에 등록 필요)"
}

Write-Host "로컬 주소 : http://localhost:$port" -ForegroundColor Green
Write-Host '종료하려면 이 창에서 Ctrl+C'
Write-Host ''

try {
  npm start
} finally {
  if ($tunnel) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
}
