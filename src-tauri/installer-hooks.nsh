; ============================================================================
;  installer-hooks.nsh - NSIS hooks for BearNest VPN (bundle.windows.nsis.
;  installerHooks). Kills the app + core (xray/tun2socks) BEFORE install or
;  uninstall, clears stale TUN /1-routes and resets the system proxy left
;  behind by a crashed previous run. Without this the installer cannot
;  overwrite core\xray.exe while the core is still running.
;  ASCII only on purpose: makensis without a BOM may misread other encodings.
; ============================================================================

!macro _BN_KillCoreAndClear
  DetailPrint "Stopping BearNest VPN processes (app, xray, tun2socks)..."
  nsExec::Exec 'taskkill /F /T /IM "BearNest_VPN_Tauri+Rust.exe"'
  Pop $R9
  nsExec::Exec 'taskkill /F /T /IM "xray.exe"'
  Pop $R9
  nsExec::Exec 'taskkill /F /T /IM "tun2socks.exe"'
  Pop $R9
  Sleep 600

  ; Stale /1-routes (0.0.0.0/1 and 128.0.0.0/1 via the dead TUN gateway)
  ; blackhole the internet until they are removed.
  nsExec::Exec 'route delete 0.0.0.0 mask 128.0.0.0'
  Pop $R9
  nsExec::Exec 'route delete 128.0.0.0 mask 128.0.0.0'
  Pop $R9

  ; The system proxy must not stay enabled if the app was killed earlier.
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyEnable" 0x00000000
  System::Call 'wininet::InternetSetOption(p 0, i 39, p 0, i 0)'
  System::Call 'wininet::InternetSetOption(p 0, i 37, p 0, i 0)'

  DetailPrint "Cleanup done."
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _BN_KillCoreAndClear
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _BN_KillCoreAndClear
!macroend
