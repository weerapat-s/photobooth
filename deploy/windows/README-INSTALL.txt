PHOTO BOOTH - KMITL EXPO 2026
INSTALLING ON ANOTHER WINDOWS COMPUTER
======================================

Run PhotoBoothSetup.exe and answer nothing. When it finishes, the booth is
ready: shortcuts on the desktop, NAS upload configured, and the QR code that
customers scan already points at their own private folder.

WHAT IS IN THE INSTALLER
  - the booth application and every dependency it needs
  - its own copy of Node.js, so nothing has to be installed first
  - the KMITL EXPO card template
  - the Nextcloud settings, including the app password for this NAS account

That last line matters: anyone who has this .exe can write to the NAS. Hand it
only to the booth computers for this event. If the file gets out, revoke that
app password in Nextcloud (Settings > Security) and rebuild the installer.

REQUIREMENTS
  1. Windows 10/11 64-bit
  2. A DSLR/mirrorless camera supported by digiCamControl, on a USB data cable
  3. Internet access during installation, and while the booth runs (the photos
     go to the NAS)
  Administrator rights are NOT needed for the booth itself. Windows will ask
  for them once if digiCamControl still has to be installed.

WHAT THE INSTALLER DOES
  1. Closes any running copy of the booth.
  2. Installs to %LOCALAPPDATA%\PhotoBooth, keeping the existing .env, the
     photo sessions, and the logs when it is an update.
  3. Writes a fresh .env: NAS settings baked in, a new random iPad token, and
     BOOTH_NAME set from the computer name so sessions are traceable.
  4. Downloads and installs digiCamControl 2.1.7 if it is missing. This also
     supplies the ffmpeg that builds the video, so let it finish.
  5. Creates the "Photo Booth" and "จอช่าง" shortcuts, starts the backend at
     login, and adds a watchdog task that restarts it if it dies.
  6. Uploads a probe folder to the NAS, creates and deletes a share on it, and
     reads the card template. It prints exactly what failed if anything did.

OPTIONS (only needed for testing)
  PhotoBoothSetup.exe -Target D:\PhotoBooth   install somewhere else
  PhotoBoothSetup.exe -SkipCamera             do not touch digiCamControl
  PhotoBoothSetup.exe -SkipShortcuts          do not create shortcuts

FIRST TEST
  1. Connect and turn on the camera. Close any other tethering software
     (EOS Utility, Capture One, ...) - only one program can hold the camera.
  2. Open digiCamControl once and confirm the camera appears.
  3. Double-click "Photo Booth" and run one complete session.
  4. Scan the QR code with a phone. It must open that session's photos and
     video, and nothing belonging to anyone else.

IPAD KIOSK OVER THE INTERNET (optional)
The booth works on its own; the QR code goes straight to the NAS and does not
need a tunnel. A tunnel is only needed to open the kiosk screen on an iPad
from outside this computer.

booth.ienas.site can point at one backend at a time. Move these files privately
from the old Windows account to the new one - never put them in this installer
or send them through chat:
  %USERPROFILE%\.cloudflared\config.yml
  %USERPROFILE%\.cloudflared\<tunnel-id>.json
Then copy cloudflared.exe to %LOCALAPPDATA%\PhotoBooth\bin\cloudflared.exe.

For a second booth rather than a replacement, create a new tunnel and hostname.
Do not run two backends behind one hostname; sessions will split between them.

CHANGING SETTINGS LATER
Open "จอช่าง" and use the settings screen, or edit
%LOCALAPPDATA%\PhotoBooth\.env directly and restart the booth.

REMOVING
  %LOCALAPPDATA%\PhotoBooth\launch\install-shortcuts.ps1 -Uninstall
then delete %LOCALAPPDATA%\PhotoBooth. Photos already on the NAS are untouched.
