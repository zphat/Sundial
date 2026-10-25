; Sundial NSIS hooks. After install (and after an update), tell the shell that file associations and icons
; changed, so the desktop and taskbar shortcuts pick up a new app icon instead of showing the cached old one.
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
