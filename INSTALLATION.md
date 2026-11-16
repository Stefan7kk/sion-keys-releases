# Installing and updating Sion Keys

Sion Keys is distributed as a Windows x64 desktop installer.

## Install

1. Open [GitHub Releases](https://github.com/Stefan7kk/sion-keys-releases/releases) and expand **Assets** for the version you want.
2. Download the file ending in `_windows_x64_setup.exe`. The companion `.sig` file is used by the app’s updater.
3. Run the installer and open **Sion Keys** from the Start menu.

The installer includes the core audio analysis engine. The separate Whisper setup is optional and is used for local lyric transcription and verification. If a release includes that helper, see its release notes for setup details.

Windows may show an unknown-publisher warning for the installer. Confirm the installer came from the official release and compare its SHA-256 checksum before running it.

## Verify a download

Download `SHA256SUMS.txt` from the same release. In PowerShell, run this command from the download folder, using the filename of the installer you downloaded:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\SionKeys_0.1.1_windows_x64_setup.exe'
```

Compare the result to the line for that installer in `SHA256SUMS.txt`. Download the file again from GitHub Releases if the hashes differ.

## Check for updates

Open **Settings → Check for Updates** in Sion Keys. When a newer version is available, the app asks before installing it and verifies the installer’s updater signature. You can also download installers from [GitHub Releases](https://github.com/Stefan7kk/sion-keys-releases/releases).

## Get help

[Open a support issue](https://github.com/Stefan7kk/sion-keys-releases/issues) with your app version and a short description of what happened.
