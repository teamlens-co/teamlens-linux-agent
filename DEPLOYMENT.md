# Desktop Agent - Development & Deployment

## Local Development

```bash
# Clone repository
git clone https://github.com/your-org/teamlens-agent.git
cd teamlens-agent

# Install dependencies
npm install

# Run in dev mode
npm run dev

# Build for production
npm run build
```

## Build Platforms

The agent builds on multiple platforms:
- **Linux**: .AppImage
- **Windows**: .msi
- **macOS**: .dmg

## GitHub Actions

### Automatic Builds

Every push to main triggers builds on:
- Ubuntu (Linux)
- Windows
- macOS

Built artifacts are:
1. Uploaded to GitHub Actions (temporary)
2. Released to GitHub Releases (permanent)

### Download Latest Release

Users can download from: https://github.com/your-org/teamlens-agent/releases

## Distribution

### For Users

1. Direct download from GitHub Releases
2. Auto-update can be configured in Tauri config
3. Or distribute through app stores

### Release Notes

Add release notes when pushing to main via GitHub Releases workflow.

## Environment Variables (if needed)

Create `.env` in `src-tauri/` for build-time configuration:

```
VITE_API_URL=https://api.your-domain.com
```

## Troubleshooting

### Build fails on Linux
```bash
sudo apt-get install libwebkit2gtk-4.0-dev build-essential curl wget file libssl-dev libgtk-3-dev
```

### Build fails on macOS
```bash
# May need Xcode Command Line Tools
xcode-select --install
```

### Build fails on Windows
Ensure Visual Studio build tools are installed

## Version Management

Edit `src-tauri/tauri.conf.json` to update version:

```json
{
  "build": {
    "devPath": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "package": {
    "version": "0.1.0"  ← Update this
  }
}
```
