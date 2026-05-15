#!/usr/bin/env python3
"""bench-stream-latency.py — measure WS /listen partial latency end-to-end.

Streams a PCM fixture file (16 kHz mono pcm_s16le) into `WS /listen` at
real-time pace and measures the wall-clock latency between each frame's
submission and the `partial` event whose `end_ms` covers that frame's
audio time. Prints p50 / p95 / mean / count at the end.

Usage:
    .venv/bin/python scripts/bench-stream-latency.py \
        tests/fixtures/streaming/mandarin_10s.pcm \
        --server ws://localhost:12000/listen \
        --duration 30

`--duration` defaults to the fixture's natural length; pass a larger value
to loop the fixture (useful for 30 s baseline captures).

For Task 14.1 / 14.2 of v2-1-whisper-cpp-backend: record `p50_ms` against
the v2 baseline and v2.1 head, confirm v2.1 <= v2 / 3.
"""

from __future__ import annotations

import argparse
import asyncio
import bisect
import json
import statistics
import sys
import time
from pathlib import Path

import websockets

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2  # pcm_s16le


async def stream_and_measure(uri: str, pcm: bytes, total_audio_ms: int) -> dict:
    """Stream `pcm` into `uri` at real-time pace, measure partial latencies.

    Returns a dict with `latencies_ms` (sorted list) plus summary stats.
    """
    chunk_ms = 250  # client frame cadence — matches StreamSession's preferred frame size
    chunk_bytes = (SAMPLE_RATE * chunk_ms // 1000) * BYTES_PER_SAMPLE

    # send_index[i] = (audio_ms_at_END_of_frame_i, wall_time_when_sent)
    send_index: list[tuple[int, float]] = []
    latencies: list[float] = []

    async with websockets.connect(uri) as ws:
        print(f"Connected to {uri}; streaming {total_audio_ms / 1000:.1f}s of audio...")

        async def receiver() -> None:
            async for raw in ws:
                event = json.loads(raw)
                if event.get("type") != "partial":
                    continue
                end_ms = event.get("end_ms")
                if end_ms is None or not send_index:
                    continue
                # Find the send timestamp of the frame whose audio-time end is
                # closest to (and not after) end_ms. bisect on (end_ms, +inf).
                idx = bisect.bisect_right(send_index, (end_ms, float("inf"))) - 1
                if idx < 0:
                    continue
                send_wall = send_index[idx][1]
                latency_ms = (time.monotonic() - send_wall) * 1000.0
                latencies.append(latency_ms)

        async def sender() -> None:
            audio_ms = 0
            t0 = time.monotonic()
            pos = 0
            while audio_ms < total_audio_ms:
                # Loop the fixture if we run past its length (--duration > fixture)
                if pos + chunk_bytes > len(pcm):
                    pos = 0
                frame = pcm[pos : pos + chunk_bytes]
                pos += chunk_bytes
                audio_ms += chunk_ms

                # Pace at real-time: sleep until wall time matches audio time
                target_wall = t0 + (audio_ms / 1000.0)
                drift = target_wall - time.monotonic()
                if drift > 0:
                    await asyncio.sleep(drift)

                send_wall = time.monotonic()
                send_index.append((audio_ms, send_wall))
                await ws.send(frame)

            # Give the server time to emit any in-flight partials
            await asyncio.sleep(2.0)

        send_task = asyncio.create_task(sender())
        recv_task = asyncio.create_task(receiver())
        await send_task
        recv_task.cancel()

    latencies.sort()
    if not latencies:
        return {"count": 0, "latencies_ms": []}

    return {
        "count": len(latencies),
        "p50_ms": statistics.median(latencies),
        "p95_ms": latencies[max(0, int(len(latencies) * 0.95) - 1)],
        "mean_ms": statistics.mean(latencies),
        "min_ms": latencies[0],
        "max_ms": latencies[-1],
        "latencies_ms": latencies,
    }


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("fixture", type=Path, help="PCM file: 16 kHz mono pcm_s16le")
    p.add_argument(
        "--server",
        default="ws://localhost:8000/listen",
        help="WebSocket URL (default: ws://localhost:8000/listen)",
    )
    p.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Total audio seconds to stream (loops fixture if larger). Default = fixture length",
    )
    args = p.parse_args()

    pcm = args.fixture.read_bytes()
    fixture_ms = (len(pcm) // BYTES_PER_SAMPLE) * 1000 // SAMPLE_RATE

    if args.duration is None:
        total_audio_ms = fixture_ms
    else:
        total_audio_ms = int(args.duration * 1000)

    print(f"Fixture: {args.fixture} ({fixture_ms / 1000:.1f}s, {len(pcm)} bytes)")
    print(f"Target stream duration: {total_audio_ms / 1000:.1f}s")

    result = asyncio.run(stream_and_measure(args.server, pcm, total_audio_ms))

    print()
    print("=" * 60)
    print(f"Partial events received: {result['count']}")
    if result["count"] == 0:
        print("No partials received — check server is reachable and BACKEND_FORMAT.")
        sys.exit(1)
    print(f"  p50  (median): {result['p50_ms']:7.1f} ms")
    print(f"  p95          : {result['p95_ms']:7.1f} ms")
    print(f"  mean         : {result['mean_ms']:7.1f} ms")
    print(f"  min / max    : {result['min_ms']:6.1f} / {result['max_ms']:6.1f} ms")
    print("=" * 60)


if __name__ == "__main__":
    main()
