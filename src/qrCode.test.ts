import { describe, expect, it } from 'vitest'
import { createQrCodeSvg } from './qrCode'

describe('createQrCodeSvg', () => {
  it('creates a scan-ready SVG with a light background and dark modules', async () => {
    const svg = await createQrCodeSvg('https://example.com/imposter-game/#/join/ABC234')

    expect(svg).toContain('<svg')
    expect(svg).toContain('width="196"')
    expect(svg).toContain('height="196"')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('stroke="#000000"')
  })
})
