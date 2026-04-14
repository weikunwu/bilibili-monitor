"""B站直播间 WebSocket 客户端"""

import asyncio
import json
import sqlite3
import time

import aiohttp

from .config import (
    HEADERS, DANMU_CONF_API, DANMU_INFO_API, ROOM_INFO_API,
    MASTER_INFO_API, FINGER_SPI_API, NAV_API, SEND_GIFT_API, SEND_MSG_API,
    WS_OP_AUTH, WS_OP_HEARTBEAT, PERIOD_LABELS, DANMU_PERIOD_MAP, DB_PATH, log,
)
from .protocol import make_packet, parse_packets, handle_message, build_guard_event
from .bili_api import get_wbi_key, wbi_sign, fetch_user_avatar
from . import recorder
from .db import (
    save_event, get_command, get_room_save_danmu, get_room_auto_clip,
    get_nickname, upsert_nickname, delete_nickname,
)
from .time_utils import beijing_time_range


class BiliLiveClient:
    def __init__(self, room_id: int, on_event, cookies: dict = None):
        self.room_id = room_id
        self.real_room_id = room_id
        self.on_event = on_event
        self.cookies = cookies or {}
        self.bot_uid = int(self.cookies.get("DedeUserID", 0))
        self.bot_name = ""
        self.room_title = ""
        self.streamer_uid = 0
        self.streamer_name = ""
        self.streamer_avatar = ""
        self.live_status = 0
        self.popularity = 0
        self.followers = 0

        self.area_name = ""
        self.parent_area_name = ""
        self.announcement = ""
        self.buvid = ""
        self._running = False
        self._ws = None
        self._reconnect = False
        self._info_fetched = False
        # GUARD_BUY and USER_TOAST_MSG arrive as a pair; buffer the first
        # seen for up to GUARD_PAIR_TIMEOUT seconds so they can be merged
        # into a single guard event.
        self._pending_guard: dict[int, dict] = {}  # uid -> {guard_buy?, toast?, ts}
        # Per-user blind-box burst buffer: flush a summary danmu after the
        # user stops opening boxes for BLIND_IDLE_SEC seconds.
        self._blind_bursts: dict[int, dict] = {}  # uid -> {user_name, count, cost, value, task}

    def _make_cookie_header(self) -> dict:
        headers = dict(HEADERS)
        if self.cookies:
            cookie_str = "; ".join(f"{k}={v}" for k, v in self.cookies.items() if k != "refresh_token")
            headers["Cookie"] = cookie_str
        return headers

    async def get_buvid(self):
        headers = self._make_cookie_header()
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(FINGER_SPI_API) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    self.buvid = data["data"].get("b_3", "")
                    log.info(f"获取 buvid: {self.buvid[:16]}...")
            if self.cookies.get("SESSDATA"):
                async with session.get(NAV_API) as resp:
                    data = await resp.json(content_type=None)
                    if data.get("code") == 0:
                        self.bot_uid = data["data"].get("mid", 0)
                        self.bot_name = data["data"].get("uname", "")
                        log.info(f"已登录用户: {self.bot_name} (UID: {self.bot_uid})")

    async def get_room_info(self):
        async with aiohttp.ClientSession(headers=self._make_cookie_header()) as session:
            async with session.get(ROOM_INFO_API, params={"room_id": self.room_id}) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    info = data["data"]
                    self.real_room_id = info.get("room_id", self.room_id)
                    self.streamer_uid = info.get("uid", 0)
                    self.room_title = info.get("title", "")
                    self.live_status = info.get("live_status", 0)
                    self.area_name = info.get("area_name", "")
                    self.parent_area_name = info.get("parent_area_name", "")
                    self.announcement = info.get("description", "")
                    log.info(f"房间信息: {self.room_title} (真实ID: {self.real_room_id}, 主播UID: {self.streamer_uid})")
                    if self.streamer_uid:
                        try:
                            async with session.get(
                                MASTER_INFO_API,
                                params={"uid": self.streamer_uid}
                            ) as name_resp:
                                name_data = await name_resp.json(content_type=None)
                                if name_data.get("code") == 0:
                                    master = name_data["data"]
                                    info_data = master.get("info", {})
                                    self.streamer_name = info_data.get("uname", "")
                                    self.streamer_avatar = info_data.get("face", "")
                                    self.followers = name_data["data"].get("follower_num", 0)
                                    log.info(f"主播: {self.streamer_name} 粉丝: {self.followers}")
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

    # Pair timeout for guard events; after this the half we have is flushed
    # alone (without price/avatar enrichment depending on which half arrived).
    GUARD_PAIR_TIMEOUT = 2.0

    def _absorb_guard_partial(self, partial: dict):
        """Handle a {_partial: guard_buy|user_toast, data} returned by
        handle_message. Either completes a pending pair (return event) or
        stores this half in the buffer (return None)."""
        kind = partial["_partial"]
        data = partial["data"]
        uid = data.get("uid", 0)
        if not uid:
            return None
        pending = self._pending_guard.pop(uid, None)
        if pending:
            guard_buy = data if kind == "guard_buy" else pending.get("guard_buy")
            toast = data if kind == "user_toast" else pending.get("toast")
            return build_guard_event(guard_buy=guard_buy, toast=toast)
        entry = {"ts": time.time()}
        entry["guard_buy" if kind == "guard_buy" else "toast"] = data
        self._pending_guard[uid] = entry
        return None

    async def _flush_pending_guards(self):
        """Emit buffered guard entries whose partner never arrived. A
        guard_buy-only event loses its paid price; a toast-only event
        loses its avatar — both are still useful."""
        while self._running:
            await asyncio.sleep(0.5)
            now = time.time()
            for uid in list(self._pending_guard.keys()):
                entry = self._pending_guard.get(uid)
                if not entry or now - entry["ts"] < self.GUARD_PAIR_TIMEOUT:
                    continue
                self._pending_guard.pop(uid, None)
                event = build_guard_event(
                    guard_buy=entry.get("guard_buy"),
                    toast=entry.get("toast"),
                )
                if not event["extra"].get("avatar"):
                    event["extra"]["avatar"] = await fetch_user_avatar(
                        event.get("user_id", 0), self._make_cookie_header()
                    )
                event["room_id"] = self.real_room_id
                try:
                    save_event(event)
                    await self.on_event(event)
                except Exception as ex:
                    log.warning(f"[guard flush] emit failed: {ex}")

    # Gift or guard events worth ≥ ¥1000 (10000 电池) trigger a clip.
    CLIP_GIFT_THRESHOLD = 10000  # ¥1000 in 电池

    # Blind-box burst broadcast tuning.
    BLIND_IDLE_SEC = 3.0   # flush summary this long after the last blind box
    BLIND_MIN_COUNT = 1    # broadcast even single-box opens

    # For guard events (GUARD_BUY / USER_TOAST_MSG) there's no gift_id — map
    # guard_level → a known "xx一号" gift_id so the catalog can look up VAP.
    # level 1=总督, 2=提督, 3=舰长
    GUARD_VAP_GIFT_IDS = {1: 34639, 2: 34638, 3: 34637}

    def _maybe_clip(self, event: dict):
        if not get_room_auto_clip(self.room_id):
            return
        session = recorder.get_session(self.real_room_id)
        if not session or not session._running:
            return
        if event.get("event_type") not in ("gift", "guard"):
            return
        extra = event.get("extra") or {}
        # Prefer total_coin (gifts) else price*num (guard events don't set total_coin).
        coin = extra.get("total_coin")
        if coin is None:
            coin = (extra.get("price") or 0) * (extra.get("num") or 1)
        if coin < self.CLIP_GIFT_THRESHOLD:
            return
        label = event.get("user_name", "") or event.get("event_type", "")
        gift_id = int(extra.get("gift_id") or 0)
        effect_id = int(extra.get("effect_id") or 0)
        if event.get("event_type") == "guard" and not gift_id:
            gift_id = self.GUARD_VAP_GIFT_IDS.get(extra.get("guard_level") or 0, 0)
        asyncio.create_task(session.request_clip(gift_id, effect_id, label))

    def _maybe_broadcast_blind(self, event: dict):
        """Accumulate a user's blind-box events and emit one summary danmu
        after they stop opening boxes for BLIND_IDLE_SEC seconds. Only runs
        when the `broadcast_blind` command is enabled for this room and the
        bot has cookies (we can't send danmu without)."""
        if event.get("event_type") != "gift":
            return
        extra = event.get("extra") or {}
        if not extra.get("blind_name"):
            return
        if not self.cookies.get("SESSDATA"):
            return
        cmd_cfg = get_command(self.real_room_id, "broadcast_blind")
        if not cmd_cfg or not cmd_cfg["enabled"]:
            return
        uid = event.get("user_id") or 0
        if not uid:
            return
        buf = self._blind_bursts.get(uid)
        if not buf:
            buf = {"user_name": event.get("user_name", ""), "count": 0, "cost": 0, "value": 0, "task": None}
            self._blind_bursts[uid] = buf
        num = extra.get("num") or 1
        buf["user_name"] = event.get("user_name", "") or buf["user_name"]
        buf["count"] += num
        buf["cost"] += (extra.get("blind_price") or 0) * num
        buf["value"] += (extra.get("price") or 0) * num
        # Reset the idle timer: cancel the pending flush (if any) and
        # schedule a new one so bursts keep extending the window.
        if buf["task"] and not buf["task"].done():
            buf["task"].cancel()
        buf["task"] = asyncio.create_task(self._flush_blind_burst(uid))

    async def _flush_blind_burst(self, uid: int):
        try:
            await asyncio.sleep(self.BLIND_IDLE_SEC)
        except asyncio.CancelledError:
            return
        buf = self._blind_bursts.pop(uid, None)
        if not buf or buf["count"] < self.BLIND_MIN_COUNT:
            return
        profit = buf["value"] - buf["cost"]
        yuan = abs(profit) / 10
        s = f"{yuan:.1f}".rstrip('0').rstrip('.')
        verdict = "不亏不赚" if profit == 0 else (f"赚{s}元" if profit > 0 else f"亏{s}元")
        display_name = get_nickname(self.real_room_id, uid) or buf["user_name"] or "有人"
        await self.send_danmu(f"感谢{display_name}的{buf['count']}个盲盒，{verdict}")

    def request_reconnect(self):
        self._reconnect = True
        if self._ws and not self._ws.closed:
            asyncio.create_task(self._ws.close())

    async def run(self):
        self._running = True
        flush_task = asyncio.create_task(self._flush_pending_guards())
        try:
            await self._run_loop()
        finally:
            flush_task.cancel()

    async def _run_loop(self):
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
        # If we connected mid-stream, no LIVE cmd will fire — start recorder now.
        if self.live_status == 1 and get_room_auto_clip(self.room_id):
            asyncio.create_task(recorder.start_for(self.real_room_id, self.cookies))
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
                    "uid": self.bot_uid, "roomid": self.real_room_id,
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
                                    if get_room_auto_clip(self.room_id):
                                        asyncio.create_task(recorder.start_for(self.real_room_id, self.cookies))
                                    continue
                                if base_cmd == "PREPARING":
                                    self.live_status = 0
                                    asyncio.create_task(recorder.stop_for(self.real_room_id))
                                    continue
                                event = handle_message(pkt)
                                # Guard events arrive split across GUARD_BUY +
                                # USER_TOAST_MSG — buffer one half until the
                                # partner arrives, then emit the merged event.
                                if isinstance(event, dict) and event.get("_partial"):
                                    event = self._absorb_guard_partial(event)
                                    if event is None:
                                        continue
                                if event:
                                    if event["event_type"] == "guard" and not event["extra"].get("avatar"):
                                        event["extra"]["avatar"] = await fetch_user_avatar(
                                            event.get("user_id", 0), self._make_cookie_header()
                                        )
                                    event["room_id"] = self.real_room_id
                                    skip_danmu = event["event_type"] == "danmu" and not get_room_save_danmu(self.room_id)
                                    if not skip_danmu:
                                        save_event(event)
                                        await self.on_event(event)
                                    self._maybe_clip(event)
                                    self._maybe_broadcast_blind(event)
                                    # 指令系统
                                    if event.get("event_type") == "danmu":
                                        uid = event.get("user_id")
                                        uname = event.get("user_name", "")
                                        content = (event.get("content") or "").strip()
                                        # 主播指令
                                        if uid == self.streamer_uid:
                                            cmd_cfg = get_command(self.real_room_id, "auto_gift")
                                            if cmd_cfg and cmd_cfg["enabled"] and content == cmd_cfg["config"]["trigger"]:
                                                asyncio.create_task(self.send_gift(cmd_cfg["config"]))
                                        # 设置/清除昵称
                                        if self.bot_uid and uid:
                                            if content == "清除昵称":
                                                asyncio.create_task(self.handle_clear_nickname(uid, uname))
                                            elif content.startswith("叫我"):
                                                asyncio.create_task(self.handle_set_nickname(uid, uname, content[2:].strip()))
                                        # 盲盒查询指令 (skip when no bot bound — we can't reply anyway)
                                        if content in DANMU_PERIOD_MAP and self.bot_uid:
                                            is_streamer = uid == self.streamer_uid
                                            asyncio.create_task(self.handle_blind_box_query(
                                                None if is_streamer else uname,
                                                DANMU_PERIOD_MAP[content],
                                                user_id=None if is_streamer else uid,
                                            ))
                        elif raw_msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                finally:
                    hb_task.cancel()

    async def send_gift(self, config: dict):
        if not self.cookies.get("SESSDATA") or not self.streamer_uid:
            log.warning("未绑定机器人或无主播信息，无法自动送礼")
            return
        gift_id = config.get("gift_id", 31036)
        gift_num = config.get("gift_num", 1)
        gift_price = config.get("gift_price", 100)
        csrf = self.cookies.get("bili_jct", "")
        payload = {
            "uid": self.bot_uid, "gift_id": gift_id, "ruid": self.streamer_uid,
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

    async def send_danmu(self, msg: str):
        if not self.cookies.get("SESSDATA"):
            return
        csrf = self.cookies.get("bili_jct", "")
        # B站弹幕限制40字，超长分段发送
        chunks = [msg[i:i+40] for i in range(0, len(msg), 40)]
        try:
            async with aiohttp.ClientSession(headers=self._make_cookie_header()) as session:
                for chunk in chunks:
                    payload = {
                        "bubble": 0, "msg": chunk, "color": 16777215,
                        "mode": 1, "fontsize": 25, "rnd": int(time.time()),
                        "roomid": self.real_room_id,
                        "csrf": csrf, "csrf_token": csrf,
                    }
                    for attempt in range(3):
                        async with session.post(SEND_MSG_API, data=payload) as resp:
                            data = await resp.json(content_type=None)
                            if data.get("code") == 0:
                                break
                            log.warning(f"[发弹幕] 第{attempt+1}次失败: {data.get('message', data.get('msg', ''))}")
                            await asyncio.sleep(2)
                    if len(chunks) > 1:
                        await asyncio.sleep(2)
        except Exception as e:
            log.warning(f"[发弹幕] 异常: {e}")

    async def handle_set_nickname(self, user_id: int, user_name: str, nickname: str):
        """Handle '叫我xxx' danmu command: upsert this user's nickname for this room."""
        nickname = (nickname or "").strip()
        if not nickname:
            await self.send_danmu(f"{user_name}，昵称不能为空")
            return
        if len(nickname) > 6:
            await self.send_danmu(f"{user_name}，昵称过长（最多6字）")
            return
        upsert_nickname(self.real_room_id, user_id, user_name, nickname)
        await self.send_danmu(f"好的，{nickname}")

    async def handle_clear_nickname(self, user_id: int, user_name: str):
        delete_nickname(self.real_room_id, user_id)
        await self.send_danmu(f"{user_name}，已清除昵称")

    async def handle_blind_box_query(self, user_name, period: str = "today", user_id: int = 0):
        """Query blind box stats and reply via danmu. user_name=None for all users (streamer)."""
        utc_start, utc_end, _ = beijing_time_range(period)
        conn = sqlite3.connect(str(DB_PATH))
        sql = "SELECT extra_json FROM events WHERE event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ? AND extra_json LIKE '%blind_name%' AND extra_json NOT LIKE '%\"blind_name\": \"\"%'"
        params: list = [self.real_room_id, utc_start, utc_end]
        if user_name:
            sql += " AND user_name=?"
            params.append(user_name)
        rows = conn.execute(sql, params).fetchall()
        conn.close()

        period_label = PERIOD_LABELS.get(period, "今日")
        display_name = (get_nickname(self.real_room_id, user_id) or user_name) if user_name else ""
        prefix = f"{display_name}，" if display_name else ""
        if not rows:
            await self.send_danmu(f"{prefix}{period_label}暂无盲盒记录")
            return

        total_boxes = 0
        total_cost = 0
        total_value = 0
        boxes: dict[str, dict] = {}
        for r in rows:
            try:
                extra = json.loads(r[0])
            except (json.JSONDecodeError, TypeError):
                continue
            num = extra.get("num", 1)
            blind_name = extra.get("blind_name", "")
            total_boxes += num
            total_cost += extra.get("blind_price", 0) * num
            total_value += extra.get("price", 0) * num
            if blind_name not in boxes:
                boxes[blind_name] = {"count": 0, "cost": 0, "value": 0}
            boxes[blind_name]["count"] += num
            boxes[blind_name]["cost"] += extra.get("blind_price", 0) * num
            boxes[blind_name]["value"] += extra.get("price", 0) * num

        def fmt_profit(p: int) -> str:
            y = abs(p) / 10
            s = f"{y:.1f}".rstrip('0').rstrip('.')
            return "不亏不赚" if p == 0 else f"赚{s}元" if p > 0 else f"亏{s}元"

        profit = total_value - total_cost
        msg = f"{prefix}{period_label}盲盒共{total_boxes}个，{fmt_profit(profit)}"
        await self.send_danmu(msg)

        for name, b in boxes.items():
            await asyncio.sleep(2)
            await self.send_danmu(f"{name}{b['count']}个，{fmt_profit(b['value'] - b['cost'])}")

    def stop(self):
        self._running = False
