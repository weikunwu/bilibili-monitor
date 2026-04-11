import { useState, useEffect } from 'react'
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

  return (
    <div style={{ padding: '16px 24px' }}>
      {/* ── Room management ── */}
      <h3 style={{ color: '#fb7299', marginBottom: 16, fontSize: 16 }}>房间管理</h3>
      <form onSubmit={handleAddRoom} style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="房间号"
          value={newRoomId}
          onChange={(e) => setNewRoomId(e.target.value)}
          required
          style={{ ...inputStyle, width: 160 }}
        />
        <button type="submit" disabled={roomLoading} style={btnStyle}>
          {roomLoading ? '连接中...' : '添加房间'}
        </button>
      </form>
      {roomError && <div style={{ color: '#ef5350', fontSize: 13, marginBottom: 12 }}>{roomError}</div>}
      {rooms.map((r) => (
        <div key={r.room_id} className="cmd-item">
          <div className="cmd-info">
            <div className="cmd-name">{r.streamer_name || r.room_id}</div>
            <div className="cmd-desc">房间号: {r.room_id}{r.real_room_id !== r.room_id ? ` (真实ID: ${r.real_room_id})` : ''} | 人气: {r.popularity}</div>
          </div>
          <button onClick={() => handleRemoveRoom(r.room_id)} style={{ ...smallBtnStyle, background: '#c0392b' }}>
            删除
          </button>
        </div>
      ))}

      <div style={{ borderTop: '1px solid #2a2a4a', margin: '24px 0 16px' }} />

      {/* ── User management ── */}
      <h3 style={{ color: '#fb7299', marginBottom: 16, fontSize: 16 }}>用户管理</h3>

      {/* Create user form */}
      <form onSubmit={handleCreate} style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="email"
          placeholder="邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={inputStyle}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        <button type="submit" style={btnStyle}>创建用户</button>
      </form>
      {error && <div style={{ color: '#ef5350', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {/* User list */}
      {users.map((u) => (
        <div key={u.id} className="cmd-item">
          <div className="cmd-info">
            <div className="cmd-name">{u.email}</div>
            <div className="cmd-desc">
              {u.role === 'admin' ? '管理员 (全部房间)' : `普通用户 | 房间: ${u.rooms.length > 0 ? u.rooms.join(', ') : '无'}`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {u.role !== 'admin' && (
              <button onClick={() => startEditRooms(u)} style={{ ...smallBtnStyle, background: '#2a6aaa' }}>
                分配房间
              </button>
            )}
            <button onClick={() => handleDelete(u.id)} style={{ ...smallBtnStyle, background: '#c0392b' }}>
              删除
            </button>
          </div>
        </div>
      ))}

      {/* Edit rooms modal */}
      {editingUser !== null && (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setEditingUser(null) }}>
          <div className="modal" style={{ textAlign: 'left' }}>
            <h2>分配房间</h2>
            <div style={{ marginTop: 12 }}>
              {rooms.map((r) => (
                <label key={r.room_id} style={{ display: 'block', padding: '6px 0', fontSize: 14, color: '#ccc', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={editRooms.includes(r.room_id)}
                    onChange={() => toggleRoom(r.room_id)}
                    style={{ accentColor: '#fb7299', marginRight: 8 }}
                  />
                  {r.streamer_name || r.room_id} ({r.room_id})
                </label>
              ))}
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditingUser(null)} className="close-btn">取消</button>
              <button onClick={saveRooms} style={btnStyle}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  background: '#0f0f1a',
  border: '1px solid #2a2a4a',
  color: '#ccc',
  padding: '6px 12px',
  borderRadius: 6,
  fontSize: 13,
}

const btnStyle: React.CSSProperties = {
  background: '#fb7299',
  color: '#fff',
  border: 'none',
  padding: '6px 16px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
}

const smallBtnStyle: React.CSSProperties = {
  color: '#fff',
  border: 'none',
  padding: '4px 10px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 11,
}
