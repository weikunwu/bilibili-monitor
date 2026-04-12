"""房间和 WebSocket 连接管理"""

import asyncio
from typing import Optional

from fastapi import WebSocket

from .bili_client import BiliLiveClient
from .crypto import load_cookies
from .db import set_room_active, get_all_rooms


class RoomManager:
    def __init__(self):
        self._clients: dict[int, BiliLiveClient] = {}
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
        for ws, allowed_rooms in self._ws_clients.items():
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
        if client._running:
            return
        set_room_active(room_id, True)
        asyncio.create_task(client.run())

    def stop_room(self, room_id: int):
        client = self._clients.get(room_id)
        if client:
            client.stop()
        set_room_active(room_id, False)

    def add_room(self, room_id: int) -> BiliLiveClient:
        """Create an in-memory client (does not start listening)."""
        cookies = load_cookies(room_id)
        client = BiliLiveClient(room_id, on_event=self.broadcast, cookies=cookies)
        self._clients[room_id] = client
        return client

    def remove_room(self, room_id: int):
        client = self._clients.pop(room_id, None)
        if client:
            client.stop()
        set_room_active(room_id, False)


manager = RoomManager()
