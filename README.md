# Bisonstechs POS Desktop

Standalone Electron app. **Separate folder** from `accounting-web-app` — same layout as the other projects:

```text
Documents/
  accounting-web-app/        Next.js web app (unchanged)
  accounting-desktop-app/   this Electron desktop app
  account_backend/
  accounting_website/
  accounting-flutter-app/
```

This project does **not** live inside the web app. Login is a native screen here; after sign-in it opens the existing POS UI from the running web app / hosted URL.

## Run

Terminal 1 — web POS (existing project, do not change it):

```bash
cd /Users/glplanet/Documents/accounting-web-app
npm run dev
```

Terminal 2 — desktop app:

```bash
cd /Users/glplanet/Documents/accounting-desktop-app
cp .env.example .env   # first time only
npm install
npm run dev
```

Flow: **Login → POS** (direct password login, no OTP).

`.env`:

```env
ELECTRON_APP_URL=http://127.0.0.1:3000
ELECTRON_API_URL=http://127.0.0.1:5000
```

## Build

```bash
cd /Users/glplanet/Documents/accounting-desktop-app
npm run build:mac          # local macOS (DMG + zip)
npm run build:mac:arm64    # Apple Silicon artifact (CI)
npm run build:mac:x64      # Intel Mac artifact (CI)
npm run build:win          # Windows x64 NSIS — run on Windows (or use GitHub Actions)
npm run build:linux
```

Installers go to `dist-electron/`.

**CI / releases:** see [docs/RELEASE.md](docs/RELEASE.md). Windows installers are built on `windows-latest`; do not rely on cross-building NSIS on Apple Silicon Macs.

## Cursor

This folder is not inside `accounting-web-app`. Add it to Cursor with **File → Add Folder to Workspace…** and pick `accounting-desktop-app`.
