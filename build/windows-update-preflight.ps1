# Read-only installer gate. No process is terminated, including on query failure.
# Exit 0 = clear, 10 = app/host running, 20 = could not prove it is safe to proceed.
param([Parameter(Mandatory = $true)][string]$InstallDirectory)
$ErrorActionPreference = 'Stop'
try {
    if ($InstallDirectory -notmatch '^(?:[A-Za-z]:\\|\\\\)') { exit 20 }
    $directory = $InstallDirectory.TrimEnd('\') + '\'
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    foreach ($process in $processes) {
        if ($process.Name -ine 'nodeterm.exe' -and $process.Name -ine 'nodeterm-session-host.exe') { continue }
        # An inaccessible process might be another user's host in an all-users installation.
        # Absence of a path is not proof that it belongs to a different installation.
        if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) { exit 20 }
        if ($process.ExecutablePath.StartsWith($directory, [StringComparison]::OrdinalIgnoreCase)) { exit 10 }
    }
    exit 0
} catch {
    exit 20
}
