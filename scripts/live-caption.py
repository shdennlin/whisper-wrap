#!/usr/bin/env python3
"""live-caption.py — stream mic audio to WS /listen, print partial / final events.

Usage:
    .venv/bin/python scripts/live-caption.py
    .venv/bin/python scripts/live-caption.py --server ws://localhost:12000/listen
    .venv/bin/python scripts/live-caption.py --device 1     # MacBook Pro Microphone

Run `python -c "import sounddevice as sd; print(sd.query_devices())"` to list
available input devices and their indices.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import queue
import sys
import threading

import sounddevice as sd
import websockets

GRAY = "\033[90m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"
CLEAR = "\r\033[K"


async def main(uri: str, chunk_ms: int, device: int | None) -> None:
    sample_rate = 16_000
    chunk_samples = int(sample_rate * chunk_ms / 1000)
    audio_q: queue.Queue[bytes] = queue.Queue(maxsize=64)
    stop = threading.Event()

    def cb(indata, frames, time_info, status):
        if status:
            print(f"{YELLOW}[mic] {status}{RESET}", file=sys.stderr)
        try:
            audio_q.put_nowait(bytes(indata))
        except queue.Full:
            # Drop oldest if the server can't keep up; the WS layer also has a
            # 30 s buffer + warning, so this is a belt-and-braces.
            try:
                audio_q.get_nowait()
                audio_q.put_nowait(bytes(indata))
            except queue.Empty:
                pass

    print(f"Connecting to {uri}...")
    try:
        async with websockets.connect(uri) as ws:
            print(f"{GREEN}Connected.{RESET}  Speak; "
                  f"{GRAY}partials in gray{RESET}, "
                  f"{GREEN}finals in green{RESET}.")
            print(f"{GRAY}(Ctrl+C to stop){RESET}\n")

            async def receiver():
                try:
                    async for raw in ws:
                        event = json.loads(raw)
                        t = event.get("type")
                        if t == "partial":
                            sys.stdout.write(f"{CLEAR}{GRAY}~ {event['text']}{RESET}")
                            sys.stdout.flush()
                        elif t == "final":
                            sys.stdout.write(f"{CLEAR}{GREEN}= {event['text']}{RESET}\n")
                            sys.stdout.flush()
                        elif t == "warning":
                            print(f"{YELLOW}! {event['message']}{RESET}", file=sys.stderr)
                        elif t == "error":
                            print(f"{RED}× {event['message']}{RESET}", file=sys.stderr)
                            return
                except websockets.exceptions.ConnectionClosed:
                    return

            async def sender():
                loop = asyncio.get_event_loop()
                with sd.RawInputStream(
                    samplerate=sample_rate, channels=1, dtype="int16",
                    blocksize=chunk_samples, callback=cb, device=device,
                ):
                    while not stop.is_set():
                        try:
                            pcm = await loop.run_in_executor(
                                None, lambda: audio_q.get(timeout=0.25)
                            )
                        except queue.Empty:
                            continue
                        try:
                            await ws.send(pcm)
                        except websockets.exceptions.ConnectionClosed:
                            return

            recv_task = asyncio.create_task(receiver())
            send_task = asyncio.create_task(sender())
            done, pending = await asyncio.wait(
                {recv_task, send_task}, return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
    finally:
        stop.set()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--server", default="ws://localhost:8000/listen",
                   help="WebSocket URL (default: ws://localhost:8000/listen)")
    p.add_argument("--chunk-ms", type=int, default=250,
                   help="Frame size in ms (default 250 → 8000 bytes per frame)")
    p.add_argument("--device", type=int, default=None,
                   help="Sounddevice input index; omit for system default")
    args = p.parse_args()
    try:
        asyncio.run(main(args.server, args.chunk_ms, args.device))
    except KeyboardInterrupt:
        print(f"\n{GRAY}stopped{RESET}")
