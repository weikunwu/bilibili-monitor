import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Input, InputGroup, InputPicker, Button, Modal, Nav, Table, Toggle, IconButton, Message, useToaster,
} from 'rsuite'
import CopyIcon from '@rsuite/icons/Copy'
import VisibleIcon from '@rsuite/icons/Visible'
import ReloadIcon from '@rsuite/icons/Reload'
import TrashIcon from '@rsuite/icons/Trash'
import PlusIcon from '@rsuite/icons/Plus'
import EditIcon from '@rsuite/icons/Edit'
import {
  fetchEntryEffects, uploadEntryEffect, bindEntryEffectPreset, deleteEntryEffect, fetchRoomUsers,
  fetchEffectSettings, updateEffectSettings,
  fetchOverlayToken, rotateOverlayToken, type EntryEffect,
} from '../api/client'
import { useIsMobile } from '../hooks/useIsMobile'
import { confirmDialog } from '../lib/confirm'
import { ENTRY_PRESETS, PRESET_LABEL } from '../lib/effectPresets'

interface Props {
  roomId: number
}

const { Column, HeaderCell, Cell } = Table

const MAX_BYTES = 100 * 1024 * 1024
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

export function EffectsPanel({ roomId }: Props) {
  const toaster = useToaster()
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<EntryEffect[]>([])
  const [loading, setLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<EntryEffect | null>(null)
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
    fetchEffectSettings(roomId).then((s) => {
      if (cancelled) return
      setSoundOn(!!s.sound_on)
      setGiftTestOn(!!s.gift_effect_test_enabled)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [roomId])

  const url = token ? `${window.location.origin}/overlay/${roomId}/effects?token=${token}` : ''

  async function handleToggleSound(on: boolean) {
    setSoundOn(on)
    try { await updateEffectSettings(roomId, { sound_on: on }) } catch { setSoundOn(!on) }
  }

  async function handleToggleGiftTest(on: boolean) {
    setGiftTestOn(on)
    try { await updateEffectSettings(roomId, { gift_effect_test_enabled: on }) }
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
    if (!await confirmDialog({ message: '重新生成 token 会让该房间所有叠加链接（礼物流 / 进场特效）失效，确认？', danger: true, okText: '重新生成' })) return
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
          title="浏览器源链接"
          description="把此链接作为浏览器源，观众进直播间时若匹配到已绑定 UID，自动播放对应视频。同一用户 5 分钟冷却一次。注意在浏览器里取消静音才能听到声音。"
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
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button appearance="subtle" size="sm" startIcon={<ReloadIcon />} onClick={rotate} loading={rotating}>
              重新生成 token
            </Button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Toggle size="sm" checked={soundOn} onChange={handleToggleSound} />
            <span style={{ fontSize: 13, color: '#ccc' }}>播放声音</span>
            <span style={{ fontSize: 12, color: '#666' }}>
              （默认静音；需浏览器允许音频自动播放）
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Toggle size="sm" checked={giftTestOn} onChange={handleToggleGiftTest} />
            <span style={{ fontSize: 13, color: '#ccc' }}>礼物特效测试</span>
            <span style={{ fontSize: 12, color: '#666' }}>
              （打开后，任意人发弹幕「礼物特效测试&lt;gift_id&gt;」，如「礼物特效测试35560」，叠加页会播放该礼物的全屏 VAP）
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
        {isMobile ? (
          <div className="effect-cards">
            {rows.length === 0 ? (
              <div className="empty">{loading ? '加载中...' : '暂无进场特效'}</div>
            ) : rows.map((r) => (
              <div className="effect-card" key={r.id}>
                <div className="effect-card-head">
                  <div className="effect-card-user">
                    <div className="effect-card-name">{r.user_name || `UID ${r.uid}`}</div>
                    <div className="effect-card-meta">
                      UID {r.uid} · {r.preset_key
                        ? `预设：${PRESET_LABEL[r.preset_key] || r.preset_key}`
                        : `${(r.size_bytes / 1024 / 1024).toFixed(2)} MB`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <IconButton size="sm" icon={<EditIcon />} onClick={() => setEditing(r)} />
                    <IconButton size="sm" icon={<TrashIcon />} onClick={() => handleDelete(r)} />
                  </div>
                </div>
                {r.preset_key ? (
                  <div className="effect-card-preset">
                    {PRESET_LABEL[r.preset_key] || r.preset_key}
                  </div>
                ) : (
                  <video
                    src={`/api/rooms/${r.room_id}/effects/entries/${r.id}/video`}
                    controls
                    preload="none"
                    className="effect-card-video"
                  />
                )}
                <div className="effect-card-time">{r.created_at}</div>
              </div>
            ))}
          </div>
        ) : (
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
              <HeaderCell>类型</HeaderCell>
              <Cell>
                {(r: EntryEffect) => (
                  <span>
                    {r.preset_key
                      ? `预设 · ${PRESET_LABEL[r.preset_key] || r.preset_key}`
                      : `${(r.size_bytes / 1024 / 1024).toFixed(2)} MB`}
                  </span>
                )}
              </Cell>
            </Column>
            <Column flexGrow={2}>
              <HeaderCell>预览</HeaderCell>
              <Cell style={{ padding: 4 }}>
                {(r: EntryEffect) => (
                  r.preset_key ? (
                    <span style={{ color: '#888' }}>—</span>
                  ) : (
                    <video
                      src={`/api/rooms/${r.room_id}/effects/entries/${r.id}/video`}
                      controls
                      preload="none"
                      style={{ maxHeight: 80, maxWidth: 160, background: '#000', borderRadius: 4 }}
                    />
                  )
                )}
              </Cell>
            </Column>
            <Column flexGrow={2}>
              <HeaderCell>上传时间</HeaderCell>
              <Cell dataKey="created_at" />
            </Column>
            <Column width={120}>
              <HeaderCell>操作</HeaderCell>
              <Cell>
                {(r: EntryEffect) => (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <IconButton size="xs" icon={<EditIcon />} onClick={() => setEditing(r)} />
                    <IconButton size="xs" icon={<TrashIcon />} onClick={() => handleDelete(r)} />
                  </div>
                )}
              </Cell>
            </Column>
          </Table>
        )}
      </div>

      {showAdd && (
        <EffectModal
          roomId={roomId}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load() }}
        />
      )}
      {editing && (
        <EffectModal
          roomId={roomId}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function EffectModal({
  roomId, initial, onClose, onSaved,
}: {
  roomId: number
  initial?: EntryEffect | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial
  const toaster = useToaster()
  const [users, setUsers] = useState<{ user_id: number; user_name: string }[]>([])
  const [userId, setUserId] = useState<number | null>(initial?.uid ?? null)
  const [userName, setUserName] = useState(initial?.user_name ?? '')
  const [mode, setMode] = useState<'preset' | 'upload'>(
    initial?.preset_key ? 'preset' : initial ? 'upload' : 'preset',
  )
  const [presetKey, setPresetKey] = useState<string>(
    initial?.preset_key || ENTRY_PRESETS[0]?.key || '',
  )
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

  useEffect(() => { if (!isEdit) search('') }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!userId) { setError('请选择用户'); return }
    setSaving(true)
    setError('')
    try {
      if (mode === 'upload') {
        if (!file) { setError('请选视频文件'); setSaving(false); return }
        await uploadEntryEffect(roomId, userId, userName, file)
      } else {
        if (!presetKey) { setError('请选择预设动画'); setSaving(false); return }
        await bindEntryEffectPreset(roomId, userId, userName, presetKey)
      }
      toaster.push(<Message type="success" showIcon closable>保存成功</Message>, { duration: 2000 })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // 编辑模式 + 上传 tab：必须重新选文件才能保存（无法只“保留旧视频”）；
  // 编辑模式 + 预设 tab：可以直接保存，因为切到不同预设或同一预设都会写一次。
  const canSave = !!userId && (mode === 'preset' ? !!presetKey : !!file)

  return (
    <Modal open onClose={onClose} size="sm">
      <Modal.Header>
        <Modal.Title>{isEdit ? '编辑进场特效' : '新增进场特效'}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
              {isEdit ? '用户' : '选择房间访客'}
            </div>
            {isEdit ? (
              <div style={{ color: '#ddd', fontSize: 14 }}>
                {initial?.user_name || '未知昵称'}
                <span style={{ color: '#888', marginLeft: 8 }}>UID {initial?.uid}</span>
              </div>
            ) : (
              <InputPicker
                data={users.map((u) => ({ label: `${u.user_name} (${u.user_id})`, value: u.user_id, name: u.user_name }))}
                value={userId}
                onChange={(v) => {
                  setUserId(v as number | null)
                  const hit = users.find((u) => u.user_id === v)
                  setUserName(hit?.user_name || '')
                }}
                onSearch={search}
                placeholder="搜索用户"
                block
              />
            )}
          </div>
          <Nav appearance="subtle" activeKey={mode} onSelect={(k) => setMode(k as 'preset' | 'upload')}>
            <Nav.Item eventKey="preset">预设动画</Nav.Item>
            <Nav.Item eventKey="upload">上传文件</Nav.Item>
          </Nav>
          {mode === 'preset' ? (
            <div className="preset-grid">
              {ENTRY_PRESETS.map((p) => (
                <div
                  key={p.key}
                  className={`preset-card${presetKey === p.key ? ' selected' : ''}`}
                  onClick={() => setPresetKey(p.key)}
                >
                  <div className="preset-card-thumb">
                    <p.Component userName={userName || '观众'} loop mini />
                  </div>
                  <div className="preset-card-label">
                    <p.Icon size={14} />
                    {p.label}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>视频文件（mp4/webm，≤ 100MB）</div>
              {isEdit && initial?.video_filename && !file && (
                <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>
                  当前已绑定一个视频；选新文件后保存会覆盖。
                </div>
              )}
              <input ref={fileRef} type="file" accept=".mp4,.webm,video/mp4,video/webm" onChange={onPick} />
              {file && <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>已选：{file.name}（{(file.size / 1024 / 1024).toFixed(2)}MB）</div>}
            </div>
          )}
          {error && <Message type="error" showIcon>{error}</Message>}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} appearance="subtle" disabled={saving}>取消</Button>
        <Button onClick={handleSave} appearance="primary" loading={saving} disabled={!canSave}>
          保存
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
