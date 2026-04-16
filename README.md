# B站直播间监控

实时监控B站直播间的弹幕、礼物、醒目留言（SC）、上舰、点赞、关注等事件，通过网页展示、查询和自动互动。

## 功能

### 数据与查询
- 实时弹幕 / 礼物 / SC / 上舰事件推送（WebSocket）
- 历史事件查询（按时间范围、按类型筛选）
- 礼物 tab：用户筛选、多选生成礼物卡片图
- 今日礼物 / 今日盲盒汇总卡片生成
- 盲盒统计面板（今日 / 昨日 / 今月 / 上月；按用户、按盲盒类型、盈亏计算）
- 直播间弹幕指令（观众发"今日盲盒"等触发机器人统计回复）

### 自动化工具（主播工具 tab）
- **AI 机器人**：观众弹幕按概率触发 LLM 自动回复；弹幕里提到机器人名字时必定回复（智谱 GLM-4-Flash 免费）
- **感谢弹幕**：关注 / 点赞 / 分享 / 礼物 / 大航海 / 盲盒，支持多模板轮播，总开关 + 子开关
- **欢迎弹幕**：普通 / 粉丝牌 / 大航海 三类模板，进房同人 5 分钟去重、全局 10 秒节流
- **定时弹幕**：开播期间按设定间隔轮播
- **挂粉提醒**：对进房后 N 秒不发言的活跃粉丝 @ 一次
- **打个有效**：主播发触发词时自动送礼
- **昵称功能**："叫我 xxx" / "清除昵称"
- **实时礼物**：生成带 token 的公开 URL，OBS 浏览器源叠加最近 10 条礼物事件（透明背景）
- **礼物自动剪辑**（实验功能）：≥¥1000 礼物自动录制前后片段

### 其他
- 多房间支持，管理员可动态添加 / 删除房间
- 多用户系统（邮箱密码登录，管理员分配房间权限）
- 每房间独立机器人绑定（B站扫码登录，SESSDATA 加密存储）
- 房间启停控制
- 移动端适配

## 技术栈

- **后端**: Python / FastAPI / aiohttp / SQLite
- **前端**: React / TypeScript / Vite / rsuite（dark theme）
- **LLM**: 智谱 BigModel（GLM-4-Flash，OpenAI 兼容接口）
- **协议**: B站直播 WebSocket（brotli/zlib 压缩）
- **部署**: Docker / fly.io / GitHub Actions

## 快速开始

### 本地运行

```bash
# 复制环境变量模板
cp .env.example .env
# 按需修改 .env（至少填 COOKIE_SECRET 和 BIGMODEL_API_KEY）

# 后端
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 前端
cd frontend && npm install && npm run build && cd ..

# 启动
python monitor.py --port 8080
```

打开 http://localhost:8080（首次用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录，在房间列表页添加房间）。

### Docker

```bash
docker build -t bilibili-monitor .
docker run -p 8080:8080 \
  -e COOKIE_SECRET=$(python -c "import secrets;print(secrets.token_urlsafe(32))") \
  -e ADMIN_PASSWORD=changeme \
  -e BIGMODEL_API_KEY=your-key \
  bilibili-monitor
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATA_DIR` | SQLite / 日志 / 录屏 片段 存储目录 | 项目根目录 |
| `COOKIE_SECRET` | 加密机器人 cookie 的密钥（一旦更换旧 cookie 即失效） | - |
| `ADMIN_EMAIL` | 首次启动创建的管理员邮箱 | - |
| `ADMIN_PASSWORD` | 首次启动创建的管理员密码（留空则不创建） | - |
| `BIGMODEL_API_KEY` | [智谱 BigModel](https://open.bigmodel.cn/usercenter/apikeys) API Key（AI 机器人用，空则 AI 回复静默不触发） | - |

房间改为在 UI 里动态添加，不再通过 `ROOMS` env 配置。

## 弹幕指令

观众在直播间发送以下弹幕，机器人自动回复：

| 指令 | 说明 |
|------|------|
| `今日盲盒` / `昨日盲盒` / `今月盲盒` / `上月盲盒` | 查询发送者自己的盲盒统计和盈亏 |
| `N月盲盒`（如 `3月盲盒`） | 查询指定月的盲盒统计 |
| `我的盲盒` | 查询本月自己的盲盒统计 |
| `叫我 xxx` | 设置自己的昵称 |
| `清除昵称` | 清除自己的昵称 |

主播发送盲盒指令时，会返回直播间所有用户的盲盒汇总。

## OBS 实时礼物叠加

1. 在主播工具 → 实时礼物 复制带 token 的 URL
2. OBS 添加"浏览器源"，粘贴 URL，背景透明
3. 每 5 秒刷新，显示当天最新 10 条礼物事件（独立卡片，最新在顶）
4. Token 外泄 → "重新生成 token"让旧链接立即失效

## 项目结构

```
├── monitor.py            # 入口
├── server/
│   ├── app.py            # FastAPI 应用组装
│   ├── config.py         # 配置、API 常量、指令定义
│   ├── db.py             # 数据库操作
│   ├── auth.py           # 认证中间件
│   ├── crypto.py         # Cookie 加密
│   ├── protocol.py       # B站 WebSocket 协议解析
│   ├── bili_api.py       # B站 API (Wbi 签名)
│   ├── bili_client.py    # 直播间 WS 客户端 + 所有自动化逻辑
│   ├── manager.py        # 房间和 WS 连接管理
│   ├── recorder.py       # 礼物片段录制
│   ├── effect_catalog.py # 全屏特效目录同步
│   └── routes/
│       ├── events.py     # 事件查询、礼物/盲盒统计、CDN 代理
│       ├── rooms.py      # 房间管理、指令开关、overlay token
│       ├── bot.py        # 机器人绑定 (扫码)
│       ├── admin.py      # 管理员 API
│       ├── clips.py      # 录屏片段
│       └── overlay.py    # OBS 叠加公开接口 (token 鉴权 + IP 速率限制)
├── frontend/             # React + TypeScript 前端
├── static/               # 礼物卡片模板 / 大航海头像框
├── Dockerfile
└── fly.toml
```
