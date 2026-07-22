import type { SessionStore, StoredSessionRecord } from './contracts'

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T>(): Promise<T | null>
  run(): Promise<unknown>
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike
}

interface D1SessionRow {
  subject_hash: string
  iv_b64: string
  ciphertext_b64: string
  created_at: string
  updated_at: string
}

export function createD1SessionStore(database: D1DatabaseLike): SessionStore {
  return {
    async get(subjectHash) {
      const row = await database
        .prepare('SELECT subject_hash, iv_b64, ciphertext_b64, created_at, updated_at FROM shared_sessions WHERE subject_hash = ?1 LIMIT 1')
        .bind(subjectHash)
        .first<D1SessionRow>()
      if (!row) return null
      return {
        subjectHash: row.subject_hash,
        ivB64: row.iv_b64,
        ciphertextB64: row.ciphertext_b64,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    },
    async put(record: StoredSessionRecord) {
      await database
        .prepare(`INSERT INTO shared_sessions (subject_hash, iv_b64, ciphertext_b64, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(subject_hash) DO UPDATE SET
            iv_b64 = excluded.iv_b64,
            ciphertext_b64 = excluded.ciphertext_b64,
            updated_at = excluded.updated_at`)
        .bind(record.subjectHash, record.ivB64, record.ciphertextB64, record.createdAt, record.updatedAt)
        .run()
    },
    async delete(subjectHash) {
      await database.prepare('DELETE FROM shared_sessions WHERE subject_hash = ?1').bind(subjectHash).run()
    },
  }
}
