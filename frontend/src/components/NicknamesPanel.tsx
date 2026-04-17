import { useState, useEffect, useCallback } from 'react'
import { Button, Input, InputPicker, Modal, Table, IconButton, Toggle } from 'rsuite'
import TrashIcon from '@rsuite/icons/Trash'
import EditIcon from '@rsuite/icons/Edit'
import PlusIcon from '@rsuite/icons/Plus'
import {
  fetchNicknames, saveNickname, deleteNickname, fetchRoomUsers,
  fetchCommands, toggleCommand,
  type Nickname,
} from '../api/client'
import { useIsMobile } from '../hooks/useIsMobile'

const { Column, HeaderCell, Cell } = Table

interface Props {
  roomId: number
}

export function NicknamesPanel({ roomId }: Props) {
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<Nickname[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Nickname | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [featureEnabled, setFeatureEnabled] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await fetchNicknames(roomId)) } finally { setLoading(false) }
  }, [roomId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    fetchCommands(roomId)
      .then((cs) => setFeatureEnabled(cs.find((c) => c.id === 'nickname_commands')?.enabled ?? true))
      .catch(() => {})
  }, [roomId])

  async function handleToggleFeature(next: boolean) {
    setFeatureEnabled(next)
    try { await toggleCommand(roomId, 'nickname_commands') } catch { setFeatureEnabled(!next) }
  }

  async function handleDelete(n: Nickname) {
    if (!confirm(`删除 ${n.user_name} 的昵称「${n.nickname}」？`)) return
    await deleteNickname(roomId, n.user_id)
    await load()
  }

  return (
    <div className="nicknames-panel">
      <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span>昵称管理</span>
        {featureEnabled !== null && (
          <Toggle
            size="sm"
            checked={featureEnabled}
            onChange={handleToggleFeature}
          />
        )}
      </div>
      <div className="nicknames-controls">
        <Button size="sm" appearance="primary" startIcon={<PlusIcon />} onClick={() => setShowAdd(true)}>
          新增昵称
        </Button>
        <span className="nicknames-hint">
          {featureEnabled === false
            ? '已关闭：观众无法用"叫我 xxx/清除昵称"改昵称，下方记录保留但所有播报/查询弹幕不再使用昵称'
            : '观众发"叫我 xxx"设置、"清除昵称"清除；机器人在播报/查询回复中用此昵称称呼'}
        </span>
      </div>

      {isMobile ? (
        <div className="nickname-cards">
          {rows.length === 0 ? (
            <div className="empty">{loading ? '加载中...' : '暂无昵称记录'}</div>
          ) : rows.map((n) => (
            <div className="nickname-card" key={n.user_id}>
              <div className="nickname-card-head">
                <div className="nickname-card-user">
                  <div className="nickname-card-name">{n.user_name}</div>
                  <div className="nickname-card-uid">UID {n.user_id}</div>
                </div>
                <div className="nickname-card-nick">{n.nickname}</div>
              </div>
              <div className="nickname-card-foot">
                <span className="nickname-card-time">{n.updated_at}</span>
                <div className="nickname-card-actions">
                  <IconButton size="sm" icon={<EditIcon />} onClick={() => setEditing(n)} />
                  <IconButton size="sm" icon={<TrashIcon />} onClick={() => handleDelete(n)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Table data={rows} autoHeight loading={loading} rowKey="user_id">
          <Column flexGrow={2}>
            <HeaderCell>用户名</HeaderCell>
            <Cell dataKey="user_name" />
          </Column>
          <Column flexGrow={2}>
            <HeaderCell>昵称</HeaderCell>
            <Cell dataKey="nickname" />
          </Column>
          <Column flexGrow={2}>
            <HeaderCell>UID</HeaderCell>
            <Cell dataKey="user_id" />
          </Column>
          <Column flexGrow={2}>
            <HeaderCell>更新时间</HeaderCell>
            <Cell dataKey="updated_at" />
          </Column>
          <Column width={120}>
            <HeaderCell>操作</HeaderCell>
            <Cell>
              {(rowData: Nickname) => (
                <div style={{ display: 'flex', gap: 6 }}>
                  <IconButton size="xs" icon={<EditIcon />} onClick={() => setEditing(rowData)} />
                  <IconButton size="xs" icon={<TrashIcon />} onClick={() => handleDelete(rowData)} />
                </div>
              )}
            </Cell>
          </Column>
        </Table>
      )}

      {editing && (
        <EditModal
          roomId={roomId}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
      {showAdd && (
        <AddModal
          roomId={roomId}
          existing={rows}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load() }}
        />
      )}
    </div>
  )
}

function EditModal({
  roomId, initial, onClose, onSaved,
}: { roomId: number; initial: Nickname; onClose: () => void; onSaved: () => void }) {
  const [nickname, setNickname] = useState(initial.nickname)
  const [saving, setSaving] = useState(false)
  async function handleSave() {
    if (!nickname.trim()) return
    setSaving(true)
    try {
      await saveNickname(roomId, initial.user_id, initial.user_name, nickname.trim())
      onSaved()
    } finally { setSaving(false) }
  }
  return (
    <Modal open onClose={onClose} size="xs">
      <Modal.Header><Modal.Title>编辑昵称</Modal.Title></Modal.Header>
      <Modal.Body>
        <div style={{ marginBottom: 8, color: '#888', fontSize: 13 }}>
          用户：{initial.user_name} (UID {initial.user_id})
        </div>
        <Input value={nickname} onChange={(v) => setNickname(v.slice(0, 6))} placeholder="昵称（最多6字）" maxLength={6} />
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} appearance="subtle">取消</Button>
        <Button onClick={handleSave} appearance="primary" loading={saving}>保存</Button>
      </Modal.Footer>
    </Modal>
  )
}

function AddModal({
  roomId, existing, onClose, onSaved,
}: { roomId: number; existing: Nickname[]; onClose: () => void; onSaved: () => void }) {
  const [users, setUsers] = useState<{ user_id: number; user_name: string }[]>([])
  const [userId, setUserId] = useState<number | null>(null)
  const [userName, setUserName] = useState('')
  const [nickname, setNickname] = useState('')
  const [saving, setSaving] = useState(false)
  const existingIds = new Set(existing.map((e) => e.user_id))

  async function search(s: string) {
    const list = await fetchRoomUsers(roomId, s)
    setUsers(list.filter((u) => !existingIds.has(u.user_id)))
  }

  useEffect(() => { search('') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!userId || !nickname.trim()) return
    setSaving(true)
    try {
      await saveNickname(roomId, userId, userName, nickname.trim())
      onSaved()
    } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} size="xs">
      <Modal.Header><Modal.Title>新增昵称</Modal.Title></Modal.Header>
      <Modal.Body>
        <div style={{ marginBottom: 12 }}>
          <InputPicker
            data={users.map((u) => ({ label: `${u.user_name} (${u.user_id})`, value: u.user_id, name: u.user_name }))}
            value={userId}
            onChange={(v) => {
              setUserId(v as number | null)
              const hit = users.find((u) => u.user_id === v)
              setUserName(hit?.user_name || '')
            }}
            onSearch={search}
            placeholder="搜索用户（出现过的房间访客）"
            block
          />
        </div>
        <Input value={nickname} onChange={(v) => setNickname(v.slice(0, 6))} placeholder="昵称（最多6字）" maxLength={6} />
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} appearance="subtle">取消</Button>
        <Button onClick={handleSave} appearance="primary" loading={saving} disabled={!userId || !nickname.trim()}>
          保存
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
