# B站直播间监控

实时监控B站直播间的弹幕、礼物、醒目留言（SC）、上舰等事件，通过网页展示和查询。

## 功能

- 实时弹幕、礼物、SC、上舰事件推送（WebSocket）
- 历史事件查询（按时间范围、按类型筛选）
- 礼物 tab 支持用户筛选、多选生成礼物卡片
- 今日礼物 / 今日盲盒汇总卡片生成
- 盲盒统计面板（今日/昨日/今月/上月，按用户、按盲盒类型、盈亏计算）
- 直播间弹幕指令（用户发"今日盲盒"等触发机器人回复统计）
- 多房间支持，管理员可动态添加/删除房间
- 多用户系统（邮箱密码登录，管理员分配房间权限）
- 每房间独立机器人绑定（B站扫码登录）
- 房间启停控制（需先绑定机器人）
- 指令系统（如主播弹幕触发自动送礼）
- 直播状态实时更新（LIVE/PREPARING 事件监听）
- 移动端适配

## 技术栈

- **后端**: Python / FastAPI / aiohttp / SQLite
- **前端**: React / TypeScript / Vite / rsuite (dark theme)
- **协议**: B站直播 WebSocket（brotli/zlib 压缩）
- **部署**: Docker / fly.io / GitHub Actions

## 快速开始

### 本地运行

```bash
# 后端
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 前端
cd frontend && npm install && npm run build && cd ..

# 启动
python monitor.py --rooms 房间号1,房间号2 --port 8080
```

打开 http://localhost:8080

### Docker

```bash
docker build -t bilibili-monitor .
docker run -p 8080:8080 -e ROOMS=房间号1,房间号2 bilibili-monitor
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ROOMS` | 监控的房间号（逗号分隔） | `1920456329,32365569` |
| `ADMIN_EMAIL` | 管理员邮箱 | `admin@bilibili-monitor.local` |
| `ADMIN_PASSWORD` | 管理员密码（设置后自动创建账号） | - |
| `COOKIE_SECRET` | Cookie 加密密钥 | - |
| `DATA_DIR` | 数据目录（SQLite 存储位置） | 项目根目录 |

## 弹幕指令

用户在直播间发送以下弹幕，机器人会自动回复统计：

| 指令 | 说明 |
|------|------|
| `今日盲盒` | 查询自己今日的盲盒统计和盈亏 |
| `昨日盲盒` | 查询昨日盲盒统计 |
| `本月盲盒` | 查询今月盲盒统计 |
| `上月盲盒` | 查询上月盲盒统计 |

主播发送以上指令时，会返回直播间所有用户的盲盒汇总。

## 项目结构

```
├── monitor.py            # 入口
├── server/
│   ├── app.py            # FastAPI 应用组装
│   ├── config.py         # 配置和常量
│   ├── db.py             # 数据库操作
│   ├── auth.py           # 认证中间件
│   ├── crypto.py         # 加密工具
│   ├── protocol.py       # B站 WebSocket 协议解析
│   ├── bili_api.py       # B站 API（Wbi 签名）
│   ├── bili_client.py    # 直播间 WebSocket 客户端 + 弹幕指令
│   ├── manager.py        # 房间和 WebSocket 连接管理
│   └── routes/           # API 路由
│       ├── events.py     # 事件查询、礼物/盲盒统计
│       ├── rooms.py      # 房间管理、指令
│       ├── bot.py        # 机器人绑定（扫码）
│       └── admin.py      # 管理员 API
├── frontend/             # React + TypeScript 前端
├── static/               # 静态资源（礼物卡片模板等）
├── Dockerfile
└── fly.toml
```
