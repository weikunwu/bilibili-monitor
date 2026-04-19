import { useState, useEffect, useCallback, useRef } from 'react'
import { Button, InputPicker, Modal, Table, IconButton, Input, Message, useToaster } from 'rsuite'
import TrashIcon from '@rsuite/icons/Trash'
import PlusIcon from '@rsuite/icons/Plus'
import {
  fetchEntryEffects, uploadEntryEffect, deleteEntryEffect, fetchRoomUsers,
  fetchOverlayToken, type EntryEffect,
} from '../api/client'
import { confirmDialog } from '../lib/confirm'

const { Column, HeaderCell, Cell } = Table

const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_EXT = ['.mp4', '.webm']

interface Props {
  roomId: number
}

export function EntryEffectsPanel({ roomId }: Props) {
  const toaster = useToaster()
  const [rows, setRows] = useState<EntryEffect[]>([])
  const [loading, setLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [overlayUrl, setOverlayUrl] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await fetchEntryEffects(roomId)) } finally { setLoading(false) }
  }, [roomId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    fetchOverlayToken(roomId).then((token) => {
      if (token) setOverlayUrl(`${window.location.origin}/overlay/${roomId}/entry-effects?token=${token}`)
    }).catch(() => {})
  }, [roomId])

  async function handleDelete(r: EntryEffect) {
    if (!await confirmDialog({ message: `删除 ${r.user_name || `UID ${r.uid}`} 的进场特效？`, danger: true, okText: '删除' })) return
    try {
      await deleteEntryEffect(roomId, r.id)
      await load()
    } catch (err) {
      toaster.push(<Message type="error" showIcon closable>{(err as Error).message}</Message>, { duration: 3000 })
    }
  }

  async function copyOverlayUrl() {
    if (!overlayUrl) return
    try {
      await navigator.clipboard.writeText(overlayUrl)
      toaster.push(<Message type="success" showIcon closable>链接已复制</Message>, { duration: 2000 })
    } catch {
      toaster.push(<Message type="error" showIcon closable>复制失败</Message>, { duration: 2000 })
    }
  }

  return (
    <div className="nicknames-panel">
      <div className="panel-title">进场特效</div>
      <div className="nicknames-controls">
        <Button size="sm" appearance="primary" startIcon={<PlusIcon />} onClick={() => setShowAdd(true)}>
          新增
        </Button>
        <span className="nicknames-hint">
          给指定 UID 绑定一段视频（最多 10MB，mp4/webm）。该观众进入直播间时，OBS 叠加页会播放一次（5 分钟冷却）。
        </span>
      </div>

      {overlayUrl && (
        <div style={{ marginBottom: 12, padding: 10, background: '#14141f', border: '1px solid #2a2a4a', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>OBS 链接：</span>
          <code style={{ flex: 1, fontSize: 12, color: '#ffd54f', wordBreak: 'break-all' }}>{overlayUrl}</code>
          <Button size="xs" appearance="subtle" onClick={copyOverlayUrl}>复制</Button>
        </div>
      )}

      <Table data={rows} autoHeight loading={loading} rowKey="id">
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
          <Cell>
            {(r: EntryEffect) => (
              <video
                src={`/api/rooms/${r.room_id}/entry-effects/${r.id}/video`}
                controls
                style={{ maxHeight: 80, maxWidth: 160 }}
                preload="none"
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
