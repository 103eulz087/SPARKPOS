/**
 * Weighing-scale barcode stickers (PosSettings.Scale*). A scale prints an EAN-13 sticker:
 *   prefix + product code + weight + check digit
 * e.g. 2510015231232 with prefix 25, code length 5, weight length 5, 3 decimals
 *   = product 10015, weight 23.123 (the last digit is the scale's check digit, not read).
 * Returns { code, quantity } or null when the scan isn't a scale sticker for this branch.
 */
export function parseScaleBarcode(scan, settings = {}) {
  const prefixes = String(settings.ScaleBarcodePrefix || '').split(',').map(p => p.trim()).filter(Boolean)
  if (!prefixes.length) return null
  const s = String(scan || '').trim()
  if (!/^\d+$/.test(s)) return null
  const codeLen = Number(settings.ScaleCodeLength) || 5
  const qtyLen = Number(settings.ScaleQtyLength) || 5
  const decimals = Number(settings.ScaleQtyDecimals ?? 3)
  for (const prefix of prefixes) {
    if (!s.startsWith(prefix) || s.length !== prefix.length + codeLen + qtyLen + 1) continue
    const code = s.substr(prefix.length, codeLen)
    const quantity = Number(s.substr(prefix.length + codeLen, qtyLen)) / 10 ** decimals
    return quantity > 0 ? { code, quantity } : null
  }
  return null
}
