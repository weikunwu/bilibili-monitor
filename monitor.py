"""B站直播间全事件监控系统 - 入口"""

import argparse
import asyncio

from server.app import main

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="B站直播间监控")
    parser.add_argument("--rooms", type=str, default="1920456329,32365569", help="直播间房间号，逗号分隔")
    parser.add_argument("--port", type=int, default=8080, help="Web 服务端口 (默认 8080)")
    args = parser.parse_args()

    room_ids = [int(r.strip()) for r in args.rooms.split(",") if r.strip()]
    asyncio.run(main(room_ids, args.port))
