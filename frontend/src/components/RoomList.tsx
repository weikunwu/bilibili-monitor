import { useEffect, useRef, useState } from 'react'
import { MdCircle, MdConfirmationNumber, MdLogout } from 'react-icons/md'
import { SiAlipay, SiWechat } from 'react-icons/si'
import { Button, ButtonToolbar, CheckPicker, IconButton, Input, Modal, SelectPicker, Stack, Tag, useToaster, Message } from 'rsuite'
import PlayOutlineIcon from '@rsuite/icons/PlayOutline'
import CloseOutlineIcon from '@rsuite/icons/CloseOutline'
import ChangeListIcon from '@rsuite/icons/ChangeList'
import TrashIcon from '@rsuite/icons/Trash'
import {
  botLogout, bindRoomSelf, unbindRoomSelf, redeemRoomToken,
  fetchPaymentPlans, createPaymentOrder, fetchPaymentStatus,
  type RenewalPlan, type PaymentOrder,
} from '../api/client'
import { confirmDialog } from '../lib/confirm'
import { useIsMobile } from '../hooks/useIsMobile'
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

// B 站 live_status：0=未开播 1=直播中 2=轮播中
const LIVE_STATUS_OPTIONS = [
  { label: '直播中', value: 1 },
  { label: '未开播', value: 0 },
  { label: '轮播中', value: 2 },
]

export function RoomList({ rooms, onSelectRoom, onRoomsChanged, onBindBot, isAdmin }: Props) {
  const toaster = useToaster()
  const isMobile = useIsMobile()
  const [bindOpen, setBindOpen] = useState(false)
  const [newRoomId, setNewRoomId] = useState('')
  const [bindError, setBindError] = useState('')
  const [binding, setBinding] = useState(false)

  const [redeemTarget, setRedeemTarget] = useState<Room | null>(null)
  const [redeemToken, setRedeemToken] = useState('')
  const [redeemErr, setRedeemErr] = useState('')
  const [redeeming, setRedeeming] = useState(false)

  const [afdianTarget, setAfdianTarget] = useState<Room | null>(null)

  // ── 扫码续费（Z-Pay → 支付宝）── 单一 modal 走两步：先选档位，再显示 QR + 轮询。
  // payZpayEnabled 在挂载时拉一次 /api/payments/plans 决定，控制"支付宝续费"
  // 按钮是否渲染。env 缺 ZPAY_KEY → channels.zpay=false → 整颗按钮
  // 不出现在房间卡上，用户看不到入口（不是 disabled 灰按钮）。
  const [payTarget, setPayTarget] = useState<Room | null>(null)
  const [payPlans, setPayPlans] = useState<RenewalPlan[]>([])
  const [payZpayEnabled, setPayZpayEnabled] = useState(false)

  useEffect(() => {
    fetchPaymentPlans()
      .then((info) => {
        setPayPlans(info.plans)
        setPayZpayEnabled(info.channels.zpay)
      })
      .catch(() => { /* 拉失败默认 disabled，按钮不出现 */ })
  }, [])
  const [paySelectedPlan, setPaySelectedPlan] = useState<string>('')
  const [paySubmitting, setPaySubmitting] = useState(false)
  const [payOrder, setPayOrder] = useState<PaymentOrder | null>(null)
  const [payStatusText, setPayStatusText] = useState('')
  const [payStatusKind, setPayStatusKind] = useState<'info' | 'success' | 'error' | 'warning'>('info')
  const payTimerRef = useRef<number | null>(null)
  const payOrderRef = useRef<string>('')

  function cleanupPayTimer() {
    if (payTimerRef.current) { window.clearInterval(payTimerRef.current); payTimerRef.current = null }
    payOrderRef.current = ''
  }

  function closePay() {
    cleanupPayTimer()
    setPayTarget(null)
    setPayOrder(null)
    setPaySelectedPlan('')
    setPayStatusText('')
    setPayStatusKind('info')
  }

  async function openPay(r: Room) {
    cleanupPayTimer()
    setPayTarget(r)
    setPayOrder(null)
    setPaySelectedPlan('')
    setPayStatusText('')
    setPayStatusKind('info')
    try {
      const info = await fetchPaymentPlans()
      setPayPlans(info.plans)
      setPayZpayEnabled(info.channels.zpay)
      if (info.plans.length > 0) setPaySelectedPlan(info.plans[0].id)
      if (!info.channels.zpay) {
        setPayStatusText('当前未配置在线支付通道')
        setPayStatusKind('error')
      }
    } catch {
      setPayStatusText('加载档位失败')
      setPayStatusKind('error')
    }
  }

  async function handleCreatePayOrder(channel: 'zpay', planId: string) {
    if (!payTarget || !planId) return
    setPaySubmitting(true)
    setPayStatusText('正在创建订单...')
    setPayStatusKind('info')
    try {
      const order = await createPaymentOrder(payTarget.room_id, planId, channel)
      setPayOrder(order)
      payOrderRef.current = order.out_trade_no
      setPayStatusText('请用「支付宝」扫上方二维码完成付款，本窗口会自动检测')
      setPayStatusKind('info')
      // 轮询：3s 一次直到 paid / expired，或者订单 expire 到点。
      const startedAt = Date.now()
      payTimerRef.current = window.setInterval(async () => {
        if (!payOrderRef.current) return
        if (Date.now() - startedAt > order.expire * 1000) {
          cleanupPayTimer()
          setPayStatusText('订单已超时，请重新发起')
          setPayStatusKind('warning')
          return
        }
        try {
          const s = await fetchPaymentStatus(order.out_trade_no)
          if (s.status === 'paid') {
            cleanupPayTimer()
            setPayStatusText('支付成功，房间已续费')
            setPayStatusKind('success')
            onRoomsChanged?.()
            window.setTimeout(() => closePay(), 1500)
          } else if (s.status === 'rejected') {
            cleanupPayTimer()
            setPayStatusText('订单异常（金额不符），请联系客服处理。请勿再扫此二维码')
            setPayStatusKind('error')
          } else if (s.status === 'expired') {
            cleanupPayTimer()
            setPayStatusText('订单已关闭，请重新发起')
            setPayStatusKind('warning')
          }
        } catch { /* 偶发查单失败不中断轮询 */ }
      }, 3000)
    } catch (err) {
      setPayStatusText(`下单失败：${(err as Error).message}`)
      setPayStatusKind('error')
    } finally {
      setPaySubmitting(false)
    }
  }

  useEffect(() => () => cleanupPayTimer(), [])

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
  const [togglingRoomId, setTogglingRoomId] = useState<number | null>(null)

  // 直播状态单选（null = 不筛选）；主播多选（空数组 = 不筛选）。
  // 缓存到 sessionStorage：从房间页返回时保留筛选；关标签页清空。
  const [statusFilter, setStatusFilter] = useState<number | null>(() => {
    const v = sessionStorage.getItem('roomList.statusFilter')
    return v === null || v === '' ? null : Number(v)
  })
  const [streamerFilter, setStreamerFilter] = useState<number[]>(() => {
    const v = sessionStorage.getItem('roomList.streamerFilter')
    if (!v) return []
    try { return (JSON.parse(v) as number[]).filter((n) => typeof n === 'number') } catch { return [] }
  })
  useEffect(() => {
    if (statusFilter === null) sessionStorage.removeItem('roomList.statusFilter')
    else sessionStorage.setItem('roomList.statusFilter', String(statusFilter))
  }, [statusFilter])
  useEffect(() => {
    if (streamerFilter.length === 0) sessionStorage.removeItem('roomList.streamerFilter')
    else sessionStorage.setItem('roomList.streamerFilter', JSON.stringify(streamerFilter))
  }, [streamerFilter])

  // 滚动位置缓存：实际的 scroll 容器是 .room-list 自己（CSS 上有 overflow-y），
  // 不是父级 .page-scroll；ref 必须挂在这里 onScroll 才会触发。
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    if (rooms.length === 0) return
    const saved = sessionStorage.getItem('roomList.scrollTop')
    if (saved && scrollRef.current) {
      scrollRef.current.scrollTop = parseInt(saved, 10) || 0
    }
    restoredRef.current = true
  }, [rooms.length])
  const streamerOptions = (() => {
    const seen = new Set<number>()
    const opts: { label: string; value: number }[] = []
    for (const r of rooms) {
      if (!r.streamer_uid || seen.has(r.streamer_uid)) continue
      seen.add(r.streamer_uid)
      const fresh = streamerInfo.get(r.room_id)
      const name = fresh?.streamer_name || r.streamer_name || `UID ${r.streamer_uid}`
      opts.push({ label: name, value: r.streamer_uid })
    }
    return opts
  })()
  const filteredRooms = rooms.filter((r) => {
    if (statusFilter !== null && r.live_status !== statusFilter) return false
    if (streamerFilter.length > 0 && !streamerFilter.includes(r.streamer_uid)) return false
    return true
  })

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
    if (room.active) {
      const ok = await confirmDialog({
        title: '确认停止房间',
        message: '停止监听后，该房间的礼物、弹幕、醒目留言等所有数据收集都会停止。确定要停止吗？',
        okText: '确定停止',
        color: 'yellow',
      })
      if (!ok) return
    }
    const action = room.active ? 'stop' : 'start'
    setTogglingRoomId(room.room_id)
    try {
      const res = await fetch(`/api/rooms/${room.room_id}/${action}`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toaster.push(<Message type="error" showIcon closable>{data.detail || '操作失败'}</Message>, { duration: 3000 })
        return
      }
      onRoomsChanged?.()
    } finally {
      setTogglingRoomId(null)
    }
  }

  return (
    <div
      className="room-list"
      ref={scrollRef}
      onScroll={(e) => sessionStorage.setItem('roomList.scrollTop', String((e.currentTarget as HTMLDivElement).scrollTop))}
    >
      <div className="room-list-header">
        <h2>房间列表</h2>
        <div className="room-list-filter">
          <SelectPicker
            data={LIVE_STATUS_OPTIONS}
            value={statusFilter}
            onChange={setStatusFilter}
            placeholder="直播状态"
            size="sm"
            searchable={false}
            cleanable
          />
          <CheckPicker
            data={streamerOptions}
            value={streamerFilter}
            onChange={setStreamerFilter}
            placeholder="筛选主播"
            size="sm"
            searchable
            cleanable
            countable
          />
          <Button appearance="primary" size="sm" onClick={openBind}>
            绑定房间
          </Button>
        </div>
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
      <Modal open={payTarget !== null} onClose={() => !paySubmitting && closePay()} size="sm">
        <Modal.Header>
          <Modal.Title>选择套餐</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 12, lineHeight: 1.6 }}>
            房间 <b>{payTarget?.streamer_name || payTarget?.room_id}</b>
          </div>
          {!payOrder && (
            <>
              <Message type="info" style={{ marginBottom: 12 }}>
                <div>添加客服微信还可以拿到优惠哦~</div>
                <div>
                  <SiWechat color="#07C160" style={{ verticalAlign: '-2px', marginRight: 4 }} />
                  <b>BlackBubu55</b>
                </div>
              </Message>
              <div className="plan-grid">
                {payPlans.map((p) => {
                  // 季卡（3 个月）作为推荐档位
                  const recommended = p.id === 'season'
                  const isTest = p.id === 'test'
                  const days = p.months * 30
                  const perMonth = (p.yuan / p.months).toFixed(1)
                  const isLoading = paySubmitting && paySelectedPlan === p.id
                  return (
                    <div
                      key={p.id}
                      className={recommended ? 'plan-card recommended' : 'plan-card'}
                    >
                      {recommended && <span className="plan-card-recommended-tag">推荐</span>}
                      {isTest && <span className="plan-card-test-tag">测试专用</span>}
                      <div className="plan-card-days">{days}天</div>
                      <div className="plan-card-price">
                        <span className="plan-card-price-symbol">¥</span>{p.yuan}
                      </div>
                      <div className="plan-card-permonth">约 {perMonth} 元/30天</div>
                      <Button
                        appearance="primary"
                        color={recommended ? 'green' : 'blue'}
                        size="sm"
                        disabled={!payZpayEnabled || (paySubmitting && !isLoading)}
                        loading={isLoading}
                        onClick={() => {
                          setPaySelectedPlan(p.id)
                          handleCreatePayOrder('zpay', p.id)
                        }}
                      >立即购买</Button>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {payOrder && (
            <Stack direction="column" spacing={10} alignItems="center">
              <img
                alt="支付二维码"
                width={220} height={220}
                src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payOrder.code_url)}`}
              />
              <div>支付宝 · ¥{payOrder.yuan} · {payOrder.months} 个月</div>
              {isMobile && (
                <>
                  <Button
                    as="a"
                    href={payOrder.code_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    appearance="primary"
                    color="blue"
                    startIcon={<SiAlipay />}
                  >立即用支付宝打开</Button>
                  <div style={{ fontSize: 12, color: '#888', textAlign: 'center', lineHeight: 1.5 }}>
                    点上方按钮会自动唤起支付宝 App；微信内打开按钮失效，请复制到外部浏览器。
                  </div>
                </>
              )}
            </Stack>
          )}
          {payStatusText && (
            <Message type={payStatusKind} style={{ marginTop: 12 }}>{payStatusText}</Message>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={closePay} appearance="subtle" disabled={paySubmitting}>关闭</Button>
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
        {filteredRooms.map((r) => (
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
                  {r.live_status === 2 && <span className="rc-badge rc-badge-rebroadcast"><MdCircle size={8} /> 轮播中</span>}
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

            {!r.active && (
              <Message
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                header="监听未启动"
              >
                当前房间未在监听，礼物、弹幕、醒目留言等数据均不会被收集。点击下方"启动监听"开始。
              </Message>
            )}

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
                    <Button size="sm" color="red" appearance="ghost" startIcon={<CloseOutlineIcon />} style={{ width: 132 }} loading={togglingRoomId === r.room_id} onClick={(e) => { e.stopPropagation(); handleToggle(e, r) }}>
                      停止监听
                    </Button>
                  ) : (
                    <Button size="sm" color="green" appearance="ghost" startIcon={<PlayOutlineIcon />} style={{ width: 132 }} loading={togglingRoomId === r.room_id} onClick={(e) => { e.stopPropagation(); handleToggle(e, r) }}>
                      启动监听
                    </Button>
                  )}
                  <Button
                    size="sm" color="yellow" appearance="ghost" style={{ width: 132 }}
                    startIcon={<MdConfirmationNumber />}
                    onClick={(e) => { e.stopPropagation(); openRedeem(r) }}
                  >续费机器人</Button>
                  {payZpayEnabled && (
                    <Button
                      size="sm" color="orange" appearance="ghost" style={{ width: 132 }}
                      startIcon={<SiAlipay />}
                      onClick={(e) => { e.stopPropagation(); openPay(r) }}
                    >支付宝续费</Button>
                  )}
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
                      startIcon={<MdLogout />}
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
        {rooms.length > 0 && filteredRooms.length === 0 && <div className="empty">没有符合筛选条件的房间</div>}
      </div>
    </div>
  )
}
