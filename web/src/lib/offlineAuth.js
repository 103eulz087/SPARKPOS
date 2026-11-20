import { db } from './api'

/**
 * Offline sign-in: a cashier or supervisor who has signed in ONLINE on this device can sign in
 * again while the network is down. Nothing is downloaded for this — no password hash ever
 * leaves the server. Instead, at an online sign-in (or a supervisor's online override) the
 * browser derives its own check from the typed password: PBKDF2-SHA256, 210,000 rounds, a
 * random salt per user, then encrypted with an AES key that can't be read out of the browser
 * (a non-extractable CryptoKey kept in IndexedDB). Admins are never cached (online only).
 * A cached sign-in expires MAX_AGE_DAYS after the last online one, so someone removed in the
 * ERP can't keep using a device forever. Five wrong tries lock that user here for 5 minutes.
 * Needs a secure context (https://, or localhost): crypto.subtle doesn't exist on plain http.
 */
const ITERATIONS = 210000
const MAX_AGE_DAYS = 14
const MAX_TRIES = 5
const LOCK_MS = 5 * 60 * 1000

export const offlineSignInSupported = () => !!(window.isSecureContext && window.crypto?.subtle)

const enc = new TextEncoder()
const keyOf = (username) => String(username || '').trim().toLowerCase()
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

async function deviceKey() {
  const row = await db.meta.get('cred_key')
  if (row?.value) return row.value
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await db.meta.put({ key: 'cred_key', value: key })
  return key
}

async function derive(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, 256)
}

/** After a successful ONLINE check. profile: { userId, username, fullName, role, branchCode }. */
export async function rememberCredential(username, password, profile) {
  if (!offlineSignInSupported() || !profile || profile.role === 'Admin') return
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const hash = await derive(password, salt)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const body = enc.encode(JSON.stringify({ salt: b64(salt), hash: b64(hash), profile, savedAt: Date.now() }))
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), body)
    await db.credentials.put({ key: keyOf(username), iv: b64(iv), data: b64(data), tries: 0, lockedUntil: 0 })
  } catch { /* offline sign-in is a convenience; never block the online one */ }
}

export const forgetCredential = (username) => db.credentials.delete(keyOf(username))

/** Returns the cached profile when the password matches; throws a readable error otherwise. */
export async function verifyOffline(username, password) {
  if (!offlineSignInSupported())
    throw new Error('Offline sign-in needs the POS on https://. Reconnect to sign in.')
  const row = await db.credentials.get(keyOf(username))
  if (!row) throw new Error('No connection, and this user has not signed in online on this device before.')
  if (row.lockedUntil > Date.now()) throw new Error('Too many wrong passwords. Try again in a few minutes.')

  let rec
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv) }, await deviceKey(), unb64(row.data))
    rec = JSON.parse(new TextDecoder().decode(plain))
  } catch { throw new Error('The saved sign-in on this device is unreadable. Reconnect to sign in.') }

  if (Date.now() - rec.savedAt > MAX_AGE_DAYS * 864e5) {
    await forgetCredential(username)
    throw new Error(`This user hasn't signed in online for over ${MAX_AGE_DAYS} days. Reconnect to sign in.`)
  }
  const got = new Uint8Array(await derive(password, unb64(rec.salt)))
  const want = unb64(rec.hash)
  let diff = got.length ^ want.length
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i]
  if (diff !== 0) {
    const tries = (row.tries || 0) + 1
    await db.credentials.update(row.key, tries >= MAX_TRIES ? { tries: 0, lockedUntil: Date.now() + LOCK_MS } : { tries })
    throw new Error('Invalid username or password.')
  }
  if (row.tries) await db.credentials.update(row.key, { tries: 0 })
  return rec.profile
}
