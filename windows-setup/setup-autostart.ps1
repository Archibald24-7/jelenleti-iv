<#
.SYNOPSIS
  Jelenléti Ív Kezelő - automatikus indítás beállítása Windows bejelentkezéskor.

.LESZÍRÁS
  Létrehoz egy parancsikont az aktuális felhasználó "Automatikus indítás" (Startup)
  mappájában, ami a böngészőt "app módban" (--app=...) nyitja meg a megadott URL-lel,
  kiegészítve a "?autostart=1" paraméterrel. Az alkalmazás ezt a paramétert felismeri,
  és automatikusan rögzíti a munkakezdést (lásd js/autoCheckin.js).

  NEM igényel rendszergazdai jogosultságot, és NEM igényel végrehajtási szabályzat
  (Execution Policy) módosítást, mert a szkript csak egy .lnk parancsikont hoz létre,
  nem futtat semmilyen program logikát a bejelentkezés pillanatában.

.HASZNÁLAT
  1. Nyisd meg a PowerShellt (Start menü -> írd be: PowerShell).
  2. Futtasd:
       powershell -ExecutionPolicy Bypass -File setup-autostart.ps1 -AppUrl "https://SAJAT-URL-ED/index.html"
     (cseréld ki a SAJAT-URL-ED részt a ténylegesen közzétett app címére)

.ELTÁVOLÍTÁS
  Win+R -> shell:startup -> töröld a "JelenletiIv.lnk" fájlt.

.MEGJEGYZÉS
  Ugyanezt a parancsot az alkalmazás Beállítások oldala is legenerálja neked, a saját
  URL-eddel előre kitöltve - onnan egyszerűen másolható/beilleszthető, szkriptfájl
  létrehozása nélkül. Ezt a fájlt azok számára tartjuk meg, akik inkább egy verziózható,
  újrafuttatható szkriptet szeretnének (pl. több gép egyszerre történő beállításához).
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$AppUrl
)

$ErrorActionPreference = 'Stop'

$candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browser) {
    Write-Host "Nem talalhato sem Edge, sem Chrome a szokasos helyen." -ForegroundColor Red
    Write-Host "Nyisd meg ezt a szkriptet szovegszerkesztoben, es a 'candidates' listaban" -ForegroundColor Red
    Write-Host "add meg kezzel a bongeszod .exe eleresi utjat." -ForegroundColor Red
    exit 1
}

$separator = if ($AppUrl -match '\?') { '&' } else { '?' }
$targetUrl = "$AppUrl${separator}autostart=1"

$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'JelenletiIv.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $browser
$shortcut.Arguments = "--app=`"$targetUrl`""
$shortcut.Description = 'Jelenleti Iv Kezelo - automatikus inditas'
$shortcut.Save()

Write-Host ""
Write-Host "Kesz!" -ForegroundColor Green
Write-Host "Parancsikon letrehozva: $shortcutPath"
Write-Host "Cel: $browser --app=`"$targetUrl`""
Write-Host ""
Write-Host "A kovetkezo Windows-bejelentkezeskor az alkalmazas automatikusan elindul," -ForegroundColor Cyan
Write-Host "es rogziti a munkakezdest." -ForegroundColor Cyan
Write-Host ""
Write-Host "Eltavolitas: Win+R -> shell:startup -> torold a JelenletiIv.lnk fajlt." -ForegroundColor DarkGray
