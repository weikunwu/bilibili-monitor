import { useEffect, useState } from 'react'
import { MdCircle } from 'react-icons/md'
import { Button, ButtonToolbar, IconButton, Input, Modal, Stack, Tag, useToaster, Message } from 'rsuite'
import PlayOutlineIcon from '@rsuite/icons/PlayOutline'
import CloseOutlineIcon from '@rsuite/icons/CloseOutline'
import ChangeListIcon from '@rsuite/icons/ChangeList'
import TrashIcon from '@rsuite/icons/Trash'
import { botLogout, bindRoomSelf, unbindRoomSelf, redeemRoomToken } from '../api/client'
import { confirmDialog } from '../lib/confirm'
import type { Room } from '../types'

// Per-tab cache of fresh streamer-info so 切来切去不重复打 B站。
interface StreamerInfo { streamer_name: string; streamer_avatar: string; followers: number }
const streamerInfoCache = new Map<number, StreamerInfo>()

async function batchFetchStreamerInfo(roomIds: number[]): Promise<void> {
  const missing = roomIds.filter((id) => !streamerInfoCache.has(id))
  if (missing.length === 0) return
  try {
    const r = await fetch(`/api/rooms/streamer-info?ids=${missing.join(',')}`)
    if (!r.ok) return
    const data = (await r.json()) as Record<string, StreamerInfo>
    for (const [k, v] of Object.entries(data)) {
      streamerInfoCache.set(Number(k), v)
    }
  } catch { /* ignore */ }
}

interface Props {
  rooms: Room[]
  onSelectRoom: (roomId: number) => void
  onRoomsChanged?: () => void
  onBindBot?: (roomId: number) => void
  isAdmin?: boolean
}

function formatFans(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return n.toLocaleString()
}

/** 到期时间：DB 存 UTC 'YYYY-MM-DD HH:MM:SS'，渲染成本地时间。
 *  未到期附带"剩余 N 天"，不足 1 天显示小时；已到期显示红色"已到期"。 */
function ExpiresRow({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return null
  const d = new Date(expiresAt.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return null
  const pad = (n: number) => n.toString().padStart(2, '0')
  const text = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const diffMs = d.getTime() - Date.now()
  const expired = diffMs <= 0
  let tagText: string
  let tagColor: 'red' | 'orange' | 'cyan'
  if (expired) {
    tagText = '已到期'
    tagColor = 'red'
  } else if (diffMs >= 86400000) {
    const days = Math.ceil(diffMs / 86400000)
    tagText = `剩余 ${days} 天`
    tagColor = days <= 3 ? 'orange' : 'cyan'
  } else {
    tagText = `剩余 ${Math.max(1, Math.ceil(diffMs / 3600000))} 小时`
    tagColor = 'orange'
  }
  return (
    <div className="rc-detail-row">
      <span className="rc-detail-label">到期</span>
      <span className={expired ? 'rc-expired' : 'rc-expires'}>{text}</span>
      <Tag size="sm" color={tagColor}>{tagText}</Tag>
    </div>
  )
}

function StreamerBlock({ room, fresh }: { room: Room; fresh: StreamerInfo | null }) {
  const avatar = fresh?.streamer_avatar || room.streamer_avatar
  const name = fresh?.streamer_name || room.streamer_name
  const followers = fresh?.followers ?? room.followers
  return (
    <div className="rc-streamer">
      {avatar ? (
        <img className="rc-avatar" src={avatar} referrerPolicy="no-referrer" alt="" />
      ) : (
        <div className="rc-avatar rc-avatar-placeholder" />
      )}
      <div className="rc-streamer-info">
        <div className="rc-streamer-name">{name}</div>
        <div className="rc-streamer-meta">
          粉丝: {formatFans(followers)} · UID: {room.streamer_uid}
        </div>
      </div>
    </div>
  )
}

// 爱发电账号实名/签约流程走完前先隐藏入口，改一行就能开。
const AFDIAN_ENABLED = false

export function RoomList({ rooms, onSelectRoom, onRoomsChanged, onBindBot, isAdmin }: Props) {
  const toaster = useToaster()
  const [bindOpen, setBindOpen] = useState(false)
  const [newRoomId, setNewRoomId] = useState('')
  const [bindError, setBindError] = useState('')
  const [binding, setBinding] = useState(false)

  const [redeemTarget, setRedeemTarget] = useState<Room | null>(null)
  const [redeemToken, setRedeemToken] = useState('')
  const [redeemErr, setRedeemErr] = useState('')
  const [redeeming, setRedeeming] = useState(false)

  const [afdianTarget, setAfdianTarget] = useState<Room | null>(null)

  // 拉取所有房间的最新主播资料：一次批量请求，backend 内部并发限流。
  const [streamerInfo, setStreamerInfo] = useState<Map<number, StreamerInfo>>(() => new Map(streamerInfoCache))
  useEffect(() => {
    if (rooms.length === 0) return
    const ids = rooms.map((r) => r.room_id)
    let cancelled = false
    batchFetchStreamerInfo(ids).then(() => {
      if (!cancelled) setStreamerInfo(new Map(streamerInfoCache))
    })
    return () => { cancelled = true }
  }, [rooms])

  const openRedeem = (r: Room) => {
    setRedeemTarget(r)
    setRedeemToken('')
    setRedeemErr('')
  }
  const closeRedeem = () => { setRedeemTarget(null); setRedeemToken(''); setRedeemErr('') }
  const handleRedeem = async () => {
    if (!redeemTarget) return
    const t = redeemToken.trim()
    if (!t) { setRedeemErr('请输入续费码'); return }
    setRedeeming(true); setRedeemErr('')
    try {
      await redeemRoomToken(redeemTarget.room_id, t)
      toaster.push(<Message type="success" showIcon closable>续费成功</Message>, { duration: 2500 })
      closeRedeem()
      onRoomsChanged?.()
    } catch (err) {
      setRedeemErr((err as Error).message)
    } finally { setRedeeming(false) }
  }

  const openBind = () => {
    setNewRoomId('')
    setBindError('')
    setBindOpen(true)
  }

  const handleBindRoom = async () => {
    const id = parseInt(newRoomId.trim(), 10)
    if (!id || isNaN(id)) {
      setBindError('请输入有效房间号')
      return
    }
    setBinding(true)
    setBindError('')
    try {
      await bindRoomSelf(id)
      setBindOpen(false)
      onRoomsChanged?.()
    } catch (err) {
      setBindError((err as Error).message)
    } finally {
      setBinding(false)
    }
  }

  const [unbindTarget, setUnbindTarget] = useState<Room | null>(null)
  const [unbinding, setUnbinding] = useState(false)

  const handleUnbindRoom = async () => {
    if (!unbindTarget) return
    setUnbinding(true)
    try {
      await unbindRoomSelf(unbindTarget.room_id)
      setUnbindTarget(null)
      onRoomsChanged?.()
    } catch (err) {
      toaster.push(<Message type="error" showIcon closable>{(err as Error).message}</Message>, { duration: 3000 })
    } finally {
      setUnbinding(false)
    }
  }

  const handleToggle = async (e: React.MouseEvent, room: Room) => {
    e.stopPropagation()
    const action = room.active ? 'stop' : 'start'
    const res = await fetch(`/api/rooms/${room.room_id}/${action}`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toaster.push(<Message type="error" showIcon closable>{data.detail || '操作失败'}</Message>, { duration: 3000 })
      return
    }
    onRoomsChanged?.()
  }

  return (
    <div className="room-list">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, width: '100%', maxWidth: 800 }}>
        <h2 style={{ margin: 0 }}>房间列表</h2>
        <Button appearance="primary" size="sm" onClick={openBind}>
          绑定房间
        </Button>
      </div>
      <Modal open={bindOpen} onClose={() => setBindOpen(false)} size="xs">
        <Modal.Header>
          <Modal.Title>绑定房间</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Input
            placeholder="请输入 B 站直播间房间号"
            value={newRoomId}
            onChange={setNewRoomId}
            onPressEnter={handleBindRoom}
            autoFocus
          />
          {bindError && (
            <Message type="error" showIcon style={{ marginTop: 12 }}>{bindError}</Message>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={() => setBindOpen(false)} appearance="subtle" disabled={binding}>取消</Button>
          <Button onClick={handleBindRoom} appearance="primary" loading={binding}>绑定</Button>
        </Modal.Footer>
      </Modal>
      <Modal open={redeemTarget !== null} onClose={() => !redeeming && closeRedeem()} size="xs">
        <Modal.Header>
          <Modal.Title>续费机器人</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>
            房间 <b>{redeemTarget?.streamer_name || redeemTarget?.room_id}</b>（每个续费码延长 30 天）
          </div>
          <Input
            placeholder="粘贴续费码"
            value={redeemToken}
            onChange={setRedeemToken}
            onPressEnter={handleRedeem}
            autoFocus
          />
          {redeemErr && <Message type="error" style={{ marginTop: 8 }}>{redeemErr}</Message>}
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={closeRedeem} appearance="subtle" disabled={redeeming}>取消</Button>
          <Button onClick={handleRedeem} color="yellow" appearance="primary" loading={redeeming}>续费</Button>
        </Modal.Footer>
      </Modal>
      <Modal open={afdianTarget !== null} onClose={() => setAfdianTarget(null)} size="xs">
        <Modal.Header>
          <Modal.Title>爱发电续费</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 12, lineHeight: 1.6 }}>
            房间 <b>{afdianTarget?.streamer_name || afdianTarget?.room_id}</b> · 选档位跳到爱发电付款，付款成功后房间到期时间会自动延长，无需回填任何码。
          </div>
          <Stack direction="column" spacing={8} alignItems="stretch">
            {[
              // 统一走商品 (product_type=1)，每档一个 SKU。
              { plan: '6cf0cfe23b8a11f1af005254001e7c00', sku: '6cf9a4aa3b8a11f1b4095254001e7c00', label: '月卡 · 1 个月' },
              { plan: '5953ff0a3b8e11f18c7252540025c377', sku: '595c3ee03b8e11f1bb8052540025c377', label: '季卡 · 3 个月' },
              { plan: '8174f0ca3b8e11f1ac5d52540025c377', sku: '817d9df63b8e11f1bccc52540025c377', label: '半年卡 · 6 个月' },
              { plan: '8e50689c3b8e11f1840f52540025c377', sku: '8e5907fe3b8e11f18e2952540025c377', label: '年卡 · 12 个月' },
              { plan: 'c59457283b8e11f1afbc52540025c377', sku: 'c59ea8cc3b8e11f1a76d52540025c377', label: '测试卡 · 1 个月' },
            ].map((opt) => (
              <Button
                key={opt.plan}
                appearance="primary"
                color="orange"
                onClick={() => {
                  if (!afdianTarget) return
                  const sku = encodeURIComponent(JSON.stringify([{ sku_id: opt.sku, count: 1 }]))
                  const url = `https://ifdian.net/order/create?product_type=1&plan_id=${opt.plan}&sku=${sku}&custom_order_id=${afdianTarget.room_id}`
                  window.open(url, '_blank', 'noopener,noreferrer')
                }}
              >{opt.label}</Button>
            ))}
          </Stack>
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={() => setAfdianTarget(null)} appearance="subtle">关闭</Button>
        </Modal.Footer>
      </Modal>
      <Modal open={unbindTarget !== null} onClose={() => !unbinding && setUnbindTarget(null)} size="xs">
        <Modal.Header>
          <Modal.Title>解绑房间</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          确定要解绑房间 <b>{unbindTarget?.streamer_name || unbindTarget?.room_id}</b>
          （房间号 {unbindTarget?.room_id}）吗？解绑后该房间将从你的房间列表中移除。
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={() => setUnbindTarget(null)} appearance="subtle" disabled={unbinding}>取消</Button>
          <Button onClick={handleUnbindRoom} color="red" appearance="primary" loading={unbinding}>解绑</Button>
        </Modal.Footer>
      </Modal>
      <div className="room-cards">
        {rooms.map((r) => (
          <div
            key={r.room_id}
            className="room-card"
            onClick={() => onSelectRoom(r.room_id)}
          >
            {/* Header: room title + status badges on left; actions on right */}
            <div className="rc-header">
              <div className="rc-header-left">
                <div className="rc-title-row">
                  <span className="rc-name">{r.room_title || `房间 ${r.room_id}`}</span>
                  {r.live_status === 1 && <span className="rc-badge rc-badge-live"><MdCircle size={8} /> 直播中</span>}
                </div>
                <span className="rc-room-id">房间 {r.room_id}</span>
              </div>
              <div className="rc-header-badges">
                {!isAdmin && (
                  <IconButton
                    size="xs"
                    appearance="subtle"
                    icon={<TrashIcon />}
                    title="解绑房间"
                    onClick={(e) => { e.stopPropagation(); setUnbindTarget(r) }}
                  />
                )}
              </div>
            </div>

            {/* Streamer info + area/announcement */}
            <div className="rc-body">
              <StreamerBlock room={r} fresh={streamerInfo.get(r.room_id) || null} />
              <div className="rc-details">
                {(r.parent_area_name || r.area_name) && (
                  <div className="rc-detail-row">
                    <span className="rc-detail-label">分区</span>
                    <div className="rc-detail-tags">
                      {r.parent_area_name && <span className="rc-tag">{r.parent_area_name}</span>}
                      {r.area_name && <span className="rc-tag">{r.area_name}</span>}
                    </div>
                  </div>
                )}
                {r.announcement && (
                  <div className="rc-detail-row">
                    <span className="rc-detail-label">公告</span>
                    <span className="rc-detail-text">{r.announcement}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Footer: bot + monitor status */}
            <div className="rc-footer">
              <div className="rc-footer-info">
                <div className="rc-detail-row">
                  <span className="rc-detail-label">机器人</span>
                  {r.bot_uid ? (
                    <span className="rc-bot-status active">{r.bot_name || 'Unknown'} (UID: {r.bot_uid})</span>
                  ) : (
                    <span className="rc-bot-status">未绑定</span>
                  )}
                </div>
                <ExpiresRow expiresAt={r.expires_at} />
              </div>
              <div className="rc-footer-actions">
                <ButtonToolbar>
                  {r.active ? (
                    <Button size="sm" color="red" appearance="ghost" startIcon={<CloseOutlineIcon />} style={{ width: 132 }} onClick={(e) => { e.stopPropagation(); handleToggle(e, r) }}>
                      停止监听
                    </Button>
                  ) : (
                    <Button size="sm" color="green" appearance="ghost" startIcon={<PlayOutlineIcon />} style={{ width: 132 }} onClick={(e) => { e.stopPropagation(); handleToggle(e, r) }}>
                      启动监听
                    </Button>
                  )}
                  <Button
                    size="sm" color="yellow" appearance="ghost" style={{ width: 132 }}
                    onClick={(e) => { e.stopPropagation(); openRedeem(r) }}
                  >续费机器人</Button>
                  {AFDIAN_ENABLED && (
                    <Button
                      size="sm" color="orange" appearance="ghost" style={{ width: 132 }}
                      onClick={(e) => { e.stopPropagation(); setAfdianTarget(r) }}
                    >爱发电续费</Button>
                  )}
                  {r.needs_relogin ? (
                    <div style={{ position: 'relative' }}>
                      <Button
                        size="sm" color="red" appearance="primary"
                        startIcon={<ChangeListIcon />} style={{ width: 132 }}
                        onClick={(e) => { e.stopPropagation(); onBindBot?.(r.room_id) }}
                      >
                        重新登录
                      </Button>
                      <div style={{
                        position: 'absolute',
                        top: 'calc(100% + 8px)',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        padding: '6px 12px',
                        background: '#2c2c2c',
                        color: '#fff',
                        borderRadius: 4,
                        fontSize: 13,
                        lineHeight: 1.4,
                        whiteSpace: 'nowrap',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                        pointerEvents: 'none',
                        zIndex: 1,
                      }}>
                        登录已失效，点此重新扫码
                        <span style={{
                          position: 'absolute',
                          bottom: '100%',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          width: 0,
                          height: 0,
                          borderLeft: '5px solid transparent',
                          borderRight: '5px solid transparent',
                          borderBottom: '5px solid #2c2c2c',
                        }} />
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" appearance="ghost" startIcon={<ChangeListIcon />} style={{ width: 132 }} onClick={(e) => { e.stopPropagation(); onBindBot?.(r.room_id) }}>
                      {r.bot_uid ? '更换机器人' : '绑定机器人'}
                    </Button>
                  )}
                  {r.bot_uid ? (
                    <Button
                      size="sm" color="red" appearance="ghost" style={{ width: 132 }}
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!await confirmDialog({ message: `解绑 ${r.bot_name || '机器人'}？会清除 cookie 并停止监控。`, danger: true, okText: '解绑' })) return
                        await botLogout(r.room_id)
                        onRoomsChanged?.()
                      }}
                    >解绑机器人</Button>
                  ) : null}
                </ButtonToolbar>
              </div>
            </div>
          </div>
        ))}
        {rooms.length === 0 && <div className="empty">暂无可用房间</div>}
      </div>
    </div>
  )
}
