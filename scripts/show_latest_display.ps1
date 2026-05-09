$ErrorActionPreference = "Stop"

$Backend = "http://127.0.0.1:8787"
$Latest = Invoke-RestMethod "$Backend/api/sessions/latest"
$DisplayUrl = "$Backend/display/$($Latest.session_id)"

Write-Host "Latest ready session: $($Latest.session_id)"
Write-Host "Display URL: $DisplayUrl"
Write-Host "Open this URL in the browser:"
Write-Host $DisplayUrl
