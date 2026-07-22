const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  if (secret.trim().length < 32) throw new Error('SESSION_ENCRYPTION_KEY_INVALID')
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function hashIdentitySubject(subject: string): Promise<string> {
  if (!subject.trim()) throw new Error('ACCESS_SUBJECT_REQUIRED')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(subject))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function encryptSession(
  plaintext: string,
  secret: string,
  subjectHash: string,
): Promise<{ ivB64: string; ciphertextB64: string }> {
  const key = await deriveAesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = encoder.encode(`stracker:google-maps-session:v1:${subjectHash}`)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    key,
    encoder.encode(plaintext),
  )
  return { ivB64: bytesToBase64(iv), ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)) }
}

export async function decryptSession(
  ivB64: string,
  ciphertextB64: string,
  secret: string,
  subjectHash: string,
): Promise<string> {
  const key = await deriveAesKey(secret)
  const additionalData = encoder.encode(`stracker:google-maps-session:v1:${subjectHash}`)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(ivB64),
      additionalData,
      tagLength: 128,
    },
    key,
    base64ToBytes(ciphertextB64),
  )
  return decoder.decode(plaintext)
}
