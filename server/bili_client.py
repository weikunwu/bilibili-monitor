"""B站直播间 WebSocket 客户端"""

import asyncio
import json
import time

import aiohttp

from .config import (
    HEADERS, DANMU_CONF_API, DANMU_INFO_API, ROOM_INFO_API, NAV_API,
    SEND_GIFT_API, SEND_MSG_API, WS_OP_AUTH, WS_OP_HEARTBEAT, log,
)
from .protocol import make_packet, parse_packets, handle_message
from .bili_api import get_wbi_key, wbi_sign
from .db import save_event, get_command


class BiliLiveClient:
    def __init__(self, room_id: int, on_event, cookies: dict = None):
        self.room_id = room_id
        self.real_room_id = room_id
        self.on_event = on_event
        self.cookies = cookies or {}
        self.uid = int(self.cookies.get("DedeUserID", 0))
        self.bot_name = ""
        self.ruid = 0
        self.room_title = ""
        self.streamer_name = ""
        self.streamer_avatar = ""
        self.live_status = 0
        self.popularity = 0
        self.followers = 0
        self.guard_count = 0
        self.area_name = ""
        self.parent_area_name = ""
        self.announcement = ""
        self.buvid = ""
        self._running = False
        self._ws = None
        self._reconnect = False
        self._info_fetched = False

    def _make_cookie_header(self) -> dict:
        headers = dict(HEADERS)
        if self.cookies:
            cookie_str = "; ".join(f"{k}={v}" for k, v in self.cookies.items() if k != "refresh_token")
            headers["Cookie"] = cookie_str
        return headers

    async def get_buvid(self):
        headers = self._make_cookie_header()
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get("https://api.bilibili.com/x/frontend/finger/spi") as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    self.buvid = data["data"].get("b_3", "")
                    log.info(f"获取 buvid: {self.buvid[:16]}...")
            if self.cookies.get("SESSDATA"):
                async with session.get(NAV_API) as resp:
                    data = await resp.json(content_type=None)
                    if data.get("code") == 0:
                        self.uid = data["data"].get("mid", 0)
                        self.bot_name = data["data"].get("uname", "")
                        log.info(f"已登录用户: {self.bot_name} (UID: {self.uid})")

    async def get_room_info(self):
        async with aiohttp.ClientSession(headers=self._make_cookie_header()) as session:
            async with session.get(ROOM_INFO_API, params={"room_id": self.room_id}) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    info = data["data"]
                    self.real_room_id = info.get("room_id", self.room_id)
                    self.ruid = info.get("uid", 0)
                    self.room_title = info.get("title", "")
                    self.live_status = info.get("live_status", 0)
                    self.area_name = info.get("area_name", "")
                    self.parent_area_name = info.get("parent_area_name", "")
                    self.announcement = info.get("description", "")
                    log.info(f"房间信息: {self.room_title} (真实ID: {self.real_room_id}, 主播UID: {self.ruid})")
                    if self.ruid:
                        try:
                            async with session.get(
                                "https://api.live.bilibili.com/live_user/v1/Master/info",
                                params={"uid": self.ruid}
                            ) as name_resp:
                                name_data = await name_resp.json(content_type=None)
                                if name_data.get("code") == 0:
                                    master = name_data["data"]
                                    info_data = master.get("info", {})
                                    self.streamer_name = info_data.get("uname", "")
                                    self.streamer_avatar = info_data.get("face", "")
                                    self.followers = name_data["data"].get("follower_num", 0)
                                    self.guard_count = name_data["data"].get("guard", {}).get("num", 0) if name_data["data"].get("guard") else 0
                                    log.info(f"主播: {self.streamer_name} 粉丝: {self.followers} 舰长: {self.guard_count}")
                        except Exception:
                            pass
                    self._info_fetched = True
                    return info
        return {}

    async def ensure_info(self):
        """Fetch room info if not yet fetched."""
        if not self._info_fetched:
            await self.get_room_info()

    async def get_danmu_info(self):
        headers = self._make_cookie_header()
        if self.cookies.get("SESSDATA"):
            wbi_key = await get_wbi_key(headers)
            if wbi_key:
                params = wbi_sign({"id": self.real_room_id, "type": 0}, wbi_key)
                async with aiohttp.ClientSession(headers=headers) as session:
                    async with session.get(DANMU_INFO_API, params=params) as resp:
                        data = await resp.json(content_type=None)
                        if data.get("code") == 0:
                            d = data["data"]
                            log.info("使用 getDanmuInfo (已登录)")
                            return {"token": d["token"], "host_list": d.get("host_list", [])}
                        else:
                            log.warning(f"getDanmuInfo 失败 (code={data.get('code')}), 回退到 getConf")
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(
                DANMU_CONF_API, params={"room_id": self.real_room_id, "platform": "pc", "player": "web"},
            ) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    d = data["data"]
                    return {"token": d["token"], "host_list": d.get("host_server_list", [])}
        return None

    def request_reconnect(self):
        self._reconnect = True
        if self._ws and not self._ws.closed:
            asyncio.create_task(self._ws.close())

    async def run(self):
        self._running = True
        while self._running:
            self._reconnect = False
            try:
                await self._connect_and_listen()
            except Exception as e:
                if not self._reconnect:
                    log.error(f"连接断开: {e}")
            if self._running:
                wait = 1 if self._reconnect else 5
                log.info(f"{wait} 秒后重连...")
                await asyncio.sleep(wait)

    async def _connect_and_listen(self):
        await self.get_buvid()
        await self.get_room_info()
        danmu_info = await self.get_danmu_info()
        if not danmu_info:
            raise Exception("获取弹幕服务器信息失败")

        token = danmu_info["token"]
        host_list = danmu_info.get("host_list", [])
        if host_list:
            host = host_list[0]["host"]
            port = host_list[0]["wss_port"]
            ws_url = f"wss://{host}:{port}/sub"
        else:
            ws_url = "wss://broadcastlv.chat.bilibili.com/sub"

        log.info(f"连接弹幕服务器: {ws_url}")

        async with aiohttp.ClientSession(headers=self._make_cookie_header()) as session:
            async with session.ws_connect(ws_url) as ws:
                self._ws = ws
                auth_body = json.dumps({
                    "uid": self.uid, "roomid": self.real_room_id,
                    "protover": 3, "buvid": self.buvid,
                    "platform": "web", "type": 2, "key": token,
                }).encode()
                await ws.send_bytes(make_packet(auth_body, WS_OP_AUTH))
                log.info("已发送认证包")

                async def heartbeat():
                    while self._running:
                        await asyncio.sleep(30)
                        try:
                            await ws.send_bytes(make_packet(b"", WS_OP_HEARTBEAT))
                        except Exception:
                            break

                hb_task = asyncio.create_task(heartbeat())
                try:
                    async for raw_msg in ws:
                        if raw_msg.type == aiohttp.WSMsgType.BINARY:
                            packets = parse_packets(raw_msg.data)
                            for pkt in packets:
                                cmd = pkt.get("cmd", "")
                                if cmd == "_AUTH_REPLY":
                                    log.info("认证成功，开始接收消息")
                                    continue
                                if cmd == "_HEARTBEAT_REPLY":
                                    self.popularity = pkt.get("popularity", 0)
                                    continue
                                base_cmd = cmd.split(":")[0]
                                if base_cmd == "LIVE":
                                    self.live_status = 1
                                    continue
                                if base_cmd == "PREPARING":
                                    self.live_status = 0
                                    continue
                                event = handle_message(pkt)
                                if event:
                                    event["room_id"] = self.real_room_id
                                    save_event(event)
                                    await self.on_event(event)
                                    # 指令系统
                                    if event.get("event_type") == "danmaku":
                                        uid = event.get("user_id")
                                        uname = event.get("user_name", "")
                                        content = (event.get("content") or "").strip()
                                        # 主播指令
                                        if uid == self.ruid:
                                            cmd_cfg = get_command(self.real_room_id, "auto_gift")
                                            if cmd_cfg and cmd_cfg["enabled"] and content == cmd_cfg["config"]["trigger"]:
                                                asyncio.create_task(self.send_gift(cmd_cfg["config"]))
                                        # 盲盒查询指令
                                        period_map = {"今日盲盒": "today", "昨日盲盒": "yesterday", "本月盲盒": "this_month", "上月盲盒": "last_month"}
                                        if content in period_map:
                                            asyncio.create_task(self.handle_blind_box_query(uname, period_map[content]))
                        elif raw_msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                finally:
                    hb_task.cancel()

    async def send_gift(self, config: dict):
        if not self.cookies.get("SESSDATA") or not self.ruid:
            log.warning("未绑定机器人或无主播信息，无法自动送礼")
            return
        gift_id = config.get("gift_id", 31036)
        gift_num = config.get("gift_num", 1)
        gift_price = config.get("gift_price", 100)
        csrf = self.cookies.get("bili_jct", "")
        payload = {
            "uid": self.uid, "gift_id": gift_id, "ruid": self.ruid,
            "gift_num": gift_num, "coin_type": "gold", "platform": "pc",
            "biz_code": "Live", "biz_id": self.real_room_id,
            "rnd": int(time.time()), "price": gift_price,
            "csrf_token": csrf, "csrf": csrf,
        }
        try:
            async with aiohttp.ClientSession(headers=self._make_cookie_header()) as session:
                async with session.post(SEND_GIFT_API, data=payload) as resp:
                    text = await resp.text()
                    log.info(f"[自动送礼] HTTP {resp.status}, body: {text[:500]}")
                    try:
                        data = json.loads(text)
                    except Exception:
                        log.warning(f"[自动送礼] 非JSON响应: {text[:500]}")
                        return
                    if data.get("code") == 0:
                        log.info(f"[自动送礼] 房间 {self.room_id} 送出礼物 gift_id={gift_id} x{gift_num}")
                    else:
                        log.warning(f"[自动送礼] 失败: {data}")
        except Exception as e:
            log.warning(f"[自动送礼] 异常: {e}")

    async def send_danmaku(self, msg: str):
        if not self.cookies.get("SESSDATA"):
            return
        csrf = self.cookies.get("bili_jct", "")
        # B站弹幕限制20字，超长分段发送
        chunks = [msg[i:i+20] for i in range(0, len(msg), 20)]
        try:
            async with aiohttp.ClientSession(headers=self._make_cookie_header()) as session:
                for chunk in chunks:
                    payload = {
                        "bubble": 0, "msg": chunk, "color": 16777215,
                        "mode": 1, "fontsize": 25, "rnd": int(time.time()),
                        "roomid": self.real_room_id,
                        "csrf": csrf, "csrf_token": csrf,
                    }
                    async with session.post(SEND_MSG_API, data=payload) as resp:
                        data = await resp.json(content_type=None)
                        if data.get("code") != 0:
                            log.warning(f"[发弹幕] 失败: {data}")
                            break
                    if len(chunks) > 1:
                        await asyncio.sleep(1)
        except Exception as e:
            log.warning(f"[发弹幕] 异常: {e}")

    async def handle_blind_box_query(self, user_name: str, period: str = "today"):
        """Query blind box stats and reply via danmaku."""
        from .routes.events import _beijing_time_range
        import sqlite3
        from .config import DB_PATH

        utc_start, utc_end, _ = _beijing_time_range(period)
        conn = sqlite3.connect(str(DB_PATH))
        rows = conn.execute(
            "SELECT extra_json FROM events WHERE event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ? AND user_name=? AND extra_json LIKE '%blind_name%' AND extra_json NOT LIKE '%\"blind_name\": \"\"%'",
            (self.real_room_id, utc_start, utc_end, user_name),
        ).fetchall()
        conn.close()

        period_label = {"today": "今日", "yesterday": "昨日", "this_month": "本月", "last_month": "上月"}.get(period, "今日")
        if not rows:
            await self.send_danmaku(f"{user_name} {period_label}暂无盲盒记录")
            return

        total_boxes = 0
        total_cost = 0
        total_value = 0
        for r in rows:
            try:
                extra = json.loads(r[0])
            except:
                continue
            num = extra.get("num", 1)
            total_boxes += num
            total_cost += extra.get("blind_price", 0) * num
            total_value += extra.get("price", 0) * num

        profit = total_value - total_cost

        yuan = abs(profit) / 1000
        yuan_str = f"{yuan:.1f}".rstrip('0').rstrip('.')
        result = f"赚{yuan_str}元" if profit >= 0 else f"亏{yuan_str}元"
        msg = f"{user_name} {period_label}盲盒开了{total_boxes}个，{result}"
        await self.send_danmaku(msg)

    def stop(self):
        self._running = False
