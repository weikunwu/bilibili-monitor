"""Smoke test: composite a known VAP animation onto a synthetic base video.

Run from repo root:
    python3 -m scripts.test_vap_composite

Output files in /tmp/vap_test/ — open in QuickTime to inspect.
"""

import asyncio
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import effect_catalog, vap_composite


OUT_DIR = "/tmp/vap_test"
BASE_DURATION = 40  # seconds
TRIGGER_OFFSETS = [5.0, 18.0]  # two triggers in one clip


async def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    base_path = os.path.join(OUT_DIR, "base.mp4")

    # 1. Build a synthetic 480p base video (dark gray with a ticking timestamp
    #    overlay so you can tell where in the timeline each trigger lands).
    print("=> generating synthetic base clip…")
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", f"color=c=0x202020:s=854x480:d={BASE_DURATION}",
        "-vf", "drawtext=text='%{pts\\:hms}':fontsize=48:fontcolor=white:x=20:y=20",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        base_path,
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 2. Fetch the gift catalog.
    print("=> fetching effect catalog…")
    n = await effect_catalog.refresh()
    print(f"   loaded {n} gifts")

    # 3. Pick test gifts (鲨皇陛下, 浪漫城堡).
    gift_ids = [35560, 32132]
    triggers = []
    for gid, offset in zip(gift_ids, TRIGGER_OFFSETS):
        urls = effect_catalog.get_by_gift(gid)
        if not urls:
            print(f"   no VAP for gift {gid}, skipping")
            continue
        print(f"=> downloading VAP for gift {gid}: {urls[0][-40:]}")
        fetched = await vap_composite.fetch_vap(urls[0], urls[1])
        if not fetched:
            print(f"   download failed for {gid}")
            continue
        mp4_path, meta = fetched
        info = meta.get("info", {})
        print(f"   w×h={info.get('w')}×{info.get('h')} fps={info.get('fps')} "
              f"rgbFrame={info.get('rgbFrame')} aFrame={info.get('aFrame')}")
        triggers.append(vap_composite.VapTrigger(
            offset_sec=offset, mp4_path=mp4_path, meta=meta,
        ))

    if not triggers:
        print("no triggers → abort")
        return

    # 4. Composite both layouts.
    for layout in ("fullscreen", "native"):
        out = os.path.join(OUT_DIR, f"composited_{layout}.mp4")
        print(f"=> compositing ({layout}) → {out}")
        ok = await vap_composite.composite(base_path, triggers, out, layout=layout)
        if ok:
            sz = os.path.getsize(out) / 1024
            print(f"   ✓ {sz:.0f}KB")
        else:
            print("   ✗ failed")

    print("\nOpen these to inspect:")
    print(f"  {OUT_DIR}/composited_fullscreen.mp4")
    print(f"  {OUT_DIR}/composited_native.mp4")


if __name__ == "__main__":
    asyncio.run(main())
