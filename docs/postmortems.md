# Postmortems

出过的坑。翻回来看：症状 → 怎么定位 → 根因 → 修法 → 以后可能再咬你的地方。

---

## 2026-04-22 · overlay 高价礼物在前端消失（总督/SC 看不到）

### 症状

用户报：`/overlay/1842745701/gifts` 实时礼物面板不再显示本周的总督上舰（Spect12e，¥15998），但命契幻境（¥3000）还在。

### 定位

```bash
# 1. 确认事件进了 DB
fly ssh console -a bilibili-monitor -C \
  "python3 -c \"import sqlite3; c=sqlite3.connect('/app/data/gifts.db'); \
  print(c.execute(\\\"SELECT id, timestamp, user_name, extra_json FROM events \
  WHERE room_id=1842745701 AND event_type='guard' ORDER BY id DESC LIMIT 5\\\").fetchall())\""
# → id=57315 在 DB 里，price=159980 电池

# 2. 直接 hit API 端点，看返回里有没有
curl -s "https://blackbubu.us/api/overlay/gifts/1842745701?token=..." | python3 -m json.tool
# → 只有命契幻境一条，总督不在返回里

# 3. 查 overlay_settings 看是否被价格/类型过滤
# settings: min_price=500, max_price=20000, show_guard=1, price_mode=total
# 总督 value_yuan=15998 在 [500, 20000] 里，不该被过滤

# 4. 查 scan_limit 窗口覆盖不覆盖这条 id
# 本周 qualifying 事件 199 条，总督之后还有 108 条，scan_limit=100，总督 id 不在扫描窗口内
```

### 根因

[server/routes/overlay.py](../server/routes/overlay.py) 的两段式过滤：SQL 只按 `id DESC` 取最新 `scan_limit = max_events * 5 = 100` 条，然后在 Python 里用 `_pass_filters` 按价格/类型精筛。

价格过滤**没下推到 SQL**。当房间有大量低价礼物（99 电池的 B坷垃、160 电池的初兆光符之类），这些礼物在 SQL 阶段没被过滤掉，占满 100 条扫描窗口，把更早发生的高价事件（总督、命契、SC）挤出窗口外，Python 根本没机会看到它们。

讽刺的地方：`min_price=500` 元这个设置本意是**隐藏小礼物**，结果因为没下推 SQL 变成了**让高价礼物消失**的 bug。

### 修法

[server/routes/overlay.py:228](../server/routes/overlay.py#L228) `scan_limit = max_events * 5` → `max_events * 100`。行为完全等价于现有 Python 过滤，只是扫描上限够大不会挤掉。单房间一周 qualifying 事件量级 10³，SQLite 扫 2000 行 JSON 毫秒级，无性能顾虑。

### 以后的地雷

**这个修法只是抬高了天花板，没消除根因。** 如果某个房间在选的时间窗口内 qualifying 事件 > 2000（比如大主播礼物轰炸日），同样的 bug 会在 2000 这个量级重现。

彻底根治：把 `min_price / max_price / show_gift / show_blind / show_guard / show_superchat` 全下推 SQL WHERE 子句，用 `CASE WHEN + json_extract` 按 event_type 分支算 total_coin / unit。没做是因为 SQL 长了 bug 面也大，要确保跟 `_pass_filters` 完全等价；现在量级没到不值得动。

**检查信号：** 以后哪个房间又报"XX 礼物看不见"，先看本周 qualifying 事件数是不是 > 2000。到了就必须 SQL 下推。

---

## 2026-04-22 · 录屏 `_run` 启动时静默死亡，高价礼全漏

### 症状

用户报：`Spect12e` 送的**命契幻境**（¥3000）和**总督**（¥15998）都没触发录屏 clip。同一用户另一次 `提督`（¥1598）也没录上。

### 定位

```bash
# 1. 礼物事件本身进没进 DB
fly ssh console -a bilibili-monitor -C \
  "python3 -c \"import sqlite3; c=sqlite3.connect('/app/data/gifts.db'); \
  print(c.execute(\\\"SELECT timestamp, event_type, user_name, content, extra_json \
  FROM events WHERE user_name='Spect12e' ORDER BY timestamp DESC LIMIT 10\\\").fetchall())\""
# → 命契 price=30000 / 总督 price=159980，都进了 DB，都过阈值 10000

# 2. app.log 看 clip 触发有没有打日志
fly ssh console -a bilibili-monitor -C \
  "grep -E 'Spect12e|recorder.*1842745701' /app/data/app.log | tail -50"
# → 两次都有 "clip triggered"，紧跟着 "clip skipped: not buffering (running=True, segments=0)"

# 3. 录屏 buffer 目录
fly ssh console -a bilibili-monitor -C \
  "sh -c 'for d in /tmp/recorder_buf/*; do echo \$d; ls \$d | wc -l; done'"
# → 所有房间的 buf 目录都是 0 个文件

# 4. 找 _run 任务死因（Python 只在 GC 时才吐 "Task exception was never retrieved"，
#    进程退出时会 flush）
fly ssh console -a bilibili-monitor -C "grep -B4 'line 383' /app/data/app.log | tail -40"
# → AttributeError: 'NoneType' object has no attribute 'get'
```

### 根因

[server/recorder.py](../server/recorder.py) 里 `_resolve_playurl` 用链式 `.get()`:

```python
for s in data.get("data", {}).get("playurl_info", {}).get("playurl", {}).get("stream", []):
```

B 站某些情况下返回 `"playurl_info": null`（字段存在但值是 `null`）。`.get(k, default)` 只有 key **缺失**时才用 default —— key 存在但值是 `None` 时仍然返回 `None`，然后 `None.get(...)` 爆 AttributeError。

异常沿 `_run` 冒泡，但 `_run` 的 try 只 `except asyncio.CancelledError`，于是：
1. 任务静默终止
2. `_running` 标志没复位（还是 True）
3. `_session` 还在（没 close）
4. 上层 `_maybe_clip` 检查 `session._running=True` 以为会话正常，把 clip 请求转过去
5. `request_clip` 发现 `_segments=[]`，打一条 `not buffering` 就走人

关键坑：Python 异步任务的异常只在任务 GC 时才通过 `Task exception was never retrieved` 暴露。`self._task` 常驻引用，任务永远不被 GC，所以**异常信息只有在进程重启时才会 flush 到日志里**。这就是为什么以前没发现 —— 每次部署都让新进程重蹈覆辙，但旧进程的尸检报告要等到下次部署才看得见。

### 修法（commit f46a2f5）

1. [server/recorder.py:385-390](../server/recorder.py#L385-L390) 链式 `.get()` 改成逐层 `or {}`，对 None 健壮
2. [server/recorder.py:350-403](../server/recorder.py#L350-L403) `_run` 外层包重试循环：2s 起步指数退避封顶 30s；任何异常 log.exception 后重来；只有 stop() 显式调用或 CancelledError 才真正退出
3. 每次重试迭代创建新的 aiohttp session，`finally` 关闭，避免陈旧连接池

下播由 bili_client 的 `PREPARING → stop_for` 托底，`_run` 不需要自己判断 live_status。

### 以后的地雷

**任何 `asyncio.create_task(foo)` 都要小心异常吞掉。** fire-and-forget 模式下，异常只在 task GC 时才浮出来，如果 task 被长期引用（比如存在 registry dict 或 self 属性上），异常永不 flush。

**排查套路固化了：** 静默故障先看 buffer 目录 / 存储，再看状态标志，最后 `grep 'line N'` 往前倒推 traceback。

搜 `asyncio.create_task` 还能看到几处 fire-and-forget（[server/bili_client.py](../server/bili_client.py) 里的 recorder.start_for / stop_for、[server/routes/rooms.py](../server/routes/rooms.py) 里一处），虽然内层函数自己有 try/except，但**调用点没 add_done_callback 也没 name**，出了事同样静默。以后可以统一加一个 `_spawn(coro, name)` helper 套个 `add_done_callback(log_exception)` 上去。

---
