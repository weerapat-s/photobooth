PHOTO BOOTH - INSTALL ON ANOTHER WINDOWS COMPUTER
=================================================

This package does not contain passwords, .env, Cloudflare credentials,
Nextcloud credentials, customer sessions, logs, or test photos.

REQUIREMENTS
1. Windows 10/11 64-bit
2. Node.js 22 LTS: https://nodejs.org
3. digiCamControl 2.1.7: https://digicamcontrol.com/download
4. Canon EOS R connected by a USB data cable to the Windows computer
5. Internet access during installation

INSTALL
1. Extract the entire ZIP to C:\PhotoBooth (do not run from inside the ZIP).
2. Install Node.js and digiCamControl first.
3. Double-click INSTALL.cmd.
4. Open .env and enter NC_BASE, NC_SHARE_TOKEN, NC_SHARE_PASSWORD,
   NC_USER and NC_APP_PASSWORD. Do not send this file through chat.
5. Set WEB_PAIR_CODE to the short code that the iPad operator will enter.
6. Restart Windows and verify that digiCamControl sees the EOS R.

CLOUDFLARE / booth.ienas.site
The public hostname can point to only one active Photo Booth backend for a
single-session booth. When replacing the old computer, stop the old bridge.

Move these files privately from the old Windows account to the same locations
under the new Windows account (never put them in this ZIP or in chat):
  %USERPROFILE%\.cloudflared\config.yml
  %USERPROFILE%\.cloudflared\<tunnel-id>.json

Install cloudflared, then copy cloudflared.exe to:
  %LOCALAPPDATA%\PhotoBooth\bin\cloudflared.exe

If this is an additional booth rather than a replacement, create a new Tunnel,
new hostname, new BOOTH_NAME, and a separate capture workflow. Do not run two
independent backends behind booth.ienas.site because sessions can split between
the two computers.

FIRST TEST
1. Connect and turn on EOS R; close EOS Utility and Capture One.
2. Open digiCamControl and check that EOS R appears.
3. Open https://booth.ienas.site on iPad Safari and allow Camera access.
4. The iPad camera is Live View only; the final photo comes from EOS R.
5. Take one complete test session before using it with customers.

UNINSTALL SHORTCUTS
Run in PowerShell from the PhotoBooth folder:
  npm run uninstall-shortcuts
