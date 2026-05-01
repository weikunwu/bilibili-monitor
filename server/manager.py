"""房间和 WebSocket 连接管理"""

import asyncio
from typing import Optional

from fastapi import WebSocket

from .bili_client import BiliLiveClient
from .crypto import load_cookies, decrypt_cookies
from .db import (
    set_room_active, get_all_rooms,
    list_default_bots, get_default_bot_cookie_blob, delete_default_bot,
)


class RoomManager:
    def __init__(self):
        self._clients: dict[int, BiliLiveClient] = {}
        # 默认机器人池：和具体监控房间无关；admin 扫码登录后在这里增减。
        # key = bot UID。这些 client 只用于跨房间动作（批量点赞等），不连 WS。
        self._default_bots: dict[int, BiliLiveClient] = {}
        self._ws_clients: dict[WebSocket, Optional[list[int]]] = {}

    # ── Client access ──

    def get(self, room_id: int) -> Optional[BiliLiveClient]:
        return self._clients.get(room_id)

    def has(self, room_id: int) -> bool:
        return room_id in self._clients

    def all_clients(self) -> dict[int, BiliLiveClient]:
        return self._clients

    # ── Lifecycle ──

    async def broadcast(self, event: dict):
        dead = set()
        room_id = event.get("room_id")
        for ws, allowed_rooms in list(self._ws_clients.items()):
            if allowed_rooms is not None and room_id and room_id not in allowed_rooms:
                continue
            try:
                await ws.send_json(event)
            except Exception:
                dead.add(ws)
        for d in dead:
            self._ws_clients.pop(d, None)

    def add_ws(self, ws: WebSocket, allowed_rooms: Optional[list[int]]):
        self._ws_clients[ws] = allowed_rooms

    def remove_ws(self, ws: WebSocket):
        self._ws_clients.pop(ws, None)

    def load_all(self):
        """Load all rooms from DB, creating clients for each."""
        for rid, _ in get_all_rooms():
            if rid not in self._clients:
                cookies = load_cookies(rid)
                client = BiliLiveClient(rid, on_event=self.broadcast, cookies=cookies)
                self._clients[rid] = client

    def get_run_tasks(self) -> list:
        """Return coroutines for all active rooms."""
        active = {rid for rid, act in get_all_rooms() if act}
        return [
            client.run()
            for client in self._clients.values()
            if client.room_id in active
        ]

    async def start_room(self, room_id: int):
        if room_id not in self._clients:
            cookies = load_cookies(room_id)
            client = BiliLiveClient(room_id, on_event=self.broadcast, cookies=cookies)
            self._clients[room_id] = client

        client = self._clients[room_id]
        # 同步双重检查：_running 是 run() 体里写的，asyncio.create_task 排队
        # 但还没执行 → 老的 run() body 还没跑到 self._running=True 之前，
        # 并发的第二个 start_room 也会看到 False。靠 _task.done() 兜底。
        if client._running or (client._task is not None and not client._task.done()):
            return
        # 同步置位再 schedule，让真正的并发调用立刻在上面那行 bail。
        client._running = True
        set_room_active(room_id, True)
        client._task = asyncio.create_task(client.run())

    async def stop_room(self, room_id: int):
        client = self._clients.get(room_id)
        if client:
            await client.stop()
        set_room_active(room_id, False)

    def add_room(self, room_id: int) -> BiliLiveClient:
        """Create an in-memory client (does not start listening)."""
        cookies = load_cookies(room_id)
        client = BiliLiveClient(room_id, on_event=self.broadcast, cookies=cookies)
        self._clients[room_id] = client
        return client

    async def remove_room(self, room_id: int):
        client = self._clients.pop(room_id, None)
        if client:
            await client.stop()
        set_room_active(room_id, False)

    # ── 默认机器人池 ──

    def all_default_bots(self) -> dict[int, BiliLiveClient]:
        return self._default_bots

    def default_bot(self, uid: int) -> Optional[BiliLiveClient]:
        return self._default_bots.get(uid)

    def add_default_bot(self, uid: int, cookies: dict) -> BiliLiveClient:
        """新建/覆盖一个默认机器人 client（不连 WS，只持 cookie 供跨房间动作）。"""
        client = BiliLiveClient(
            room_id=0, on_event=self.broadcast,
            cookies=cookies, is_default_bot=True,
        )
        client.bot_uid = uid
        self._default_bots[uid] = client
        return client

    def remove_default_bot(self, uid: int):
        self._default_bots.pop(uid, None)
        delete_default_bot(uid)

    def load_all_default_bots(self):
        """启动时从 DB 把 default_bots 加载进内存池。"""
        for row in list_default_bots():
            uid = row["uid"]
            if uid in self._default_bots:
                continue
            blob = get_default_bot_cookie_blob(uid)
            if not blob:
                continue
            try:
                cookies = decrypt_cookies(blob)
            except Exception:
                continue
            if not cookies.get("SESSDATA"):
                continue
            client = BiliLiveClient(
                room_id=0, on_event=self.broadcast,
                cookies=cookies, is_default_bot=True,
            )
            client.bot_uid = uid
            client.bot_name = row.get("name") or ""
            self._default_bots[uid] = client


manager = RoomManager()
