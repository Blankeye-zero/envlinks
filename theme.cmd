@echo off
rem theme.cmd - switch colorscheme for Windows Terminal, Neovim, and pi agent.
rem See scripts\theme.ps1 for full usage; e.g.:
rem   theme.cmd                 interactive menu
rem   theme.cmd nord            apply installed themepack
rem   theme.cmd -Search gruvbox discover themes online (tinted-theming/schemes)
rem   theme.cmd -Validate <url-or-file>   test a themepack without applying
rem   theme.cmd -Help             full usage and examples
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\theme.ps1" %*
