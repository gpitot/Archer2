/**
 * Room codes. A code is the whole room identity: the server derives the
 * Durable Object id from it (`idFromName(code.toUpperCase())`), so there is no
 * allocation step and no way to collide-check up front. Two players who
 * generate the same code simply land in the same lobby, which the roster
 * makes obvious immediately.
 */

/** No I/O/0/1 — they're indistinguishable when read aloud or typed. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 4 chars over a 32-symbol alphabet ≈ 1M codes. */
export function generateRoomCode(len = 4): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < len; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

/**
 * Coerce user-typed input into something the router regex
 * (`^/ws/([A-Za-z0-9]+)$`) accepts. The server uppercases too, but doing it
 * here keeps the client's own copy of the code consistent with the DO's.
 */
export function normalizeRoomCode(raw: string): string {
  return (raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
}
