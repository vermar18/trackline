import { readFile } from 'node:fs/promises'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { connectDatabase, mysqlConfig } from './database.mjs'
import { startServer } from './server.mjs'

let runtimeConfig = {}
try {
  runtimeConfig = JSON.parse(await readFile(new URL('./runtime.json', import.meta.url), 'utf8'))
} catch {}

const origin = process.env.TRACKLINE_ORIGIN || runtimeConfig.origin
const secretArn = process.env.TRACKLINE_DATABASE_SECRET_ARN || runtimeConfig.secretArn
let databaseUrl = process.env.DATABASE_URL || runtimeConfig.databaseUrl
let databaseCaPem = process.env.DATABASE_CA_PEM || runtimeConfig.databaseCaPem

try {
  if (secretArn) {
    const client = new SecretsManagerClient({ region: secretArn.split(':')[3] })
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }), { abortSignal: AbortSignal.timeout(7000) })
    const secret = JSON.parse(response.SecretString)
    databaseUrl = secret.DATABASE_URL
    databaseCaPem = secret.DATABASE_CA_PEM
  }
  if (!databaseUrl) {
    throw new Error('No database connection URL found. Set DATABASE_URL or TRACKLINE_DATABASE_SECRET_ARN in Amplify environment variables.')
  }
  const config = await mysqlConfig({ DATABASE_URL: databaseUrl, DATABASE_CA_PEM: databaseCaPem })
  startServer(connectDatabase(config), { host: '0.0.0.0', port: 3000, origin })
} catch (error) {
  console.error('Trackline could not load its database configuration:', error.code || error.name || error.message)
  process.exitCode = 1
}
