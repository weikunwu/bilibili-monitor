import { useState, useEffect, useRef, useCallback } from 'react'
import { Input, InputGroup, Button, SelectPicker, Modal, Checkbox, Stack, Divider, Message } from 'rsuite'
import type { Room } from '../types'
import {
  fetchUsers, createUser, deleteUser, assignUserRooms, updateUserRole, addRoom, removeRoom,
  createRenewalTokens, listRenewalTokens, triggerRoomLikes,
  fetchPopularityQuota, sendPopularityVote,
  listDefaultBots, fetchDefaultBotQrCode, pollDefaultBotQrLogin, deleteDefaultBot,
  rechargeDefaultBot, queryRechargeStatus,
  type UserInfo, type RenewalToken, type DefaultBot,
} from '../api/client'
import { confirmDialog } from '../lib/confirm'

interface Props {
  rooms: Room[]
  onRoomsChanged: () => void
  role: 'admin' | 'staff' | 'user'
}

export function AdminPanel({ rooms, onRoomsChanged, role: currentRole }: Props) {
  const isAdmin = currentRole === 'admin'
  const [users, setUsers] = useState<UserInfo[]>([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')
  const [error, setError] = useState('')
  const [editingUser, setEditingUser] = useState<number | null>(null)
  const [editRooms, setEditRooms] = useState<number[]>([])
  const [newRoomId, setNewRoomId] = useState('')
  const [roomError, setRoomError] = useState('')
  const [roomLoading, setRoomLoading] = useState(false)
  const [likingRoomIds, setLikingRoomIds] = useState<Set<number>>(new Set())
  const [likeMsg, setLikeMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [tokenCount, setTokenCount] = useState('1')
  const [tokenMonths, setTokenMonths] = useState('1')
  const [generatedTokens, setGeneratedTokens] = useState<string[]>([])
  const [tokenGenLoading, setTokenGenLoading] = useState(false)
  const [tokenGenError, setTokenGenError] = useState('')
  const [allTokens, setAllTokens] = useState<RenewalToken[]>([])
  const [showUsedTokens, setShowUsedTokens] = useState(false)

  const [defaultBots, setDefaultBots] = useState<DefaultBot[]>([])
  const [defaultBotsLoading, setDefaultBotsLoading] = useState(false)
  const [defaultBotMsg, setDefaultBotMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [qrUrl, setQrUrl] = useState('')
  const [qrStatus, setQrStatus] = useState('')
  const [qrStatusClass, setQrStatusClass] = useState<'' | 'success' | 'error'>('')
  const qrKeyRef = useRef<string | null>(null)
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 充值 modal 状态
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [rechargeBot, setRechargeBot] = useState<DefaultBot | null>(null)
  const [rechargeYuan, setRechargeYuan] = useState('30')
  const [rechargeChannel, setRechargeChannel] = useState<'qr' | 'cash'>('cash')
  const [rechargeStatus, setRechargeStatus] = useState('')
  const [rechargeLoading, setRechargeLoading] = useState(false)
  const rechargeOrderRef = useRef<string | null>(null)
  const rechargeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 人气票 modal 状态
  const [voteOpen, setVoteOpen] = useState(false)
  const [voteRoom, setVoteRoom] = useState<Room | null>(null)
  const [voteCount, setVoteCount] = useState('100')
  const [voteRemaining, setVoteRemaining] = useState<number | null>(null)
  const [votePerBotLimit, setVotePerBotLimit] = useState(200)
  const [voteAvailableBots, setVoteAvailableBots] = useState(0)
  const [voteStatus, setVoteStatus] = useState<{ type: 'info' | 'success' | 'warning' | 'error'; text: string } | null>(null)
  const [voteResult, setVoteResult] = useState<Awaited<ReturnType<typeof sendPopularityVote>> | null>(null)
  const [voteLoading, setVoteLoading] = useState(false)

  useEffect(() => { loadTokens() }, [])
  useEffect(() => { if (isAdmin) loadDefaultBots() }, [isAdmin])

  async function loadDefaultBots(force = false) {
    setDefaultBotsLoading(true)
    try { setDefaultBots(await listDefaultBots(force)) } catch { /* ignore */ }
    finally { setDefaultBotsLoading(false) }
  }

  const cleanupQr = useCallback(() => {
    if (qrTimerRef.current) {
      clearInterval(qrTimerRef.current)
      qrTimerRef.current = null
    }
    qrKeyRef.current = null
  }, [])

  function closeQr() {
    cleanupQr()
    setQrOpen(false)
  }

  async function openAddDefaultBot() {
    setDefaultBotMsg(null)
    setQrOpen(true)
    setQrUrl('')
    setQrStatus('加载中...')
    setQrStatusClass('')
    cleanupQr()
    try {
      const d = await fetchDefaultBotQrCode()
      if (d.error) {
        setQrStatus(d.error)
        setQrStatusClass('error')
        return
      }
      qrKeyRef.current = d.qrcode_key
      setQrUrl(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(d.url)}`)
      setQrStatus('请使用哔哩哔哩 APP 扫码')
      qrTimerRef.current = setInterval(async () => {
        if (!qrKeyRef.current) return
        try {
          const r = await pollDefaultBotQrLogin(qrKeyRef.current)
          if (r.code === 0) {
            setQrStatus(`绑定成功! ${r.name || ''} (UID: ${r.uid})`)
            setQrStatusClass('success')
            cleanupQr()
            await loadDefaultBots()
            window.setTimeout(() => setQrOpen(false), 1500)
          } else if (r.code === 86090) {
            setQrStatus('已扫码，请在手机上确认...')
          } else if (r.code === 86038) {
            setQrStatus('二维码已过期，请重新打开')
            setQrStatusClass('error')
            cleanupQr()
          }
        } catch { /* ignore */ }
      }, 2000)
    } catch {
      setQrStatus('获取二维码失败')
      setQrStatusClass('error')
    }
  }

  function cleanupRecharge() {
    if (rechargeTimerRef.current) {
      clearInterval(rechargeTimerRef.current)
      rechargeTimerRef.current = null
    }
    rechargeOrderRef.current = null
  }

  function closeRecharge() {
    cleanupRecharge()
    setRechargeOpen(false)
    setRechargeStatus('')
  }

  function openRecharge(b: DefaultBot) {
    cleanupRecharge()
    setRechargeBot(b)
    setRechargeYuan('30')
    setRechargeChannel('cash')
    setRechargeStatus('')
    setRechargeOpen(true)
  }

  async function handleSubmitRecharge() {
    if (!rechargeBot) return
    const yuan = Math.floor(Number(rechargeYuan))
    if (!Number.isFinite(yuan) || yuan < 1 || yuan > 1998) {
      setRechargeStatus('金额需在 1~1998 元')
      return
    }
    setRechargeLoading(true)
    setRechargeStatus('正在创建订单...')
    try {
      const r = await rechargeDefaultBot(rechargeBot.uid, yuan, rechargeChannel)
      rechargeOrderRef.current = r.order_id
      // 打开 B 站 支付页：QR 直接拿到的 url；cash 把 pay_center_params JSON
      // 编进 cashier-desk 的 ?params= 里。
      let payUrl = ''
      if (rechargeChannel === 'qr' && r.code_url) {
        payUrl = r.code_url
      } else if (rechargeChannel === 'cash' && r.pay_center_params) {
        const params = encodeURIComponent(JSON.stringify(r.pay_center_params))
        payUrl = `https://pay.bilibili.com/pay-v2-web/cashier/cashier-desk?params=${params}`
      } else {
        setRechargeStatus('B站没有返回支付链接，请重试')
        setRechargeLoading(false)
        return
      }
      window.open(payUrl, '_blank')
      setRechargeStatus('已打开 B 站支付页，请在新标签页完成支付。本窗口会自动检测')
      // 轮询订单状态：B 站 return status=1 是待支付，付完 ≠ 1（具体值实测）
      rechargeTimerRef.current = setInterval(async () => {
        if (!rechargeOrderRef.current || !rechargeBot) return
        try {
          const s = await queryRechargeStatus(rechargeBot.uid, rechargeOrderRef.current)
          if (s.status !== undefined && s.status !== 1) {
            setRechargeStatus(`支付完成（status=${s.status}），正在刷新电池...`)
            cleanupRecharge()
            await loadDefaultBots()
            setDefaultBotMsg({
              type: 'success',
              text: `「${rechargeBot.name || rechargeBot.uid}」充值 ${yuan} 元完成`,
            })
            window.setTimeout(() => setRechargeOpen(false), 1500)
          }
        } catch { /* 偶发查单失败不中断轮询 */ }
      }, 3000)
    } catch (err) {
      setRechargeStatus(`下单失败：${(err as Error).message}`)
    } finally {
      setRechargeLoading(false)
    }
  }

  async function openVote(r: Room) {
    setVoteRoom(r)
    setVoteCount('100')
    setVoteStatus(null)
    setVoteResult(null)
    setVoteRemaining(null)
    setVoteOpen(true)
    try {
      const q = await fetchPopularityQuota(r.room_id)
      setVoteRemaining(q.remaining)
      setVotePerBotLimit(q.per_bot_limit)
      setVoteAvailableBots(q.available_bot_count)
    } catch { /* ignore */ }
  }

  function closeVote() {
    setVoteOpen(false)
    setVoteStatus(null)
    setVoteResult(null)
  }

  async function handleSubmitVote() {
    if (!voteRoom) return
    const n = Math.floor(Number(voteCount))
    if (!Number.isFinite(n) || n < 100 || n % 100 !== 0) {
      setVoteStatus({ type: 'error', text: '数量必须是 100 的整数倍（最小 100）' })
      return
    }
    setVoteLoading(true)
    setVoteStatus({ type: 'info', text: '正在串行送出（多 bot 间有 2-4s 间隔，单 bot 内每 100 张为一批）...' })
    setVoteResult(null)
    try {
      const r = await sendPopularityVote(voteRoom.room_id, n)
      setVoteRemaining(r.total_remaining_this_hour)
      setVoteResult(r)
      const partial = r.sent < r.requested
      // partial 提到 warning 级别（黄色），完整成功才用 success 绿
      const head = partial
        ? `⚠ 请求 ${r.requested} 张，实际只送出 ${r.sent} 张`
        : `已送 ${r.sent} 张`
      const tail = r.aborted_by_cooling ? '（命中风控，已提前停）' : ''
      setVoteStatus({
        type: partial ? 'warning' : 'success',
        text: `${head}${tail}。本小时累计剩余 ${r.total_remaining_this_hour} 张`,
      })
    } catch (err) {
      setVoteStatus({ type: 'error', text: (err as Error).message })
    } finally {
      setVoteLoading(false)
    }
  }

  async function handleDeleteDefaultBot(uid: number, name: string) {
    if (!await confirmDialog({
      message: `确定删除默认机器人「${name || uid}」？删除后该 bot 不再参与批量点赞。`,
      danger: true, okText: '删除',
    })) return
    try {
      await deleteDefaultBot(uid)
      setDefaultBotMsg({ type: 'success', text: `已删除「${name || uid}」` })
      await loadDefaultBots()
    } catch (err) {
      setDefaultBotMsg({ type: 'error', text: (err as Error).message })
    }
  }

  useEffect(() => () => { cleanupQr(); cleanupRecharge() }, [cleanupQr])

  async function loadTokens() {
    try { setAllTokens(await listRenewalTokens()) } catch { /* ignore */ }
  }

  async function handleGenerateTokens() {
    setTokenGenError('')
    const c = Math.max(1, Math.min(100, parseInt(tokenCount, 10) || 1))
    const m = Math.max(1, Math.min(12, parseInt(tokenMonths, 10) || 1))
    setTokenGenLoading(true)
    try {
      const tokens = await createRenewalTokens(c, m)
      setGeneratedTokens(tokens)
      await loadTokens()
    } catch (err) {
      setTokenGenError((err as Error).message)
    } finally { setTokenGenLoading(false) }
  }

  async function copyToken(t: string) {
    try { await navigator.clipboard.writeText(t) } catch { /* ignore */ }
  }

  const unusedTokens = allTokens.filter((t) => !t.used_at)
  const usedTokens = allTokens.filter((t) => t.used_at)

  useEffect(() => { loadUsers() }, [])

  async function loadUsers() {
    try {
      setUsers(await fetchUsers())
    } catch { /* ignore */ }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    try {
      await createUser(email, password, role)
      setEmail('')
      setPassword('')
      setRole('user')
      loadUsers()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleDelete(userId: number) {
    if (!await confirmDialog({ message: '确定删除该用户？', danger: true, okText: '删除' })) return
    await deleteUser(userId)
    loadUsers()
  }

  function startEditRooms(user: UserInfo) {
    setEditingUser(user.id)
    setEditRooms([...user.rooms])
  }

  async function saveRooms() {
    if (editingUser === null) return
    await assignUserRooms(editingUser, editRooms)
    setEditingUser(null)
    loadUsers()
  }

  function toggleRoom(roomId: number) {
    setEditRooms((prev) =>
      prev.includes(roomId) ? prev.filter((r) => r !== roomId) : [...prev, roomId],
    )
  }

  async function handleAddRoom(e: React.FormEvent) {
    e.preventDefault()
    setRoomError('')
    const id = parseInt(newRoomId.trim(), 10)
    if (!id || isNaN(id)) {
      setRoomError('请输入有效房间号')
      return
    }
    setRoomLoading(true)
    try {
      await addRoom(id)
      setNewRoomId('')
      onRoomsChanged()
    } catch (err) {
      setRoomError((err as Error).message)
    } finally {
      setRoomLoading(false)
    }
  }

  async function handleLikeRoom(roomId: number, label: string) {
    if (likingRoomIds.has(roomId)) return
    if (!await confirmDialog({ message: `确定为「${label}」自动点赞？\n随机抽多个机器人集中点赞，保守频控、慢慢跑，约需 10–15 分钟`, okText: '自动点赞' })) return
    setLikingRoomIds((prev) => new Set(prev).add(roomId))
    setLikeMsg(null)
    try {
      const r = await triggerRoomLikes(roomId)
      const mins = Math.ceil(r.eta_seconds / 60)
      setLikeMsg({ type: 'success', text: `「${label}」已用 ${r.bot_count} 个机器人触发共 ${r.scheduled} 次点赞，预计 ${mins} 分钟跑完` })
      // 按钮锁到任务预计跑完 + 10s 兜底；服务端 _like_running 是真正的互斥
      window.setTimeout(() => {
        setLikingRoomIds((prev) => {
          const next = new Set(prev)
          next.delete(roomId)
          return next
        })
      }, (r.eta_seconds + 10) * 1000)
    } catch (err) {
      setLikingRoomIds((prev) => {
        const next = new Set(prev)
        next.delete(roomId)
        return next
      })
      setLikeMsg({ type: 'error', text: `「${label}」点赞失败：${(err as Error).message}` })
    }
  }

  async function handleRemoveRoom(roomId: number) {
    if (!await confirmDialog({ message: `确定删除房间 ${roomId}？`, danger: true, okText: '删除' })) return
    try {
      await removeRoom(roomId)
      onRoomsChanged()
    } catch (err) {
      setRoomError((err as Error).message)
    }
  }

  const roleData = [
    { label: '普通用户', value: 'user' },
    { label: '员工', value: 'staff' },
    { label: '管理员', value: 'admin' },
  ]

  function roleLabel(r: string): string {
    return r === 'admin' ? '管理员' : r === 'staff' ? '员工' : '普通用户'
  }

  async function handleChangeRole(userId: number, newRole: string) {
    try {
      await updateUserRole(userId, newRole)
      loadUsers()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="admin-panel">
      {/* ── Renewal tokens ── */}
      <h3 style={{ color: '#fb7299', marginBottom: 8, fontSize: 16 }}>续费码</h3>
      <div style={{ fontSize: 13, color: '#888', marginBottom: 12, lineHeight: 1.6 }}>
        一码一用，用户在「续费机器人」里填进去就能给房间延长到期时间。<br />
        <b>数量</b>：这次生成几条码（1–100）；<b>月数</b>：每条码能把房间延长几个月（1–12，每月按 30 天算）。
      </div>
      <Stack spacing={8} wrap style={{ marginBottom: 12 }}>
        <InputGroup size="sm" style={{ width: 120 }}>
          <InputGroup.Addon>数量</InputGroup.Addon>
          <Input value={tokenCount} onChange={setTokenCount} />
        </InputGroup>
        <InputGroup size="sm" style={{ width: 120 }}>
          <InputGroup.Addon>月数</InputGroup.Addon>
          <Input value={tokenMonths} onChange={setTokenMonths} />
        </InputGroup>
        <Button appearance="primary" size="sm" loading={tokenGenLoading} onClick={handleGenerateTokens}>
          生成续费码
        </Button>
      </Stack>
      {tokenGenError && <Message type="error" showIcon style={{ marginBottom: 12 }}>{tokenGenError}</Message>}
      {generatedTokens.length > 0 && (
        <div style={{ marginBottom: 16, padding: 12, background: '#14141f', border: '1px solid #2a2a4a', borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>新生成的续费码（一码一用，各自延长 {tokenMonths || 1} 个月）：</div>
          {generatedTokens.map((t) => (
            <div key={t} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <code style={{ flex: 1, fontSize: 13, color: '#ffd54f', wordBreak: 'break-all' }}>{t}</code>
              <Button size="xs" appearance="subtle" onClick={() => copyToken(t)}>复制</Button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: 14, color: '#ccc' }}>未使用 {unusedTokens.length} 张</span>
        <span style={{ fontSize: 12, color: '#666' }}>已使用 {usedTokens.length} 张</span>
        <Button appearance="subtle" size="xs" onClick={() => setShowUsedTokens((v) => !v)}>
          {showUsedTokens ? '只看未使用' : '显示已使用'}
        </Button>
      </div>
      <div style={{ marginBottom: 16, maxHeight: 260, overflowY: 'auto', padding: 8, background: '#14141f', border: '1px solid #2a2a4a', borderRadius: 6 }}>
        {(showUsedTokens ? allTokens : unusedTokens).length === 0 ? (
          <div style={{ fontSize: 12, color: '#666', padding: 4 }}>暂无{showUsedTokens ? '续费码' : '未使用的续费码'}</div>
        ) : (
          (showUsedTokens ? allTokens : unusedTokens).map((t) => (
            <div key={t.token} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, fontSize: 12 }}>
              <code style={{ flex: 1, color: t.used_at ? '#666' : '#ffd54f', wordBreak: 'break-all', textDecoration: t.used_at ? 'line-through' : 'none' }}>{t.token}</code>
              <span style={{ color: '#888', whiteSpace: 'nowrap' }}>
                {t.months} 月
                {t.used_at
                  ? ` · 已用于房间 ${t.used_for_room_id}`
                  : ` · ${(t.created_at || '').slice(0, 10)} 生成`}
              </span>
              {!t.used_at && <Button size="xs" appearance="subtle" onClick={() => copyToken(t.token)}>复制</Button>}
            </div>
          ))
        )}
      </div>
      {isAdmin && <>
        <Divider />

        {/* ── Room management ── */}
        <h3 style={{ color: '#fb7299', marginBottom: 16, fontSize: 16 }}>房间管理</h3>
        <form onSubmit={handleAddRoom}>
          <Stack spacing={8} wrap style={{ marginBottom: 16 }}>
            <Input
              placeholder="房间号"
              value={newRoomId}
              onChange={setNewRoomId}
              size="sm"
              style={{ width: 160 }}
            />
            <Button type="submit" appearance="primary" size="sm" loading={roomLoading}>
              添加房间
            </Button>
          </Stack>
        </form>
        {roomError && <Message type="error" showIcon style={{ marginBottom: 12 }}>{roomError}</Message>}
        {likeMsg && <Message type={likeMsg.type} showIcon closable onClose={() => setLikeMsg(null)} style={{ marginBottom: 12 }}>{likeMsg.text}</Message>}
        <div className="admin-grid">
          {rooms.map((r) => (
            <div key={r.room_id} className="admin-card">
              <div className="admin-card-head">
                <div className="admin-card-title" title={r.streamer_name || String(r.room_id)}>
                  {r.streamer_name || r.room_id}
                </div>
              </div>
              <div className="admin-card-meta">
                房间号: {r.room_id}
                {r.real_room_id !== r.room_id && <> · 真实 ID: {r.real_room_id}</>}
                <br />
                机器人: {r.bot_uid ? `${r.bot_name || 'Unknown'} (UID ${r.bot_uid})` : '未绑定'}
              </div>
              <div className="admin-card-actions">
                <Button
                  appearance="ghost"
                  size="xs"
                  loading={likingRoomIds.has(r.room_id)}
                  disabled={!r.bot_uid || likingRoomIds.has(r.room_id)}
                  onClick={() => handleLikeRoom(r.room_id, r.streamer_name || String(r.room_id))}
                >
                  自动点赞
                </Button>
                <Button appearance="ghost" size="xs" onClick={() => openVote(r)}>
                  人气票
                </Button>
                <Button color="red" appearance="ghost" size="xs" onClick={() => handleRemoveRoom(r.room_id)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
          {rooms.length === 0 && (
            <div className="admin-card-meta" style={{ gridColumn: '1 / -1' }}>暂无房间</div>
          )}
        </div>

        <Divider style={{ borderColor: '#2a2a4a' }} />

        {/* ── Default bots ── */}
        <h3 style={{ color: '#fb7299', marginBottom: 8, fontSize: 16 }}>默认机器人</h3>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 12, lineHeight: 1.6 }}>
          不绑定具体房间的 bot 池，扫码登录后参与批量点赞等跨房间动作。
          每次「自动点赞」会从「房间机器人 + 默认机器人」里随机抽 5 个集中刷。
        </div>
        <Stack spacing={8} style={{ marginBottom: 12 }}>
          <Button appearance="primary" size="sm" onClick={openAddDefaultBot}>
            扫码添加机器人
          </Button>
          <Button
            appearance="ghost" size="sm"
            loading={defaultBotsLoading}
            onClick={() => loadDefaultBots(true)}
          >
            刷新电池
          </Button>
        </Stack>
        {defaultBotMsg && (
          <Message
            type={defaultBotMsg.type}
            showIcon closable
            onClose={() => setDefaultBotMsg(null)}
            style={{ marginBottom: 12 }}
          >
            {defaultBotMsg.text}
          </Message>
        )}
        <div className="admin-grid">
          {defaultBots.map((b) => {
            const status = b.needs_relogin ? '需重扫' : b.cooling ? '风控冷却' : b.in_memory ? '在线' : '未加载'
            const statusColor = b.needs_relogin ? '#fb7299' : b.cooling ? '#ffb74d' : b.in_memory ? '#7cd97e' : '#888'
            return (
              <div key={b.uid} className="admin-card">
                <div className="admin-card-head">
                  <div className="admin-card-title" title={b.name || String(b.uid)}>
                    {b.name || `UID ${b.uid}`}
                  </div>
                  <span style={{ fontSize: 11, color: statusColor }}>{status}</span>
                </div>
                <div className="admin-card-meta">
                  UID: {b.uid}
                  <br />
                  电池: {b.battery === null ? '?' : b.battery.toLocaleString()}
                  <br />
                  添加时间: {(b.created_at || '').slice(0, 16)}
                </div>
                <div className="admin-card-actions">
                  <Button
                    appearance="ghost" size="xs"
                    disabled={!b.in_memory}
                    onClick={() => openRecharge(b)}
                  >
                    充值
                  </Button>
                  <Button
                    color="red" appearance="ghost" size="xs"
                    onClick={() => handleDeleteDefaultBot(b.uid, b.name)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            )
          })}
          {defaultBots.length === 0 && (
            <div className="admin-card-meta" style={{ gridColumn: '1 / -1' }}>暂无默认机器人</div>
          )}
        </div>

        <Divider style={{ borderColor: '#2a2a4a' }} />

        {/* ── User management ── */}
        <h3 style={{ color: '#fb7299', marginBottom: 16, fontSize: 16 }}>用户管理</h3>

        <form onSubmit={handleCreate}>
          <Stack spacing={8} wrap style={{ marginBottom: 16 }}>
            <Input
              type="email"
              placeholder="邮箱"
              value={email}
              onChange={setEmail}
              size="sm"
              style={{ width: 160 }}
            />
            <Input
              type="password"
              placeholder="密码"
              value={password}
              onChange={setPassword}
              size="sm"
              style={{ width: 140 }}
            />
            <SelectPicker
              data={roleData}
              value={role}
              onChange={(v) => v && setRole(v)}
              size="sm"
              searchable={false}
              cleanable={false}
              style={{ width: 160 }}
            />
            <Button type="submit" appearance="primary" size="sm">创建用户</Button>
          </Stack>
        </form>
        {error && <Message type="error" showIcon style={{ marginBottom: 12 }}>{error}</Message>}

        <div className="admin-grid">
          {users.map((u) => (
            <div key={u.id} className="admin-card">
              <div className="admin-card-head">
                <div className="admin-card-title" title={u.email}>{u.email}</div>
                <span className={`admin-card-badge ${u.role}`}>{roleLabel(u.role)}</span>
              </div>
              <div className="admin-card-meta">
                {u.role === 'admin' ? (
                  '可见全部房间'
                ) : u.rooms.length > 0 ? (
                  <>
                    <div style={{ marginBottom: 6 }}>绑定房间 ({u.rooms.length})</div>
                    <div className="admin-room-tags">
                      {u.rooms.map((rid) => {
                        const r = rooms.find((x) => x.room_id === rid)
                        const name = r?.streamer_name || ''
                        return (
                          <span key={rid} className="admin-room-tag" title={name ? `${name} (${rid})` : String(rid)}>
                            {name ? `${name} · ${rid}` : rid}
                          </span>
                        )
                      })}
                    </div>
                  </>
                ) : (
                  '绑定房间：无'
                )}
              </div>
              <div className="admin-card-actions">
                <SelectPicker
                  data={roleData}
                  value={u.role}
                  onChange={(v) => v && v !== u.role && handleChangeRole(u.id, v)}
                  size="sm"
                  searchable={false}
                  cleanable={false}
                  className="admin-user-role"
                />
                {u.role !== 'admin' && (
                  <Button appearance="ghost" size="xs" onClick={() => startEditRooms(u)}>
                    分配房间
                  </Button>
                )}
                <Button color="red" appearance="ghost" size="xs" onClick={() => handleDelete(u.id)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
          {users.length === 0 && (
            <div className="admin-card-meta" style={{ gridColumn: '1 / -1' }}>暂无用户</div>
          )}
        </div>
      </>}

      {/* 人气票 modal */}
      <Modal open={voteOpen} onClose={closeVote} size="xs">
        <Modal.Header>
          <Modal.Title>
            送人气票 → {voteRoom?.streamer_name || voteRoom?.room_id}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 12, lineHeight: 1.6 }}>
            按"每 bot 每房间每小时 {votePerBotLimit} 张"的 B 站限制把数量拆到多个默认 bot 上**串行**送出。
            数量必须是 100 的整数倍（最小 100）。
            {voteRemaining !== null && (
              <>
                <br />
                <span style={{ color: '#7cd97e' }}>
                  本小时累计可送：{voteRemaining} 张
                  （{voteAvailableBots} 个可用 bot × {votePerBotLimit}/小时，未扣电池）
                </span>
              </>
            )}
          </div>
          <Stack spacing={8} wrap style={{ marginBottom: 12 }}>
            <InputGroup size="sm" style={{ width: 200 }}>
              <InputGroup.Addon>数量（张）</InputGroup.Addon>
              <Input
                value={voteCount}
                onChange={setVoteCount}
                onBlur={() => {
                  // blur 时把非整百自动 round 到最近的 100 倍数（最少 100），
                  // 避免用户手输 250 / 99 这种被 submit 校验拦掉
                  const n = Math.round(Number(voteCount) / 100) * 100
                  setVoteCount(String(Math.max(100, n || 100)))
                }}
                type="number"
                step={100}
                min={100}
              />
            </InputGroup>
          </Stack>
          {voteStatus && (
            <Message
              type={voteStatus.type}
              showIcon
              style={{ marginBottom: 8 }}
            >
              {voteStatus.text}
            </Message>
          )}
          {voteResult && (voteResult.bots.length > 0 || voteResult.failures.length > 0) && (
            <div style={{ fontSize: 12, lineHeight: 1.7, padding: 8, background: '#14141f', border: '1px solid #2a2a4a', borderRadius: 4 }}>
              {voteResult.bots.map((b) => (
                <div key={`ok-${b.uid}`} style={{ color: '#7cd97e' }}>
                  ✓ {b.name || b.uid} 送出 {b.sent} 张
                </div>
              ))}
              {voteResult.failures.map((f) => (
                <div key={`fail-${f.uid}`} style={{ color: f.cooling ? '#fb7299' : '#ffb74d' }}>
                  {f.cooling ? '⛔' : '⚠'} {f.name || f.uid} 计划 {f.tried} 张 / 实送 {f.sent} 张 — {f.error}
                </div>
              ))}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={closeVote} appearance="subtle">关闭</Button>
          <Button
            onClick={handleSubmitVote}
            appearance="primary"
            loading={voteLoading}
            disabled={voteRemaining === 0}
          >
            立即送出
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Default bot recharge modal */}
      <Modal open={rechargeOpen} onClose={closeRecharge} size="xs">
        <Modal.Header>
          <Modal.Title>
            充值「{rechargeBot?.name || rechargeBot?.uid}」
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 12, lineHeight: 1.6 }}>
            后端用 bot cookie 调 B 站接口下单，新标签页打开 B 站支付页面付款。
            付款完成后本窗口会自动检测并刷新电池数。
          </div>
          <Stack spacing={8} wrap style={{ marginBottom: 12 }}>
            <InputGroup size="sm" style={{ width: 160 }}>
              <InputGroup.Addon>金额（元）</InputGroup.Addon>
              <Input value={rechargeYuan} onChange={setRechargeYuan} />
            </InputGroup>
            <SelectPicker
              data={[
                { label: '微信 / 支付宝（扫码）', value: 'qr' },
                { label: 'PayPal / 信用卡', value: 'cash' },
              ]}
              value={rechargeChannel}
              onChange={(v) => v && setRechargeChannel(v as 'qr' | 'cash')}
              size="sm"
              searchable={false}
              cleanable={false}
              style={{ width: 220 }}
            />
          </Stack>
          {rechargeStatus && (
            <div style={{ fontSize: 12, color: '#aaa', padding: 8, background: '#14141f', borderRadius: 4 }}>
              {rechargeStatus}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={closeRecharge} appearance="subtle">关闭</Button>
          <Button
            onClick={handleSubmitRecharge}
            appearance="primary"
            loading={rechargeLoading}
          >
            立即充值
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Default bot QR modal */}
      <Modal open={qrOpen} onClose={closeQr} size="xs">
        <Modal.Header>
          <Modal.Title>添加默认机器人</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ textAlign: 'center' }}>
          <p style={{ color: '#aaa', marginBottom: 16 }}>使用哔哩哔哩 APP 扫描二维码登录</p>
          <div className="qr-container">
            {qrUrl && <img src={qrUrl} alt="二维码" />}
          </div>
          <div className={`qr-status ${qrStatusClass}`}>{qrStatus}</div>
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={closeQr} appearance="subtle">关闭</Button>
        </Modal.Footer>
      </Modal>

      {/* Edit rooms modal */}
      <Modal open={editingUser !== null} onClose={() => setEditingUser(null)} size="xs">
        <Modal.Header>
          <Modal.Title>分配房间</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {rooms.map((r) => (
            <Checkbox
              key={r.room_id}
              checked={editRooms.includes(r.room_id)}
              onChange={() => toggleRoom(r.room_id)}
            >
              {r.streamer_name || r.room_id} ({r.room_id})
            </Checkbox>
          ))}
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={() => setEditingUser(null)} appearance="subtle">取消</Button>
          <Button onClick={saveRooms} appearance="primary">保存</Button>
        </Modal.Footer>
      </Modal>
    </div>
  )
}
