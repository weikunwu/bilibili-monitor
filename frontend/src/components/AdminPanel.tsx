import { useState, useEffect } from 'react'
import { Input, Button, SelectPicker, Modal, Checkbox, Stack, Divider, Message } from 'rsuite'
import type { Room } from '../types'
import { fetchUsers, createUser, deleteUser, assignUserRooms, addRoom, removeRoom, type UserInfo } from '../api/client'

interface Props {
  rooms: Room[]
  onRoomsChanged: () => void
}

export function AdminPanel({ rooms, onRoomsChanged }: Props) {
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
    if (!confirm('确定删除该用户？')) return
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

  async function handleRemoveRoom(roomId: number) {
    if (!confirm(`确定删除房间 ${roomId}？`)) return
    try {
      await removeRoom(roomId)
      onRoomsChanged()
    } catch (err) {
      setRoomError((err as Error).message)
    }
  }

  const roleData = [
    { label: '普通用户', value: 'user' },
    { label: '管理员', value: 'admin' },
  ]

  return (
    <div style={{ padding: '16px 24px' }}>
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
      {rooms.map((r) => (
        <div key={r.room_id} className="cmd-item">
          <div className="cmd-info">
            <div className="cmd-name">{r.streamer_name || r.room_id}</div>
            <div className="cmd-desc">房间号: {r.room_id}{r.real_room_id !== r.room_id ? ` (真实ID: ${r.real_room_id})` : ''}</div>
          </div>
          <Button color="red" appearance="subtle" size="xs" onClick={() => handleRemoveRoom(r.room_id)}>
            删除
          </Button>
        </div>
      ))}

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
            style={{ width: 120 }}
          />
          <Button type="submit" appearance="primary" size="sm">创建用户</Button>
        </Stack>
      </form>
      {error && <Message type="error" showIcon style={{ marginBottom: 12 }}>{error}</Message>}

      {users.map((u) => (
        <div key={u.id} className="cmd-item">
          <div className="cmd-info">
            <div className="cmd-name">{u.email}</div>
            <div className="cmd-desc">
              {u.role === 'admin' ? '管理员 (全部房间)' : `普通用户 | 房间: ${u.rooms.length > 0 ? u.rooms.join(', ') : '无'}`}
            </div>
          </div>
          <Stack spacing={6}>
            {u.role !== 'admin' && (
              <Button appearance="ghost" size="xs" onClick={() => startEditRooms(u)}>
                分配房间
              </Button>
            )}
            <Button color="red" appearance="subtle" size="xs" onClick={() => handleDelete(u.id)}>
              删除
            </Button>
          </Stack>
        </div>
      ))}

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
