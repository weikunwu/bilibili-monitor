"""End-to-end smoke test against a LIVE room.

Starts a recorder against room 1790375205 (单循小猫), buffers for ~15s,
then fires 2 synthetic triggers (鲨皇陛下, 浪漫城堡) 10s apart in the
same pending clip window. Produces:
  /app/data/clips/1790375205/<ts>_test_x2.mp4
  /app/data/clips/1790375205/<ts>_test_x2_fullscreen.mp4
  /app/data/clips/1790375205/<ts>_test_x2_native.mp4

Run on prod:
    ~/.fly/bin/flyctl ssh console -a bilibili-monitor \
        -C "cd /app && python3 -m scripts.test_vap_live"
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import effect_catalog, recorder


ROOM_ID = 1790375205
BUFFER_SECONDS = 15
TRIGGERS = [
    # (gift_id, offset_from_first_trigger_sec, label)
    (35560, 0.0, "shahuang"),   # 鲨皇陛下
    (32132, 10.0, "castle"),    # 浪漫城堡
]


async def main():
    # 1. Warm the catalog so request_clip can resolve VAP URLs.
    print("=> fetching effect catalog…")
    n = await effect_catalog.refresh()
    print(f"   {n} gifts in catalog")

    # 2. Start the HLS recorder for the target room (no cookies — works for
    #    public, non-auth-gated streams).
    print(f"=> starting recorder for room {ROOM_ID}…")
    session = await recorder.start_for(ROOM_ID, cookies={})

    # 3. Buffer a few segments so there's pre-trigger content.
    print(f"=> buffering {BUFFER_SECONDS}s of HLS…")
    for i in range(BUFFER_SECONDS):
        await asyncio.sleep(1)
        print(f"   segs={len(session._segments)} init={'Y' if session._init_segment else 'N'}", end="\r")
    print()

    if not session._segments:
        print("!! no segments pulled — room may not be live. Aborting.")
        await recorder.stop_for(ROOM_ID)
        return

    # 4. Fire triggers spread across the clip window. POST_SEC=30 so both land
    #    in the same pending clip (second extends close_at).
    print("=> firing triggers…")
    for gift_id, offset, label in TRIGGERS:
        if offset > 0:
            await asyncio.sleep(offset)
        print(f"   trigger gift={gift_id} label={label}")
        session.request_clip(gift_id=gift_id, effect_id=0, label=f"test_{label}")

    # 5. Grab the finalize task and await it. _finalize_clip does: wait
    #    close_at, remux base (~few seconds), then 2× libx264 composite
    #    (can be 30-60s each on the 256MB VM). Takes 1-3 min total.
    finalize_task = session._pending_clip.task if session._pending_clip else None
    if finalize_task:
        print("=> awaiting finalize task (up to 5 min)…")
        try:
            await asyncio.wait_for(finalize_task, timeout=300)
        except asyncio.TimeoutError:
            print("   !! timed out, partial output possible")

    # 6. Stop recorder + list output.
    await recorder.stop_for(ROOM_ID)
    out_dir = f"/app/data/clips/{ROOM_ID}"
    if os.path.isdir(out_dir):
        print(f"\n=> output in {out_dir}:")
        for f in sorted(os.listdir(out_dir)):
            sz = os.path.getsize(os.path.join(out_dir, f)) / 1024
            print(f"   {sz:>8.0f}KB  {f}")
    else:
        print("no output dir")


if __name__ == "__main__":
    asyncio.run(main())
