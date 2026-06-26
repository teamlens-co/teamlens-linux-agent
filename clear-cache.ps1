Write-Host "TeamLens Cache Cleaner" -ForegroundColor Cyan
Write-Host "=====================" -ForegroundColor Cyan
Write-Host ""

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Note: Running without admin privileges (should be fine)" -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "Step 1: Checking for running TeamLens processes..." -ForegroundColor Yellow
$processes = Get-Process | Where-Object { $_.ProcessName -like "*teamlens*" -or $_.ProcessName -like "*desktop-agent*" }
if ($processes) {
    Write-Host "Found running TeamLens processes. Closing them..." -ForegroundColor Yellow
    $processes | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    Write-Host "Processes closed." -ForegroundColor Green
} else {
    Write-Host "No TeamLens processes running." -ForegroundColor Green
}
Write-Host ""

Write-Host "Step 2: Clearing WebView2 cache..." -ForegroundColor Yellow
$webview2Paths = @(
    "$env:LOCALAPPDATA\Microsoft\EdgeWebView2\EBWebView",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
    "$env:APPDATA\Microsoft\EdgeWebView2"
)

foreach ($path in $webview2Paths) {
    if (Test-Path $path) {
        try {
            Remove-Item -Recurse -Force $path -ErrorAction Stop
            Write-Host "Cleared: $path" -ForegroundColor Green
        } catch {
            Write-Host "Could not clear: $path (may be in use)" -ForegroundColor Yellow
        }
    }
}
Write-Host ""

Write-Host "Step 3: Clearing TeamLens app data..." -ForegroundColor Yellow
$teamlensPaths = @(
    "$env:APPDATA\com.teamlens.desktop-agent",
    "$env:LOCALAPPDATA\com.teamlens.desktop-agent",
    "$env:APPDATA\teamlens-desktop-agent",
    "$env:LOCALAPPDATA\teamlens-desktop-agent"
)

foreach ($path in $teamlensPaths) {
    if (Test-Path $path) {
        try {
            Remove-Item -Recurse -Force $path -ErrorAction Stop
            Write-Host "Cleared: $path" -ForegroundColor Green
        } catch {
            Write-Host "Could not clear: $path" -ForegroundColor Yellow
        }
    }
}
Write-Host ""

Write-Host "Step 4: Clearing Tauri temp build cache..." -ForegroundColor Yellow
$tauriCache = "C:\tmp\teamlens-tauri-target"
if (Test-Path $tauriCache) {
    try {
        Remove-Item -Recurse -Force $tauriCache -ErrorAction Stop
        Write-Host "Cleared: $tauriCache" -ForegroundColor Green
    } catch {
        Write-Host "Could not clear: $tauriCache" -ForegroundColor Yellow
    }
}
Write-Host ""

Write-Host "==================" -ForegroundColor Cyan
Write-Host "Cache cleared! ✓" -ForegroundColor Green
Write-Host "==================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Restart your laptop (important!)" -ForegroundColor White
Write-Host "2. Open TeamLens and test interaction" -ForegroundColor White
Write-Host ""
Write-Host "Done! Please restart your laptop now."
