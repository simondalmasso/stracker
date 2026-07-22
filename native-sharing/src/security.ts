import { CAPABILITY_BYTES } from './limits.js'

const encoder = new TextEncoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

export function generateCapability(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(CAPABILITY_BYTES)))
}

export async function capabilityVerifier(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  return bytesToBase64Url(new Uint8Array(digest))
}

export async function verifyCapability(token: string, verifier: string): Promise<boolean> {
  const expected = base64UrlToBytes(verifier)
  if (!expected) return false
  const actual = base64UrlToBytes(await capabilityVerifier(token))
  if (!actual || actual.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index]
  return difference === 0
}

export function buildViewerCapability(sessionId: string, viewerToken: string): string {
  return `${sessionId}.${viewerToken}`
}

export function parseViewerCapability(value: string): { sessionId: string; viewerToken: string } | null {
  const match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value.trim())
  return match ? { sessionId: match[1], viewerToken: match[2] } : null
}
