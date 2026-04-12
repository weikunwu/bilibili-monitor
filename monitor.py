"""B站直播间全事件监控系统 - 入口"""

import argparse
import asyncio

from server.app import main

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="B站直播间监控")
    parser.add_argument("--port", type=int, default=8080, help="Web 服务端口 (默认 8080)")
    args = parser.parse_args()

    asyncio.run(main(args.port))
