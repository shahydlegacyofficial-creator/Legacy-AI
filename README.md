<p align="center"><img src="legacy/public/legacy_studios_logo.png" width="128" alt="Legacy AI logo"></p>

# Legacy AI

Legacy AI is a voice and text assistant for Windows. It combines Claude with
local Kokoro speech, PC tools, research, reminders, connected accounts and a
browser interface.

**Current public version · 3.24.0**

## Install on Windows

Open this repository's **Releases** page and download
`Legacy-AI-3.24.0-Windows-x64-Setup.exe`. Run Setup, then open **Legacy AI**
from Start. The installer bundles Node.js, the application packages,
Kokoro's default voice model, and camera models.

Use a 64-bit Windows 10 or Windows 11 PC. The current installer is unsigned.
Internet access and an Anthropic API key are required for Claude.
Deepgram adds microphone transcription. API providers may charge for usage.

The first-run screen accepts your own credentials or an existing `.env` file.
Use **Configure Connections** from Start to change them later. Restart the
assistant after saving.

To upgrade an existing installation, close Legacy AI and run the new installer
using the same installation folder. Your local credentials, configuration and
records are retained.

## Features

- Voice and text conversations with Claude, with local Kokoro speech.
- PC application controls, browser automation, file tools and Obsidian notes.
- Research, task lists, reminders, documents and specialist agents.
- Optional Telegram alerts and remote commands, Gmail, social media, and PayPal payment checks.
- Android notifications through Legacy Link over a private Tailscale connection, including selected banking alerts.
- A local settings interface, account diagnostics and approval prompts for consequential actions.

Each integration needs your own account and credentials. LinkedIn, Instagram
and TikTok have separate authorization shortcuts in Start. PayPal uses
Transaction Search. Add your own workspace folder in `legacy/config.json`
to enable workspace tools.

Banking alerts use the personal build of
[Legacy Link](https://github.com/shahydlegacyofficial-creator/legacy-Link).
Connect Tailscale on the PC and phone, set `LEGACY_PHONE_LINK=1` in
Configure Connections, restart Legacy AI, then pair through **Settings → Phone link**.
Select the apps to forward in Legacy Link.

## Run from source

Install Node.js 24 LTS, then open a terminal in this repository.

```powershell
cd legacy
npm ci
npm run desktop
```

The first-run page opens in your browser. Use `npm run configure` to edit
connections. The app opens at `http://127.0.0.1:3000`. Close the console to stop it.
Kokoro downloads its model on the first source run.

Credentials for desktop mode are stored in
`%LOCALAPPDATA%\Legacy AI\.env`. Settings are in `legacy/config.json`
and records are in `legacy/data`. See the
[setup guide](legacy/desktop/Setup%20Guide.txt) for individual integrations.

## Build the Windows installer

Use Windows, PowerShell, and Inno Setup 6. Keep its `ISCC.exe` available
at a standard installation path or pass `-Compiler`.

```powershell
.\installer\Build.ps1
.\installer\Package-Source.ps1
```

The build downloads and verifies a private Node.js runtime, installs the
locked dependencies, checks Kokoro, bundles camera models, and compiles
the installer. Outputs are written into `release`. A build needs Internet
access but needs no service API keys.

The application version in `legacy/package.json` drives the installer filename
and Windows version. Update the package lock and release documentation when
changing it.

## Publish to GitHub

The source package contains the repository files. Extract it and upload its
contents into a new **Legacy-AI** repository on your GitHub account.
Keep the Windows installer on the repository's **Releases** page.

Create a release with the tag `v3.24.0` and attach the installer, source ZIP
and matching `.sha256` files from `release`. Use
[RELEASE_NOTES.md](RELEASE_NOTES.md) for the release description.

The included GitHub Actions workflow can also build and attach these files to
a draft release when a `v*` tag is pushed. It also supports a manual build
from the Actions tab.

## License and privacy

The original code is [MIT licensed](LICENSE). The
[Legacy AI logo rights are reserved](ASSET_LICENSE.md).
[Third-party software keeps its upstream licenses](THIRD_PARTY_NOTICES.md).

Read [PRIVACY.md](PRIVACY.md) for local storage and provider data flows, and
[SECURITY.md](SECURITY.md) for vulnerability reporting.
