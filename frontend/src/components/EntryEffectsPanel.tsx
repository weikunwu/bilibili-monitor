import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Input, InputGroup, InputPicker, Button, Modal, Table, Toggle, IconButton, Message, useToaster,
} from 'rsuite'
import CopyIcon from '@rsuite/icons/Copy'
import VisibleIcon from '@rsuite/icons/Visible'
import ReloadIcon from '@rsuite/icons/Reload'
import TrashIcon from '@rsuite/icons/Trash'
import PlusIcon from '@rsuite/icons/Plus'
import {
  fetchEntryEffects, uploadEntryEffect, deleteEntryEffect, fetchRoomUsers,
  fetchEntryEffectSettings, updateEntryEffectSettings,
  fetchOverlayToken, rotateOverlayToken, type EntryEffect,
} from '../api/client'
import { useIsMobile } from '../hooks/useIsMobile'
import { confirmDialog } from '../lib/confirm'

interface Props {
  roomId: number
}

const { Column, HeaderCell, Cell } = Table

const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_EXT = ['.mp4', '.webm']

function Section({
  title, description, children, isMobile,
}: { title: string; description?: string; children: React.ReactNode; isMobile: boolean }) {
  return (
    <div
      style={{
        background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 10,
        padding: isMobile ? '14px 14px' : '16px 20px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: description ? 4 : 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#e8e8e8' }}>{title}</div>
      </div>
      {description && (
        <div style={{ fontSize: 12, color: '#888', lineHeight: 1.6, marginBottom: 12 }}>{description}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  )
}

export function EntryEffectsPanel({ roomId }: Props) {
  const toaster = useToaster()
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<EntryEffect[]>([])
  const [loading, setLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [soundOn, setSoundOn] = useState(false)
  const [giftTestOn, setGiftTestOn] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await fetchEntryEffects(roomId)) } finally { setLoading(false) }
  }, [roomId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    let cancelled = false
    fetchOverlayToken(roomId).then((t) => { if (!cancelled) setToken(t) }).catch(() => {})
    fetchEntryEffectSettings(roomId).then((s) => {
      if (cancelled) return
      setSoundOn(!!s.sound_on)
      setGiftTestOn(!!s.gift_effect_test_enabled)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [roomId])

  const url = token ? `${window.location.origin}/overlay/${roomId}/entry-effects?token=${token}` : ''

  async function handleToggleSound(on: boolean) {
    setSoundOn(on)
    try { await updateEntryEffectSettings(roomId, { sound_on: on }) } catch { setSoundOn(!on) }
  }

  async function handleToggleGiftTest(on: boolean) {
    setGiftTestOn(on)
    try { await updateEntryEffectSettings(roomId, { gift_effect_test_enabled: on }) }
    catch { setGiftTestOn(!on) }
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  async function rotate() {
    if (!await confirmDialog({ message: '重新生成 token 会让该房间所有 OBS 叠加链接（礼物流 / 进场特效）失效，确认？', danger: true, okText: '重新生成' })) return
    setRotating(true)
    try {
      const t = await rotateOverlayToken(roomId)
      setToken(t)
    } finally { setRotating(false) }
  }

  async function handleDelete(r: EntryEffect) {
    if (!await confirmDialog({ message: `删除 ${r.user_name || `UID ${r.uid}`} 的进场特效？`, danger: true, okText: '删除' })) return
    try {
      await deleteEntryEffect(roomId, r.id)
      await load()
    } catch (err) {
      toaster.push(<Message type="error" showIcon closable>{(err as Error).message}</Message>, { duration: 3000 })
    }
  }

  return (
    <div>
      <div className="panel-title">进场&礼物特效</div>
      <div style={{ padding: isMobile ? '0 12px 20px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        <Section
          isMobile={isMobile}
          title="OBS 浏览器源链接"
          description="把此链接作为 OBS 浏览器源，观众进直播间时若匹配到已绑定 UID，自动播放对应视频。同一用户 5 分钟冷却一次。注意在 OBS 里取消静音才能听到声音。"
        >
          <InputGroup size="sm" inside>
            <Input readOnly value={url} placeholder="加载中…" />
            <InputGroup.Button onClick={copy} disabled={!url} title="复制链接">
              <CopyIcon style={{ fontSize: 14 }} /> {copied ? '已复制' : '复制'}
            </InputGroup.Button>
            <InputGroup.Button onClick={() => url && window.open(url, '_blank')} disabled={!url} title="打开预览">
              <VisibleIcon style={{ fontSize: 14 }} /> 预览
            </InputGroup.Button>
          </InputGroup>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Toggle size="sm" checked={soundOn} onChange={handleToggleSound} />
              <span style={{ fontSize: 13, color: '#ccc' }}>OBS 里播放声音</span>
              <span style={{ fontSize: 12, color: '#666' }}>
                （默认静音；需 OBS 允许音频自动播放）
              </span>
            </div>
            <Button appearance="subtle" size="sm" startIcon={<ReloadIcon />} onClick={rotate} loading={rotating}>
              重新生成 token
            </Button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Toggle size="sm" checked={giftTestOn} onChange={handleToggleGiftTest} />
            <span style={{ fontSize: 13, color: '#ccc' }}>礼物特效测试</span>
            <span style={{ fontSize: 12, color: '#666' }}>
              （打开后，任意人发弹幕「礼物特效测试&lt;gift_id&gt;」，如「礼物特效测试35560」，OBS 叠加页会播放该礼物的全屏 VAP）
            </span>
          </div>
        </Section>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 12, color: '#888' }}>
            每个 UID 仅保留一个视频（再次上传会覆盖）。
          </div>
          <Button size="sm" appearance="primary" startIcon={<PlusIcon />} onClick={() => setShowAdd(true)}>
            新增
          </Button>
        </div>
        <Table data={rows} autoHeight loading={loading} rowKey="id" rowHeight={96}>
            <Column flexGrow={2}>
              <HeaderCell>用户</HeaderCell>
              <Cell>
                {(r: EntryEffect) => <span>{r.user_name || `UID ${r.uid}`}</span>}
              </Cell>
            </Column>
            <Column flexGrow={1}>
              <HeaderCell>UID</HeaderCell>
              <Cell dataKey="uid" />
            </Column>
            <Column flexGrow={1}>
              <HeaderCell>大小</HeaderCell>
              <Cell>
                {(r: EntryEffect) => <span>{(r.size_bytes / 1024 / 1024).toFixed(2)} MB</span>}
              </Cell>
            </Column>
            <Column flexGrow={2}>
              <HeaderCell>预览</HeaderCell>
              <Cell style={{ padding: 4 }}>
                {(r: EntryEffect) => (
                  <video
                    src={`/api/rooms/${r.room_id}/entry-effects/${r.id}/video`}
                    controls
                    preload="none"
                    style={{ maxHeight: 80, maxWidth: 160, background: '#000', borderRadius: 4 }}
                  />
                )}
              </Cell>
            </Column>
            <Column flexGrow={2}>
              <HeaderCell>上传时间</HeaderCell>
              <Cell dataKey="created_at" />
            </Column>
            <Column width={80}>
              <HeaderCell>操作</HeaderCell>
              <Cell>
                {(r: EntryEffect) => (
                  <IconButton size="xs" icon={<TrashIcon />} onClick={() => handleDelete(r)} />
                )}
              </Cell>
            </Column>
          </Table>
      </div>

      {showAdd && (
        <AddModal
          roomId={roomId}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load() }}
        />
      )}
    </div>
  )
}

function AddModal({
  roomId, onClose, onSaved,
}: { roomId: number; onClose: () => void; onSaved: () => void }) {
  const toaster = useToaster()
  const [users, setUsers] = useState<{ user_id: number; user_name: string }[]>([])
  const [userId, setUserId] = useState<number | null>(null)
  const [userName, setUserName] = useState('')
  const [manualUid, setManualUid] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function search(s: string) {
    try {
      const list = await fetchRoomUsers(roomId, s)
      setUsers(list)
    } catch { /* ignore */ }
  }

  useEffect(() => { search('') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    if (!f) { setFile(null); return }
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
    if (!ALLOWED_EXT.includes(ext)) {
      setError(`只支持 ${ALLOWED_EXT.join('/')}`)
      setFile(null)
      return
    }
    if (f.size > MAX_BYTES) {
      setError(`文件超过 ${MAX_BYTES / 1024 / 1024}MB`)
      setFile(null)
      return
    }
    setError('')
    setFile(f)
  }

  async function handleSave() {
    const uid = userId || parseInt(manualUid.trim(), 10)
    if (!uid || isNaN(uid)) { setError('请选择或输入 UID'); return }
    if (!file) { setError('请选视频文件'); return }
    setSaving(true)
    setError('')
    try {
      await uploadEntryEffect(roomId, uid, userName, file)
      toaster.push(<Message type="success" showIcon closable>上传成功</Message>, { duration: 2000 })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} size="xs">
      <Modal.Header><Modal.Title>新增进场特效</Modal.Title></Modal.Header>
      <Modal.Body>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>选择房间访客</div>
            <InputPicker
              data={users.map((u) => ({ label: `${u.user_name} (${u.user_id})`, value: u.user_id, name: u.user_name }))}
              value={userId}
              onChange={(v) => {
                setUserId(v as number | null)
                const hit = users.find((u) => u.user_id === v)
                setUserName(hit?.user_name || '')
                if (v) setManualUid('')
              }}
              onSearch={search}
              placeholder="搜索用户"
              block
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>或手动填 UID</div>
            <Input value={manualUid} onChange={(v) => { setManualUid(v); if (v) setUserId(null) }} placeholder="手动输入 UID" />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>视频文件（mp4/webm，≤ 10MB）</div>
            <input ref={fileRef} type="file" accept=".mp4,.webm,video/mp4,video/webm" onChange={onPick} />
            {file && <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>已选：{file.name}（{(file.size / 1024 / 1024).toFixed(2)}MB）</div>}
          </div>
          {error && <Message type="error" showIcon>{error}</Message>}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} appearance="subtle" disabled={saving}>取消</Button>
        <Button onClick={handleSave} appearance="primary" loading={saving} disabled={!file || (!userId && !manualUid.trim())}>
          上传
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
