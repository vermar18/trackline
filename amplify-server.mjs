import { readFile } from 'node:fs/promises'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { connectDatabase, mysqlConfig } from './database.mjs'
import { startServer } from './server.mjs'

const { origin, secretArn } = JSON.parse(await readFile(new URL('./runtime.json', import.meta.url), 'utf8'))
try {
  const client = new SecretsManagerClient({ region: secretArn.split(':')[3] })
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }), { abortSignal: AbortSignal.timeout(7000) })
  const secret = JSON.parse(response.SecretString)
  const config = await mysqlConfig({ DATABASE_URL: secret.DATABASE_URL, DATABASE_CA_PEM: secret.DATABASE_CA_PEM })
  startServer(connectDatabase(config), { host: '0.0.0.0', port: 3000, origin })
} catch (error) {
  console.error('Trackline could not load its database configuration:', error.code || error.name)
  process.exitCode = 1
}
