import type { Migration } from '../../migrate.ts'
import { m001 } from './001_pg_baseline.ts'

/**
 * PostgreSQL 这套的全部迁移。显式列出，不去扫目录。
 *
 * 加一章就在这里加一行，同时在 `scripts/verify-tag.mjs` 的
 * `CHAPTER_CHECKS` 里补一条——漏了的话跑那个 tag 会直接退出 1 并提示你，
 * 不会静默当成「验过了」。
 */
export const pgMigrations: readonly Migration[] = [m001]
