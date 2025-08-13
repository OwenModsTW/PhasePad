; Custom NSIS installer script for PhasePad
; This file adds custom installation behavior and update detection

; Variables for update detection
Var IsUpdate
Var OldVersion
Var PreviousDataPath
Var StartupCheckbox
Var StartupState

; Function to detect existing installation
!macro customInit
  ; Check if PhasePad is already installed
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "DisplayVersion"
  ${If} $0 != ""
    StrCpy $IsUpdate "true"
    StrCpy $OldVersion $0
    
    ; Read existing data path
    ReadRegStr $PreviousDataPath HKCU "Software\PhasePad" "DataPath"
    ${If} $PreviousDataPath == ""
      StrCpy $PreviousDataPath "$DOCUMENTS\PhasePad"
    ${EndIf}
    
    ; Close PhasePad if running
    KillProcWMI::KillProc "PhasePad.exe"
  ${Else}
    StrCpy $IsUpdate "false"
    StrCpy $PreviousDataPath "$DOCUMENTS\PhasePad"
  ${EndIf}
!macroend

; Custom installer pages and messages
!macro customInstall
  ${If} $IsUpdate == "true"
    ; This is an update
    DetailPrint "Updating PhasePad from version $OldVersion to ${VERSION}..."
    
    ; Preserve existing data path
    WriteRegStr HKCU "Software\PhasePad" "DataPath" "$PreviousDataPath"
    
    ; Update registry with new version
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "UninstallString" "$INSTDIR\Uninstall PhasePad.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "DisplayIcon" "$INSTDIR\PhasePad.exe"
    
    ; Show update complete message
    MessageBox MB_OK "PhasePad has been successfully updated to version ${VERSION}!$\r$\n$\r$\nYour notes and settings have been preserved."
    
  ${Else}
    ; This is a fresh install
    DetailPrint "Installing PhasePad version ${VERSION}..."
    
    ; Create data folder in user's Documents
    CreateDirectory "$PreviousDataPath"
    
    ; Set registry entries for data folder preference
    WriteRegStr HKCU "Software\PhasePad" "DataPath" "$PreviousDataPath"
    
    ; Add uninstaller registry entries
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "DisplayName" "PhasePad"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "UninstallString" "$INSTDIR\Uninstall PhasePad.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "DisplayIcon" "$INSTDIR\PhasePad.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "Publisher" "OwenModsTW"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad" "DisplayVersion" "${VERSION}"
    
    ; Add to startup if checkbox was checked
    ${If} $StartupState == ${BST_CHECKED}
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PhasePad" '"$INSTDIR\PhasePad.exe" --startup'
      WriteRegStr HKCU "Software\PhasePad" "StartWithWindows" "true"
      StrCpy $R1 "PhasePad will start automatically with Windows."
    ${Else}
      WriteRegStr HKCU "Software\PhasePad" "StartWithWindows" "false"
      StrCpy $R1 "PhasePad will not start automatically with Windows."
    ${EndIf}
    
    ; Show welcome message for new users
    MessageBox MB_YESNO "Welcome to PhasePad!$\r$\n$\r$\nYour notes will be stored in: $PreviousDataPath$\r$\n$\r$\n$R1$\r$\n$\r$\nWould you like to start PhasePad now?" IDNO NoLaunch
      Exec "$INSTDIR\PhasePad.exe"
    NoLaunch:
  ${EndIf}
  
  ; Always update these registry entries
  WriteRegStr HKCU "Software\PhasePad" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "Software\PhasePad" "Version" "${VERSION}"
  WriteRegDWORD HKCU "Software\PhasePad" "InstallTime" $R0
!macroend

; Custom uninstaller
!macro customUnInstall
  ; Remove startup registry entry
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PhasePad"
  
  ; Remove registry entries
  DeleteRegKey HKCU "Software\PhasePad"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhasePad"
  
  ; Ask if user wants to keep their data
  MessageBox MB_YESNO "Do you want to keep your PhasePad notes and settings?" IDYES KeepData
    RMDir /r "$DOCUMENTS\PhasePad"
  KeepData:
!macroend

; Custom installer welcome message
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to PhasePad Setup"
  !define MUI_WELCOMEPAGE_TEXT "This wizard will guide you through the installation of PhasePad.$\r$\n$\r$\nPhasePad is a desktop sticky notes overlay application that helps you stay organized.$\r$\n$\r$\nYour notes will be stored in your Documents folder by default, but you can change this location later in settings.$\r$\n$\r$\nClick Next to continue."
!macroend

; Custom finish page
!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "PhasePad Installation Complete"
  !define MUI_FINISHPAGE_TEXT "PhasePad has been successfully installed on your computer.$\r$\n$\r$\nPress Alt+Q to show/hide the overlay anytime.$\r$\n$\r$\nYour data will be stored in: $DOCUMENTS\PhasePad"
  !define MUI_FINISHPAGE_RUN "$INSTDIR\PhasePad.exe"
  !define MUI_FINISHPAGE_RUN_TEXT "Launch PhasePad"
!macroend

; Custom options page for startup settings
!macro customPageAfterChangeDir
  ; Create custom page for startup options
  !insertmacro MUI_PAGE_CUSTOM CustomOptionsPage CustomOptionsPageLeave
!macroend

; Custom options page
Function CustomOptionsPage
  ${If} $IsUpdate == "true"
    ; Skip options page for updates
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Additional Options" "Choose additional options for PhasePad"
  
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  
  ; Add checkbox for startup option
  ${NSD_CreateCheckbox} 10 20 300 15 "&Start PhasePad automatically when Windows starts"
  Pop $StartupCheckbox
  
  ; Check the box by default
  ${NSD_Check} $StartupCheckbox
  
  ; Add description text
  ${NSD_CreateLabel} 10 50 300 40 "This will add PhasePad to your Windows startup programs. You can change this later in PhasePad settings or Windows startup settings."
  Pop $0
  
  nsDialogs::Show
FunctionEnd

; Handle the custom page results
Function CustomOptionsPageLeave
  ; Get checkbox state
  ${NSD_GetState} $StartupCheckbox $StartupState
FunctionEnd