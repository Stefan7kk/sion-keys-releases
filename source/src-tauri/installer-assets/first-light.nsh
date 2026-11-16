; Included by Tauri before the stock Modern UI pages are declared.
; LCIDs are explicit because the language macros run after the page declarations.
LangString FirstLightWelcomeTitle 1033 "Welcome to Sion Keys"
LangString FirstLightWelcomeTitle 1026 "Добре дошли в Sion Keys"
LangString FirstLightWelcomeText 1033 "01  Welcome    ───    02  Install    ───    03  Ready$\r$\n$\r$\nDiscover chords, understand musical keys, and practice your favorite songs with confidence.$\r$\n$\r$\n•  Chords and keys from audio or YouTube$\r$\n$\r$\n•  Practice with synchronized lyrics and chords$\r$\n$\r$\n•  Piano, guitar, and bass chord diagrams"
LangString FirstLightWelcomeText 1026 "01  Добре дошли   ──   02  Инсталиране   ──   03  Готово$\r$\n$\r$\nОткривайте акорди и тоналности и упражнявайте любимите си песни с увереност.$\r$\n$\r$\n•  Акорди и тоналности от аудиозапис или YouTube$\r$\n$\r$\n•  Упражнения със синхронизиран текст и акорди$\r$\n$\r$\n•  Диаграми за пиано, китара и бас"
LangString FirstLightFinishTitle 1033 "Sion Keys is ready!"
LangString FirstLightFinishTitle 1026 "Sion Keys е готово за използване!"
LangString FirstLightFinishText 1033 "03  Ready$\r$\n$\r$\nInstallation completed successfully."
LangString FirstLightFinishText 1026 "03  Готово$\r$\n$\r$\nИнсталацията завърши успешно."
LangString FirstLightLaunch 1033 "Launch Sion Keys"
LangString FirstLightLaunch 1026 "Стартиране на Sion Keys"

!define MUI_BGCOLOR "202124"
!define MUI_TEXTCOLOR "F2F2F3"
!define MUI_INSTFILESPAGE_COLORS "E9E9EA 202124"
!define MUI_CUSTOMFUNCTION_GUIINIT FirstLightWindow
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.FirstLightWindow
!define MUI_WELCOMEPAGE_TITLE "$(FirstLightWelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(FirstLightWelcomeText)"
!define MUI_FINISHPAGE_TITLE "$(FirstLightFinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(FirstLightFinishText)"
!define MUI_FINISHPAGE_RUN_TEXT "$(FirstLightLaunch)"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!macro FirstLightWindowColors
  ; Request the dark caption on Windows builds that support DWM attribute 20.
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i'
  SetCtlColors $HWNDPARENT "" "28292C"
  Push $0
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 "" "28292C"
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 "D2D2D5" "28292C"
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Windows 10 / 11 · Sion Keys"
  Pop $0
!macroend

Function FirstLightWindow
  !insertmacro FirstLightWindowColors
FunctionEnd

Function un.FirstLightWindow
  !insertmacro FirstLightWindowColors
FunctionEnd
