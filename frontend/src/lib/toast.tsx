import { Message, toaster } from 'rsuite'

type ToastType = 'info' | 'success' | 'warning' | 'error'

export function toast(message: string, type: ToastType = 'info', duration = 3000) {
  toaster.push(
    <Message type={type} showIcon closable>{message}</Message>,
    { duration },
  )
}
