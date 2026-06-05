# PWA manual verification checklist

Run after `make build-frontend && make dev` to confirm the shell wires up correctly.

## Golden path (localhost, http)

1. Open `http://localhost:8000/app/` in Chrome or Safari.
2. ✓ The title `whisper-wrap` and a "⚙︎ 設定" button appear in the header.
3. ✓ The connection indicator shows "未連線" (grey dot).
4. ✓ The "對話記錄（0）" empty state appears in the right aside.
5. Click "⏺ 開始錄音". The browser prompts for mic permission. Allow.
6. ✓ Indicator turns green ("已連線"). Speak a sentence.
7. ✓ A grey italic partial line appears below the transcript and updates as you speak.
8. ✓ A black final cue with `mm:ss` timestamp appears once silero-vad closes the utterance.
9. ✓ The history panel shows a new card with the running session (録音中).
10. Click "⏹ 停止".
11. ✓ Indicator returns to grey/idle. The card's "錄音中" is replaced by the duration.
12. ✓ The Actions chip bar shows 5 chips (`直接送`, `加標點`, `整理會議重點`, `翻譯成英文`, `改寫得更專業`).
13. Click `整理會議重點` (requires `GEMINI_API_KEY` set on the backend).
14. ✓ The answer pane renders Gemini's response. The history card's expand-collapse now also shows the action run.

## SRT export

1. On a card, click "匯出 SRT".
2. ✓ A `.srt` file downloads, filename starts with `whisper-wrap-YYYY-MM-DD_HHMMSS`.
3. ✓ The body is valid SRT (comma `,` ms separator, blank line between cues).

## Offline shell

1. With the PWA loaded, stop the whisper-wrap backend (`Ctrl-C` on `make dev`).
2. Reload `http://localhost:8000/app/` — should fail (server is down), so instead just keep the tab open and try to record.
3. ✓ Pressing Record produces a red indicator and a toast, but the shell + history list stay visible.
4. ✓ Existing history cards still expand, copy, export.

## Insecure-origin banner

1. From a phone on the same LAN, open `http://<mac-mini-LAN-IP>:8000/app/`.
2. ✓ A yellow banner appears at the top mentioning HTTPS / Tailscale.
3. ✓ Pressing Record produces a mic-permission-style error.
4. To make the PWA work from the phone, run `make dev-https` after `tailscale cert ...` (see `docs/HTTPS-TAILSCALE.md`).

## Service worker update

1. Build the PWA once (`make build-frontend`) and load it.
2. Edit `frontend/src/main.ts` (e.g. change the page title), re-build, then reload the tab.
3. ✓ A toast says "新版本已就緒，重新整理頁面以套用。"
4. Reload manually → the new bundle loads.

## Mic-permission denied

1. Click Record. When prompted, deny mic permission.
2. ✓ A banner appears at the top explaining the failure; recording does not start.
3. After granting permission in browser settings, Record works without reloading the page.
