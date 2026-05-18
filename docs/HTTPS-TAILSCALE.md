# HTTPS via Tailscale cert

**English** | [繁體中文](HTTPS-TAILSCALE.zh-TW.md)

The PWA requires HTTPS or `localhost` for the browser microphone API. Localhost
works out of the box; to use the PWA from a phone or another machine on your
LAN, you need a trusted HTTPS certificate for the whisper-wrap host. Tailscale
issues Let's Encrypt certs for your tailnet machines automatically, which is
the easiest path for a single-Mac deployment.

This doc assumes you already have whisper-wrap working on `http://localhost:8000`.

## One-time Tailscale Admin Console setup

1. Visit <https://login.tailscale.com/admin/dns>.
2. **MagicDNS** — confirm it's enabled. Your machines will have hostnames like
   `mac-mini.tailXXXXX.ts.net` (the `tailXXXXX` part is your tailnet name).
3. Scroll to **HTTPS Certificates** → click **Enable**. This authorises
   Tailscale to act as a Let's Encrypt ACME proxy for your tailnet.

You only need to do this once per tailnet.

## Get a cert on the Mac mini

```bash
# Find the machine's tailnet hostname (look for the *.ts.net entry).
tailscale status | head -3

# Replace mac-mini.tailXXXXX.ts.net with your actual hostname.
sudo tailscale cert mac-mini.tailXXXXX.ts.net
```

This writes two files to the current directory:

- `mac-mini.tailXXXXX.ts.net.crt` — the Let's Encrypt-signed certificate
- `mac-mini.tailXXXXX.ts.net.key` — the private key

The cert is valid for 90 days. Renewal is covered below.

## Run whisper-wrap over HTTPS

```bash
export WHISPER_CERT="$PWD/mac-mini.tailXXXXX.ts.net.crt"
export WHISPER_KEY="$PWD/mac-mini.tailXXXXX.ts.net.key"
make dev-https
```

`make dev-https` runs uvicorn with `--ssl-certfile` / `--ssl-keyfile` pointed
at the env vars. If either env var is unset or points at a missing file the
target fails with a clear message.

Now any machine on your tailnet — including your phone — can open:

```
https://mac-mini.tailXXXXX.ts.net:8000/app/
```

The cert is trusted automatically (all Tailscale clients trust Let's Encrypt
roots). The browser will not show a warning, and `navigator.mediaDevices` will
work since the origin is HTTPS.

## Automatic renewal (launchd, every 60 days)

Save the following as `~/Library/LaunchAgents/com.whisper-wrap.cert-renew.plist`,
replacing the hostname and paths to match your setup:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whisper-wrap.cert-renew</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/tailscale</string>
    <string>cert</string>
    <string>mac-mini.tailXXXXX.ts.net</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR-USERNAME/path/to/whisper-wrap</string>
  <key>StartInterval</key>
  <integer>5184000</integer>  <!-- 60 days in seconds -->
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/whisper-wrap-cert-renew.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/whisper-wrap-cert-renew.err</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.whisper-wrap.cert-renew.plist
```

The agent runs once on load and then every 60 days, re-running `tailscale cert`
in your whisper-wrap directory. The newly-issued cert overwrites the old one
in-place; restart `make dev-https` afterwards (or accept that the next restart
picks up the new cert).

## Troubleshooting

| Symptom | Fix |
| - | - |
| `tailscale cert` says HTTPS is disabled | Re-check the Admin Console step above and wait ~30 seconds for the setting to propagate. |
| Browser shows a cert warning on `https://...ts.net:8000/app/` | Confirm the machine accessing the URL is logged into the same tailnet. Non-tailnet machines won't see the cert as trusted. |
| `make dev-https` errors with "WHISPER_CERT path does not exist" | The cert file was deleted or renamed; re-run `sudo tailscale cert <host>` in the same directory as `WHISPER_CERT` points to. |
| Phone can't reach the Mac mini's tailnet IP | Check `tailscale status` — the phone (Tailscale app) needs to be on and connected. |
| Cert expired (after 90 days) and renewal didn't run | Run `tailscale cert <host>` manually, then check `launchctl list \| grep whisper-wrap` to confirm the agent is loaded. |

## Going back to localhost-only

`make dev` (no `-https` suffix) keeps everything on plain `http://localhost:8000`.
The PWA continues to work from the Mac mini's own browser; it just can't be
reached from phones / other machines until you re-enable HTTPS.
