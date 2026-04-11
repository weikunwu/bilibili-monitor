import { forwardRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Popover, Whisper, Button, Divider } from 'rsuite'
import { MdLogout, MdAdminPanelSettings } from 'react-icons/md'
import { authLogout, type CurrentUser } from '../api/client'

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
  const handleLogout = () => {
    authLogout().then(() => location.reload())
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
            {user.role === 'admin' ? '管理员' : '用户'}
          </span>
        </div>
      </div>
      <Divider style={{ margin: '8px 0' }} />
      {user.role === 'admin' && (
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
    <Whisper placement="bottomEnd" trigger="click" speaker={speaker}>
      <AvatarButton />
    </Whisper>
  )
}
