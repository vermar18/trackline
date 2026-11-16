import { readFile } from 'node:fs/promises'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import rdsProfiles from 'aws-ssl-profiles'
import { PrismaClient } from './generated/prisma/client.ts'

export function connectDatabase(config) {
  const adapter = new PrismaMariaDb({ ...config, connectionLimit: 4, connectTimeout: 5000, acquireTimeout: 8000 })
  const prisma = new PrismaClient({ adapter })
  async function query(client, sql, args) {
    const rows = await client.$queryRawUnsafe(sql, ...args)
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key, typeof value === 'bigint' ? (Number.isSafeInteger(Number(value)) ? Number(value) : String(value)) : value,
    ])))
  }
  const operations = client => ({
    item: client.item,
    itemImage: client.itemImage,
    user: client.user,
    query: (sql, args = []) => query(client, sql, args),
    execute: (sql, args = []) => client.$executeRawUnsafe(sql, ...args),
    async one(sql, args = []) {
      const rows = await query(client, sql, args)
      return rows[0]
    },
  })
  return {
    ...operations(prisma),
    transaction: callback => prisma.$transaction(tx => callback(operations(tx)), { timeout: 20000 }),
    close: () => prisma.$disconnect(),
  }
}

export async function mysqlConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('Set DATABASE_URL to a MySQL connection URL.')
  let url
  try { url = new URL(env.DATABASE_URL) } catch { throw new Error('Invalid MySQL DATABASE_URL.') }
  const database = url.pathname.slice(1)
  if (url.protocol !== 'mysql:' || !url.hostname || !url.username || !/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error('Use a MySQL URL with a username, hostname, and database name.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local = ['localhost', '127.0.0.1', '::1'].includes(host)
  const caPath = env.DATABASE_SSL_CA || url.searchParams.get('sslcert')
  const aws = /\.rds\.amazonaws\.com(?:\.cn)?$/i.test(host)
  const ca = env.DATABASE_CA_PEM || (caPath ? await readFile(caPath, 'utf8') : aws ? rdsProfiles.ca : undefined)
  return {
    host, port: Number(url.port || 3306), database, user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), ssl: !local || ca ? { ca, rejectUnauthorized: true } : undefined,
  }
}
