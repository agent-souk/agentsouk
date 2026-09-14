/**
 * ADR-62: the icon an index shows next to this origin. x402scan and the discovery audits look for /favicon.ico,
 * /favicon.png or /favicon.svg at the root and warn when none answers. A 32x32 ICO (one embedded PNG: a slate
 * rounded square with an amber diamond), generated without an image library and embedded so nothing is read from disk.
 */
/**
 * ADR-65: the same image as a plain PNG, for the `iconUrl` field of the x402 resource block: a facilitator that
 * catalogues our services fetches it to show an icon, and the bazaar spec wants an image URL, not an ICO container.
 * An ICO file is a 6-byte header, one 16-byte directory entry (width, height, ..., byte size, byte offset) and
 * the images; ours holds exactly one image and it is a PNG, so the PNG is the bytes from the entry's offset on.
 */
export function iconPng(): Buffer {
  const size = FAVICON_ICO.readUInt32LE(6 + 8)
  const offset = FAVICON_ICO.readUInt32LE(6 + 12)
  return FAVICON_ICO.subarray(offset, offset + size)
}

export const FAVICON_ICO = Buffer.from(
  'AAABAAEAICAAAAEAIADJAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAJBJREFUeNrtl0sKgDAMRGfvyp038Nbe0nUFQTcqJM20GdRAluU9aJsP8BDjNBdmwhJsqEumF/xWojf8IvFtgSz4KRE5vC7DnikCBzwqAQY8IgEWvFYCTHiNBNhwrwRawD0SaAW3SqAl3CKhLZB+BRKPUOIbShQiiVIs0Ywk2rHEQPKKufAfy3VWM4nlNGs93wD1gN3czcbrwwAAAABJRU5ErkJggg==',
  'base64',
)
