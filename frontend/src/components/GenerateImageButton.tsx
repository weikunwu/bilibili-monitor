import { useState, useCallback, type ReactNode } from 'react'
import { Button } from 'rsuite'
import type { TypeAttributes } from 'rsuite/esm/internals/types'

interface Props {
  size?: 'xs' | 'sm' | 'md' | 'lg'
  appearance?: TypeAttributes.Appearance
  onClick: () => Promise<void> | void
  children: ReactNode
}

export function GenerateImageButton({ size = 'sm', appearance = 'ghost', onClick, children }: Props) {
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(async () => {
    setLoading(true)
    try { await onClick() } finally { setLoading(false) }
  }, [onClick])

  return (
    <Button size={size} appearance={appearance} loading={loading} onClick={handleClick}>
      {children}
    </Button>
  )
}
