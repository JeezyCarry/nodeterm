# Override BOTH install and uninstall checks. The stock check can kill processes under INSTDIR,
# including the detached session host. A renamed hard link still holds the installed image open.
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\nodeterm-update-preflight.ps1 "${BUILD_RESOURCES_DIR}/windows-update-preflight.ps1"
  nodeterm_preflight_retry:
    nsExec::Exec /TIMEOUT=15000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\nodeterm-update-preflight.ps1" -InstallDirectory "$INSTDIR"'
    Pop $R0
    ${If} $R0 == 0
      Goto nodeterm_preflight_clear
    ${EndIf}
    # Silent installs must fail closed too, with a nonzero result and no default consent.
    SetErrorLevel 2
    IfSilent nodeterm_preflight_cancel
    ${If} $R0 == 10
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "nodeterm, a background session host, or a process using the installation path is still running.$\r$\n$\r$\nClosing the app keeps terminal and agent sessions alive. Updating requires those sessions to end.$\r$\n$\r$\nCancel to keep working. When ready, save your work, reopen nodeterm, and end local sessions in every project (Sessions sidebar: End session). Quit nodeterm, wait at least 30 seconds for the host to exit, then retry.$\r$\n$\r$\nOther nodeterm installations and Windows users must also finish their sessions. Run this installer from Downloads, outside the install directory. This installer will not stop your sessions for you." /SD IDCANCEL IDRETRY nodeterm_preflight_retry
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "nodeterm could not verify whether the app or its background session host is running. No sessions have been stopped.$\r$\n$\r$\nCancel and check that Windows PowerShell and process queries are available. If another Windows user is running nodeterm, ask them to save and end their sessions before retrying." /SD IDCANCEL IDRETRY nodeterm_preflight_retry
    ${EndIf}
  nodeterm_preflight_cancel:
    Quit
  nodeterm_preflight_clear:
    SetErrorLevel 0
!macroend
