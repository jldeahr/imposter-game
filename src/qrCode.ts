import QRCode from 'qrcode'

const QR_SIZE = 196

/**
 * SVG avoids the browser canvas rendering inconsistencies that can turn the
 * preview into a solid rectangle on some mobile/GPU combinations.
 */
export function createQrCodeSvg(value: string): Promise<string> {
  return QRCode.toString(value, {
    type: 'svg',
    width: QR_SIZE,
    margin: 2,
    color: {
      dark: '#000000ff',
      light: '#ffffffff',
    },
  })
}
