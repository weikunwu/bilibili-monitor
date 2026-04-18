import { useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Modal, Button } from 'rsuite'

interface ConfirmOptions {
  title?: string
  message: ReactNode
  okText?: string
  cancelText?: string
  danger?: boolean
}

/** 异步 confirm 对话框，替代原生 confirm()。resolve(true) = 点确定。 */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const options: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts
  return new Promise((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    function cleanup() {
      setTimeout(() => { root.unmount(); container.remove() }, 300)
    }
    function Dialog() {
      const [open, setOpen] = useState(true)
      const handle = (result: boolean) => { setOpen(false); cleanup(); resolve(result) }
      return (
        <Modal open={open} onClose={() => handle(false)} size="xs">
          {options.title && <Modal.Header><Modal.Title>{options.title}</Modal.Title></Modal.Header>}
          <Modal.Body>{options.message}</Modal.Body>
          <Modal.Footer>
            <Button appearance="subtle" onClick={() => handle(false)}>{options.cancelText ?? '取消'}</Button>
            <Button appearance="primary" color={options.danger ? 'red' : undefined} onClick={() => handle(true)}>{options.okText ?? '确定'}</Button>
          </Modal.Footer>
        </Modal>
      )
    }
    root.render(<Dialog />)
  })
}
