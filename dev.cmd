@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  dev.cmd - open the current directory in Windows Terminal with this layout:
rem
rem    +----------------------------+---------------+
rem    |                            |               |
rem    |       nvim  (70%)          |   pi  (30%)   |
rem    |                            |               |
rem    +----------------------------+---------------+
rem    |      terminal  (20% height, full width)    |
rem    +--------------------------------------------+
rem
rem  Usage:
rem    dev.cmd              -> uses the current directory
rem    dev.cmd C:\some\dir  -> uses the given directory
rem    Use the Command Panel Ctrl+Shift+P to manage the panes or Ctrl+Shift+w to close them.
rem
rem  Notes:
rem    - -H/--horizontal = split up/down (new pane BELOW)
rem    - -V/--vertical   = split left/right (new pane to the RIGHT)
rem    - -s <float>      = size of the NEW pane as a fraction of the parent
rem    - nvim and pi are pinned to the default profile with -p, because a
rem      commandline that matches no profile would fall back to the generic
rem      "Defaults" profile (black background) instead of Catppuccin
rem ---------------------------------------------------------------------------

set "DIR=%CD%"
if not "%~1"=="" set "DIR=%~1"

wt.exe -p "Windows PowerShell" -d "%DIR%" nvim ; split-pane -H -s 0.2 -d "%DIR%" ; move-focus up ; split-pane -V -s 0.3 -d "%DIR%" -p "Windows PowerShell" cmd /k pi ; move-focus left

endlocal
