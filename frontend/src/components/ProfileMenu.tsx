import { forwardRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Popover, Whisper, Button, Divider, Modal, Input, Message, useToaster } from 'rsuite'
import { MdLogout, MdAdminPanelSettings, MdLock } from 'react-icons/md'
import { authLogout, changePassword, type CurrentUser } from '../api/client'

interface Props {
  user: CurrentUser
}

function getInitial(email: string): string {
  return email.charAt(0).toUpperCase()
}

function hashColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  const colors = ['#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#00bcd4', '#009688', '#4caf50', '#ff9800', '#ff5722']
  return colors[Math.abs(hash) % colors.length]
}

export function ProfileMenu({ user }: Props) {
  const navigate = useNavigate()
  const toaster = useToaster()
  const [pwOpen, setPwOpen] = useState(false)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [busy, setBusy] = useState(false)

  const handleLogout = () => {
    authLogout().then(() => location.reload())
  }

  const handleChangePassword = async () => {
    if (newPw.length < 6) {
      toaster.push(<Message type="error">新密码至少 6 位</Message>, { placement: 'topCenter', duration: 3000 })
      return
    }
    if (newPw !== confirmPw) {
      toaster.push(<Message type="error">两次输入的新密码不一致</Message>, { placement: 'topCenter', duration: 3000 })
      return
    }
    setBusy(true)
    try {
      const res = await changePassword(oldPw, newPw)
      if (res.ok) {
        toaster.push(<Message type="success">密码修改成功</Message>, { placement: 'topCenter', duration: 3000 })
        setPwOpen(false)
        setOldPw(''); setNewPw(''); setConfirmPw('')
      } else {
        toaster.push(<Message type="error">{res.error || '修改失败'}</Message>, { placement: 'topCenter', duration: 3000 })
      }
    } finally {
      setBusy(false)
    }
  }

  const speaker = (
    <Popover className="profile-popover">
      <div className="profile-popover-header">
        <div className="profile-avatar-lg" style={{ background: hashColor(user.email) }}>
          {getInitial(user.email)}
        </div>
        <div className="profile-info">
          <div className="profile-email">{user.email}</div>
          <span className={`profile-role-badge ${user.role}`}>
            {user.role === 'admin' ? '管理员' : user.role === 'staff' ? '员工' : '用户'}
          </span>
        </div>
      </div>
      <Divider style={{ margin: '8px 0' }} />
      {(user.role === 'admin' || user.role === 'staff') && (
        <Button
          appearance="subtle"
          block
          size="sm"
          onClick={() => navigate('/admin')}
          startIcon={<MdAdminPanelSettings />}
        >
          管理后台
        </Button>
      )}
      <Button
        appearance="subtle"
        block
        size="sm"
        onClick={() => setPwOpen(true)}
        startIcon={<MdLock />}
      >
        更改密码
      </Button>
      <Button
        appearance="subtle"
        block
        size="sm"
        onClick={handleLogout}
        startIcon={<MdLogout />}
      >
        退出登录
      </Button>
    </Popover>
  )

  const AvatarButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    (props, ref) => (
      <button {...props} ref={ref} className="profile-avatar-btn" style={{ background: hashColor(user.email) }}>
        {getInitial(user.email)}
      </button>
    ),
  )

  return (
    <>
      <Whisper placement="bottomEnd" trigger="click" speaker={speaker}>
        <AvatarButton />
      </Whisper>
      <Modal open={pwOpen} onClose={() => setPwOpen(false)} size="xs">
        <Modal.Header>
          <Modal.Title>更改密码</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input type="password" placeholder="原密码" value={oldPw} onChange={setOldPw} />
            <Input type="password" placeholder="新密码（至少 6 位）" value={newPw} onChange={setNewPw} />
            <Input type="password" placeholder="确认新密码" value={confirmPw} onChange={setConfirmPw} />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={() => setPwOpen(false)} appearance="subtle">取消</Button>
          <Button onClick={handleChangePassword} appearance="primary" loading={busy}>确认</Button>
        </Modal.Footer>
      </Modal>
    </>
  )
}
