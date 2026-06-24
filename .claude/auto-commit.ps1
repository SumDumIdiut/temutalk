Set-Location "C:\Users\Name\Downloads\Speaker"

git add -A

# Nothing staged — nothing to do
$staged = git diff --cached --name-status
if (-not $staged) { exit 0 }

# Build commit message from staged file statuses
$added    = @()
$modified = @()
$deleted  = @()

foreach ($line in $staged -split "`n") {
    $line = $line.Trim()
    if (-not $line) { continue }
    $parts = $line -split "\t", 2
    $status = $parts[0]
    $file   = Split-Path -Leaf $parts[1]
    if     ($status -eq "A") { $added    += $file }
    elseif ($status -eq "M") { $modified += $file }
    elseif ($status -eq "D") { $deleted  += $file }
    else                     { $modified += $file }
}

$parts = @()
if ($added)    { $parts += "Add "    + ($added    -join ", ") }
if ($modified) { $parts += "Update " + ($modified -join ", ") }
if ($deleted)  { $parts += "Delete " + ($deleted  -join ", ") }

$msg = if ($parts) { $parts -join "; " } else { "Auto-save changes" }

git commit -m $msg
git push origin main
