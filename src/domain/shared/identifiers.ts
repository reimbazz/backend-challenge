/**
 * Gera um UUID v7 (prefixo de timestamp): mantém o B-tree da PK compacto e
 * serve de desempate ordenável no cursor do ledger.
 */
export function generateId(): string {
  const timestampInMilliseconds = BigInt(Date.now());
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));

  // bytes 0..5: timestamp de 48 bits (big-endian)
  for (let byteIndex = 0; byteIndex < 6; byteIndex++) {
    const bitShift = BigInt((5 - byteIndex) * 8);
    randomBytes[byteIndex] = Number((timestampInMilliseconds >> bitShift) & 0xffn);
  }

  // versão 7 e variante RFC 4122
  randomBytes[6] = (randomBytes[6]! & 0x0f) | 0x70;
  randomBytes[8] = (randomBytes[8]! & 0x3f) | 0x80;

  const hexadecimal = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20, 32),
  ].join('-');
}
