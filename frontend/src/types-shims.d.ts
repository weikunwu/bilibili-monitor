declare module 'omggif' {
  export class GifWriter {
    constructor(buf: Uint8Array, width: number, height: number, gopts?: { loop?: number; palette?: number[]; background?: number })
    addFrame(x: number, y: number, w: number, h: number, indexed: Uint8Array, opts?: { delay?: number; disposal?: number; transparent?: number; palette?: number[] }): number
    end(): number
  }
}

declare module 'gifenc' {
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: number[][]; delay?: number; transparent?: boolean; transparentIndex?: number; dispose?: number; repeat?: number; first?: boolean; x?: number; y?: number }): void
    finish(): void
    bytes(): Uint8Array
  }
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number, opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): number[][]
  export function applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: number[][], format?: string): Uint8Array
}
