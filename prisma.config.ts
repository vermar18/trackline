import { defineConfig } from 'prisma/config'
import { loadEnvFile } from 'node:process'

try { loadEnvFile() } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
})
