# Bisonstechs POS — desktop release workflow

## CI builds (unsigned)

On every push/PR to `main` / `master`, [`.github/workflows/build-desktop.yml`](../.github/workflows/build-desktop.yml) runs:

| Job | Runner | Command | Artifact |
|-----|--------|---------|----------|
| Windows x64 | `windows-latest` | `npm run build:win` | `Bisonstechs POS-<version>-win-x64.exe` |
| macOS Apple Silicon | `macos-latest` | `npm run build:mac:arm64` | `Bisonstechs POS-<version>-mac-arm64.dmg` |
| macOS Intel | `macos-latest` | `npm run build:mac:x64` | `Bisonstechs POS-<version>-mac-x64.dmg` |

Installers are uploaded as **GitHub Actions artifacts** (not committed to git).

`CSC_IDENTITY_AUTO_DISCOVERY=false` so CI does not require code-signing certificates. Installers may show OS security prompts until signed/notarized.

### Do not build Windows NSIS on Apple Silicon macOS

`npm run build:win` on macOS can fail with `makensis` spawn error `-86`. Use the Windows runner workflow instead.

## GitHub Release (tag)

1. Bump `version` in `package.json` (e.g. `1.0.1`).
2. Commit and push.
3. Create and push a matching tag: `git tag v1.0.1 && git push origin v1.0.1`.

[`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml) builds all three installers and publishes a **GitHub Release** with attached files.

The tag **must** match `package.json` (without the `v` prefix).

## Optional signing secrets (GitHub → Settings → Secrets)

| Secret | Purpose |
|--------|---------|
| `CSC_LINK` | Base64-encoded `.p12` (Windows and/or macOS signing) |
| `CSC_KEY_PASSWORD` | Password for `CSC_LINK` |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

When secrets are configured, you may set `CSC_IDENTITY_AUTO_DISCOVERY=true` in the release workflow for signed builds. Notarization still requires Apple credentials and `electron-builder` notarize configuration (not enabled in this repo by default).

## Local builds

```bash
npm ci
npm run build:mac        # local Mac (may produce universal or arch-specific per machine)
npm run build:mac:arm64
npm run build:mac:x64
npm run build:win        # use on Windows only (x64 NSIS)
```

Output directory: `dist-electron/`.

## Web app download page (Vercel)

Point the Next.js app at GitHub Releases (recommended — installers are not in git):

```env
NEXT_PUBLIC_POS_DESKTOP_VERSION=1.0.0
NEXT_PUBLIC_POS_DESKTOP_GITHUB_REPO=arshad-dev57/accounting-desktop
```

Or override individual URLs:

```env
NEXT_PUBLIC_DESKTOP_DOWNLOAD_MAC=https://github.com/.../releases/download/v1.0.0/Bisonstechs%20POS-1.0.0-mac-arm64.dmg
NEXT_PUBLIC_DESKTOP_DOWNLOAD_WIN=https://github.com/.../releases/download/v1.0.0/Bisonstechs%20POS-1.0.0-win-x64.exe
NEXT_PUBLIC_DESKTOP_DOWNLOAD_MAC_INTEL=...
```

User-facing page: `https://<app-domain>/download/pos`
