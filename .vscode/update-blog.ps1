param(
    [string]$Root = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"

$statsPath       = Join-Path $Root "stats.json"
$statsImportPath = Join-Path $Root "BlogImport\Statisticoutput.json"

function Get-DisplayTitle {
    param([string]$FileName)

    $title = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
    $title = $title -replace '([a-z])([A-Z])', '$1 $2'
    $title = $title -replace '[-_]+', ' '
    $title = ($title -replace '\s+', ' ').Trim()

    if (-not $title) {
        return $FileName
    }

    $textInfo = (Get-Culture).TextInfo
    return $textInfo.ToTitleCase($title.ToLower())
}

$today = Get-Date -Format "yyyy-MM-dd"
$contentRoots = @(
    @{ Name = 'posts';  Dir = Join-Path $Root 'posts';  ListPath = Join-Path $Root 'posts\list.json';  Type = 'post' },
    @{ Name = 'papers'; Dir = Join-Path $Root 'papers'; ListPath = Join-Path $Root 'papers\list.json'; Type = 'report' }
)

# -- 1. Find new content --------------------------------------------------------
$newContentByRoot = @{}

foreach ($contentRoot in $contentRoots) {
    $list = if (Test-Path $contentRoot.ListPath) {
        Get-Content $contentRoot.ListPath -Raw | ConvertFrom-Json
    } else {
        @()
    }

    $existingFiles = @($list | ForEach-Object { $_.file })
    $allTxtFiles = Get-ChildItem $contentRoot.Dir -Filter "*.txt" | Select-Object -ExpandProperty Name
    $newFiles = @($allTxtFiles | Where-Object { $_ -notin $existingFiles })

    if ($newFiles.Count -eq 0) {
        continue
    }

    $newContentByRoot[$contentRoot.Name] = [PSCustomObject]@{
        ContentRoot = $contentRoot
        List        = $list
        NewFiles    = $newFiles
    }
}

if ($newContentByRoot.Count -eq 0) {
    Write-Host "No new posts or reports found. Checking for existing changes."
} else {
    foreach ($entry in $newContentByRoot.GetEnumerator()) {
        Write-Host "New $($entry.Key) found: $($entry.Value.NewFiles -join ', ')"
    }

    # -- 2. Add new content to list.json --------------------------------------------
    foreach ($entry in $newContentByRoot.GetEnumerator()) {
        $contentRoot = $entry.Value.ContentRoot
        $list = $entry.Value.List

        foreach ($fileName in $entry.Value.NewFiles) {
            if ($contentRoot.Type -eq 'report') {
                $newEntry = [PSCustomObject]@{
                    title     = Get-DisplayTitle $fileName
                    file      = $fileName
                    status    = 'in-progress'
                    startDate = $today
                    endDate   = $null
                    tags      = @()
                }
            } else {
                $newEntry = [PSCustomObject]@{ file = $fileName; date = $today }
            }

            $list = @($list) + $newEntry
        }

        $list | ConvertTo-Json -Depth 4 | Set-Content $contentRoot.ListPath -Encoding UTF8
        Write-Host "Updated $($contentRoot.Name)\list.json"
    }
}

# -- 3. Merge Statisticoutput.json into stats.json ------------------------------
if (Test-Path $statsImportPath) {
    $imported = Get-Content $statsImportPath -Raw | ConvertFrom-Json
    $stats    = Get-Content $statsPath -Raw | ConvertFrom-Json

    foreach ($entry in $newContentByRoot.GetEnumerator()) {
        foreach ($fileName in $entry.Value.NewFiles) {
            $statsEntry = [PSCustomObject]@{
                file        = $fileName
                date        = $today
                keystrokes  = [int]$imported.Keystrokes
                timeElapsed = $imported.Elapsed
            }
            $stats = @($stats) + $statsEntry
        }
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
if (-not (git status --porcelain)) {
    Write-Host "Nothing to commit after update."
    exit 0
}

git add -A
$allNewFiles = $newContentByRoot.GetEnumerator() | ForEach-Object { $_.Value.NewFiles } | ForEach-Object { $_ }
$message = "Add content: $($allNewFiles -join ', ') [$today]"
git commit -m $message
Write-Host "Committed: $message"
