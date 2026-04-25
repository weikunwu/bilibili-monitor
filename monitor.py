"""B站直播间全事件监控系统 - 入口"""

import argparse
import asyncio

# 本地开发从 .env 加载环境变量；生产（Fly）用 secrets，.env 不存在直接跳过。
# .env.local 是本地特化，加载顺序在 .env 之后并 override —— 用来覆盖 DATA_DIR 之类生产专用值。
try:
    from dotenv import load_dotenv
    load_dotenv()
    load_dotenv(".env.local", override=True)
except ImportError:
    pass

from server.app import main

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="B站直播间监控")
    parser.add_argument("--port", type=int, default=8080, help="Web 服务端口 (默认 8080)")
    parser.add_argument("--no-listen", action="store_true", help="不启动每房间事件监听（本地只跑服务器）")
    args = parser.parse_args()

    asyncio.run(main(args.port, listen=not args.no_listen))
