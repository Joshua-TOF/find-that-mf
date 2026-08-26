<#
    Launches Studio Pro with the test app and the flag a development web extension needs.

    Without --enable-extension-development the extension is ignored SILENTLY - no error, no log
    line, it simply never loads. That is a confusing hour to lose, so always launch through this
    script rather than opening Studio Pro normally.

    Note that --enable-web-extensions is NOT passed. Studio Pro 11.12 rejects it outright and says
    so in its log:
        WARN ... Ignoring these unknown command-line options: --enable-web-extensions
    Guidance written for earlier 11.x pairs the two flags; on 11.12 the second one is dead.
    Verified in the Studio Pro log under %LOCALAPPDATA%\Mendix\log\<version>\log.txt.
#>
param(
    # Empty by default, resolved below to the newest Studio Pro 11 on this machine. Hardcoding a
    # version would break the script on every upgrade and on anyone else's install.
    [string]$StudioPro = "",
    [string]$Mpr = (Join-Path $PSScriptRoot "..\testapp\MfGraphTestApp.mpr"),
    [switch]$NoWait
)

function Find-StudioPro {
    <#
        Newest 11.x install wins. Directory names are compared as [version], not as strings, or
        11.9.0 would sort above 11.12.0.
    #>
    $roots = @("$env:ProgramFiles\Mendix", "${env:ProgramFiles(x86)}\Mendix")
    $found = foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path $root)) { continue }
        Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $exe = Join-Path $_.FullName "modeler\studiopro.exe"
            $parsed = $null
            if ((Test-Path $exe) -and
                [version]::TryParse($_.Name, [ref]$parsed) -and
                $parsed.Major -ge 11) {
                [pscustomobject]@{ Version = $parsed; Path = $exe }
            }
        }
    }
    ($found | Sort-Object Version -Descending | Select-Object -First 1).Path
}

if ([string]::IsNullOrWhiteSpace($StudioPro)) {
    $StudioPro = Find-StudioPro
    if ([string]::IsNullOrWhiteSpace($StudioPro)) {
        Write-Error "No Studio Pro 11.x found under Program Files\Mendix. Pass -StudioPro <path>."
        exit 1
    }
}
if (-not (Test-Path $StudioPro)) {
    Write-Error "Studio Pro not found at '$StudioPro'. Pass -StudioPro to point somewhere else."
    exit 1
}
if (-not (Test-Path $Mpr)) {
    Write-Error "Project not found at '$Mpr'. Pass -Mpr to point somewhere else."
    exit 1
}

$mprFull = (Resolve-Path $Mpr).Path
Write-Host "Launching $StudioPro"
Write-Host "  project : $mprFull"
Write-Host "  flags   : --enable-extension-development"

if ($NoWait) {
    # Start-Process joins ArgumentList with spaces and does no quoting of its own, so anything
    # containing a space has to arrive pre-quoted.
    Start-Process -FilePath $StudioPro -ArgumentList @(
        "`"$mprFull`""
        "--enable-extension-development"
    )
} else {
    & $StudioPro $mprFull --enable-extension-development
}
