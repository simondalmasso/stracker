import { Database } from 'bun:sqlite'
import type {
  RuntimeSqlCursor,
  RuntimeSqlExecutor,
  RuntimeSqlRow,
  RuntimeSqlValue,
} from '../../native-sharing-cloudflare/src/sqlite-store.js'

class TestSqlCursor<T extends RuntimeSqlRow> implements RuntimeSqlCursor<T> {
  constructor(
    private readonly rows: T[],
    readonly rowsRead: number,
    readonly rowsWritten: number,
  ) {}

  toArray(): T[] { return this.rows.map((row) => ({ ...row })) }
}

function normalizeBinding(value: RuntimeSqlValue): string | number | null | Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value
}

export class BunSqlExecutor implements RuntimeSqlExecutor {
  readonly database = new Database(':memory:', { strict: true })

  exec<T extends RuntimeSqlRow = RuntimeSqlRow>(query: string, ...bindings: RuntimeSqlValue[]): RuntimeSqlCursor<T> {
    const normalized = bindings.map(normalizeBinding)
    const statement = this.database.query(query)
    const returnsRows = /^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)
    if (returnsRows) {
      const rows = statement.all(...normalized) as T[]
      return new TestSqlCursor(rows, rows.length, 0)
    }
    const result = statement.run(...normalized)
    return new TestSqlCursor<T>([], 0, Number(result.changes))
  }

  logicalRowsWritten(): number {
    const row = this.database.query(
      'SELECT changes() AS logical_rows_written',
    ).get() as { logical_rows_written: number }
    return Number(row.logical_rows_written)
  }

  transactionSync<T>(callback: () => T): T {
    return this.database.transaction(callback)()
  }

  close(): void { this.database.close() }
}
