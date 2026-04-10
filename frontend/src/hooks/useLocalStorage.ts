import { useState, useCallback } from 'react'

export function useLocalStorage(key: string, defaultValue: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key)
    if (stored === null) return defaultValue
    return stored === 'true'
  })

  const set = useCallback(
    (v: boolean) => {
      setValue(v)
      localStorage.setItem(key, String(v))
    },
    [key],
  )

  return [value, set]
}
