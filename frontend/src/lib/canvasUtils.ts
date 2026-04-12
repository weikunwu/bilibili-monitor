/**
 * Vertically stack a list of canvases into one, optionally inserting a gap
 * between each. Width matches the widest input; shorter ones are left-aligned.
 */
export function stackCanvasesVertically(
  canvases: HTMLCanvasElement[],
  gap = 0,
): HTMLCanvasElement {
  const width = Math.max(...canvases.map((c) => c.width))
  const height = canvases.reduce((h, c) => h + c.height, 0) + gap * Math.max(0, canvases.length - 1)
  const merged = document.createElement('canvas')
  merged.width = width
  merged.height = height
  const ctx = merged.getContext('2d')!
  let y = 0
  for (const c of canvases) {
    ctx.drawImage(c, 0, y)
    y += c.height + gap
  }
  return merged
}
