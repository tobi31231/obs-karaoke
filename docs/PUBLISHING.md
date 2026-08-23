# Publishing

## Release layout

Users download only `OBS-Karaoke-Setup.exe`. The installer downloads these assets from the same GitHub Release:

- `obs-karaoke-app-core-win-x64.zip`
- `obs-karaoke-turbo-model.zip`
- `obs-karaoke-cuda-runtime-win-x64.zip`
- `release-manifest.json`

All files are verified with SHA-256 before extraction. The installed application works offline.

## Before the first public release

1. Decide the application license and add a root `LICENSE` file.
2. Confirm that `installer/Program.cs` points to `tobi31231/obs-karaoke`.
3. Rebuild the self-contained installer.
4. Run `scripts/build-release-assets.ps1`.
5. Run `OBS-Karaoke-Setup.exe --verify-assets` from the release directory.
6. Test installation on a clean Windows 10 or Windows 11 x64 machine.
7. Confirm that no audio, lyrics, analysis JSON, caches, or local paths are tracked by Git.
8. Code-sign the installer and launcher when a signing certificate is available.

## GitHub Release

Create a prerelease tag such as `v0.1.0-alpha`. Upload every file from the matching release directory.
Share the installer link with users; the other assets are installer payloads.

Do not commit models, Python, CUDA, Node binaries, build output, or release ZIP files to the Git repository.
