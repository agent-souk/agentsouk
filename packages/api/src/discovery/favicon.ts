/**
 * ADR-62: the icon an index shows next to this origin. x402scan and the discovery audits look for /favicon.ico,
 * /favicon.png or /favicon.svg at the root and warn when none answers. A 32x32 ICO (one embedded PNG: a slate
 * rounded square with an amber diamond), generated without an image library and embedded so nothing is read from disk.
 */
export const FAVICON_ICO = Buffer.from(
  'AAABAAEAICAAAAEAIADJAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAJBJREFUeNrtl0sKgDAMRGfvyp038Nbe0nUFQTcqJM20GdRAluU9aJsP8BDjNBdmwhJsqEumF/xWojf8IvFtgSz4KRE5vC7DnikCBzwqAQY8IgEWvFYCTHiNBNhwrwRawD0SaAW3SqAl3CKhLZB+BRKPUOIbShQiiVIs0Ywk2rHEQPKKufAfy3VWM4nlNGs93wD1gN3czcbrwwAAAABJRU5ErkJggg==',
  'base64',
)
