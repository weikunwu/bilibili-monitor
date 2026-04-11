# B站直播间监控

实时监控B站直播间的弹幕、礼物、醒目留言（SC）、上舰等事件，通过网页展示和查询。

## 功能

- 实时弹幕、礼物、SC、上舰事件推送（WebSocket）
- 历史事件查询（按时间范围、按类型筛选）
- 今日礼物汇总卡片生成
- 多房间支持，管理员可动态添加/删除房间
- 多用户系统（邮箱密码登录，管理员分配房间权限）
- 每房间独立机器人绑定（B站扫码登录）
- 指令系统（如主播弹幕触发自动送礼）
- 移动端适配

## 技术栈

- **后端**: Python / FastAPI / aiohttp / SQLite
- **前端**: React / TypeScript / Vite / rsuite
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

## 项目结构

```
├── monitor.py          # 入口
├── server/
│   ├── app.py          # FastAPI 应用组装
│   ├── config.py       # 配置和常量
│   ├── db.py           # 数据库操作
│   ├── auth.py         # 认证中间件
│   ├── crypto.py       # 加密工具
│   ├── protocol.py     # B站 WebSocket 协议解析
│   ├── bili_api.py     # B站 API（Wbi 签名、礼物配置）
│   ├── bili_client.py  # 直播间 WebSocket 客户端
│   └── routes/         # API 路由
├── frontend/           # React + TypeScript 前端
├── static/             # 静态资源（礼物卡片模板等）
├── Dockerfile
└── fly.toml
```
