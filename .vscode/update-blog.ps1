param(
    [string]$Root = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"

$listPath       = Join-Path $Root "posts\list.json"
$statsPath      = Join-Path $Root "stats.json"
$statsImportPath = Join-Path $Root "BlogImport\Statisticoutput.json"
$postsDir       = Join-Path $Root "posts"
$today          = Get-Date -Format "yyyy-MM-dd"

# -- 1. Find new posts ----------------------------------------------------------
$list          = Get-Content $listPath -Raw | ConvertFrom-Json
$existingFiles = $list | ForEach-Object { $_.file }
$allTxtFiles   = Get-ChildItem $postsDir -Filter "*.txt" | Select-Object -ExpandProperty Name
$newPosts      = $allTxtFiles | Where-Object { $_ -notin $existingFiles }

if (-not $newPosts) {
    Write-Host "No new posts found. Nothing to do."
    exit 0
}

Write-Host "New post(s) found: $($newPosts -join ', ')"

# -- 2. Add new posts to list.json ----------------------------------------------
foreach ($post in $newPosts) {
    $entry = [PSCustomObject]@{ file = $post; date = $today }
    $list  = @($list) + $entry
}

$list | ConvertTo-Json -Depth 2 | Set-Content $listPath -Encoding UTF8
Write-Host "Updated posts\list.json"

# -- 3. Merge Statisticoutput.json into stats.json ------------------------------
if (Test-Path $statsImportPath) {
    $imported = Get-Content $statsImportPath -Raw | ConvertFrom-Json
    $stats    = Get-Content $statsPath -Raw | ConvertFrom-Json

    foreach ($post in $newPosts) {
        $statsEntry = [PSCustomObject]@{
            file        = $post
            date        = $today
            keystrokes  = [int]$imported.Keystrokes
            timeElapsed = $imported.Elapsed
        }
        $stats = @($stats) + $statsEntry
    }

    $stats | ConvertTo-Json -Depth 2 | Set-Content $statsPath -Encoding UTF8
    Write-Host "Updated stats.json"

    Remove-Item $statsImportPath
    Write-Host "Removed BlogImport\Statisticoutput.json"
} else {
    Write-Host "No Statisticoutput.json found - skipping stats update."
}

# -- 4. Git commit ---------------------------------------------------------------
Set-Location $Root
git add -A
$message = "Add blog post: $($newPosts -join ', ') [$today]"
git commit -m $message
Write-Host "Committed: $message"
