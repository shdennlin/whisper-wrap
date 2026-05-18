# Deployment Guide

End-to-end recipe for running whisper-wrap as a 24/7 service on a Mac
mini (or any Mac left on at home). Covers fresh-machine install,
autostart via launchd, log management, and remote access.

For Linux, replace the launchd section with a systemd unit (sketch at the
end). The rest of the recipe is platform-agnostic.

> **Threat model**: whisper-wrap ships **no auth, no TLS, no rate-limiting**.
> Run it on a trusted LAN or behind Tailscale / a reverse proxy. See the
> security note at the bottom of `docs/INSTALLATION.md`.

---

## 1. Prerequisites (one-time, fresh Mac)

```bash
# Homebrew (skip if already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# System deps
brew install ffmpeg libmagic

# Python package manager
curl -fsSL https://astral.sh/uv/install.sh | sh

# JS bundler (for the PWA)
curl -fsSL https://bun.sh/install | bash
```

Verify in a new shell:

```bash
which uv ffmpeg bun
python3 -c "import magic"   # libmagic check
```

## 2. Clone + first-time setup

```bash
git clone <your-repo-url> whisper-wrap
cd whisper-wrap
make setup
```

`make setup` runs three steps:

1. `uv sync` — installs Python deps (whisper backends, FastAPI, etc.)
2. Downloads the default model (`breeze-asr-25` ≈ 1.5 GB)
3. `bun run build` — emits the PWA bundle to `app/static/app/`

Expect 5-15 minutes depending on download speed. If any step fails, run
them individually to see which one (`make install`, `make download-default-model`, `make build-frontend`).

## 3. Minimum config

Copy and edit the env template:

```bash
cp .env.example .env
$EDITOR .env
```

The three lines that matter:

```env
API_PORT=8000             # change if 8000 is taken
API_HOST=0.0.0.0          # 127.0.0.1 = localhost-only; 0.0.0.0 = LAN-reachable
GEMINI_API_KEY=AIza...    # leave blank if you don't need /ask
```

Everything else has sane defaults.

## 4. Test in foreground

```bash
make dev
```

First start on macOS takes 10-30 s while Core ML compiles the `.mlmodelc`
encoder (one INFO log per second). Subsequent starts are fast.

Open `http://localhost:<API_PORT>/app/` in your browser. Record a short
clip, watch the history panel populate.

Then `Ctrl-C` to stop.

## 5. Autostart via launchd (Mac)

```bash
make install-launchd
```

This:

1. Renders `scripts/com.whisper-wrap.plist.template` with your real
   `WORKDIR`, `HOME`, and `PATH` into
   `~/Library/LaunchAgents/com.whisper-wrap.plist`.
2. Loads it via `launchctl load`. The server starts now AND on every
   login.
3. `KeepAlive` restarts on crash but not on intentional `launchctl unload`.

Verify it's running:

```bash
make launchd-status
# Output like:
# 12345  0  com.whisper-wrap

curl http://localhost:8000/status | jq
```

Tail logs:

```bash
make launchd-logs
# Streams ~/Library/Logs/whisper-wrap/stdout.log + stderr.log
```

Stop / remove:

```bash
make uninstall-launchd
```

This unloads the agent and removes the plist; log files in
`~/Library/Logs/whisper-wrap/` are kept.

### Common launchd gotchas

| Symptom | Likely cause | Fix |
| - | - | - |
| `make launchd-status` shows no entry after install | The plist was rejected (XML error / bad path) | `plutil ~/Library/LaunchAgents/com.whisper-wrap.plist` to validate |
| Process keeps restarting fast | Startup crash in `make run` (missing model, bad `.env`) | `tail -F ~/Library/Logs/whisper-wrap/stderr.log` |
| Updated `.env` not picked up | launchd snapshots env at load time | `make uninstall-launchd && make install-launchd` |
| Want to bounce after code change | Re-load to pick up the new tree | `make uninstall-launchd && make install-launchd` |

## 6. Remote access (optional)

### Same LAN

`API_HOST=0.0.0.0` + access via `http://<mac-mini-ip>:<API_PORT>/app/` is
the simplest path. iPhone Shortcut + open-webui can hit the same URL.

### Anywhere (Tailscale + HTTPS)

PWAs require HTTPS for service workers + microphone outside `localhost`.
See `docs/HTTPS-TAILSCALE.md` for the full recipe. Short version:

```bash
sudo tailscale cert <hostname>.<tailnet>.ts.net   # one-time per Mac
export WHISPER_CERT="$PWD/<hostname>.<tailnet>.ts.net.crt"
export WHISPER_KEY="$PWD/<hostname>.<tailnet>.ts.net.key"
make dev-https
```

For autostart over HTTPS via launchd, change `ProgramArguments` in the
plist to `make dev-https` and add `WHISPER_CERT` / `WHISPER_KEY` to the
`EnvironmentVariables` dict.

## 7. iPhone Shortcut integration

The auto-session-logger means **every** call to `/transcribe` and `/ask`
lands in PWA history by default. Build the Shortcut with the recipe in
the main README's *iOS Shortcuts Integration* section. URL is just
`http://<mac>:<port>` (or `https://<hostname>.<tailnet>.ts.net:<port>`
if you set up Tailscale HTTPS).

To opt-out for a specific Shortcut call (e.g. you want `/transcribe`
without logging): append `?log=false` to the URL.

## 8. Updating

```bash
git pull
make install            # re-sync Python deps if pyproject.toml changed
make build-frontend     # rebuild PWA if frontend/ changed
make uninstall-launchd  # bounce the service to pick up the new tree
make install-launchd
```

## 9. Linux equivalent (systemd, sketch)

`/etc/systemd/system/whisper-wrap.service`:

```ini
[Unit]
Description=whisper-wrap transcription service
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/whisper-wrap
Environment=PATH=/home/youruser/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/make run
Restart=on-failure
RestartSec=30
StandardOutput=append:/var/log/whisper-wrap/stdout.log
StandardError=append:/var/log/whisper-wrap/stderr.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/log/whisper-wrap
sudo chown youruser /var/log/whisper-wrap
sudo systemctl daemon-reload
sudo systemctl enable --now whisper-wrap
sudo systemctl status whisper-wrap
journalctl -u whisper-wrap -f
```

## 10. Uninstall

```bash
# Stop autostart
make uninstall-launchd

# Remove logs (optional)
rm -rf ~/Library/Logs/whisper-wrap

# Remove the project + models (CAREFUL — deletes the SQLite history too)
cd ..
rm -rf whisper-wrap
```
