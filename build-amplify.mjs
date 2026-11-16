import { cp, mkdir, writeFile } from 'node:fs/promises'

let origin = process.env.TRACKLINE_ORIGIN
if (!origin && process.env.AWS_APP_ID && process.env.AWS_BRANCH) {
  origin = `https://${process.env.AWS_BRANCH}.${process.env.AWS_APP_ID}.amplifyapp.com`
}
if (!origin) {
  origin = 'https://localhost'
}

const secretArn = process.env.TRACKLINE_DATABASE_SECRET_ARN || ''
const databaseUrl = process.env.DATABASE_URL || ''

const root = new URL('./.amplify-hosting/', import.meta.url)
const compute = new URL('compute/default/', root)
await mkdir(compute, { recursive: true })
const files = ['amplify-server.mjs', 'auth.mjs', 'database.mjs', 'server.mjs', 'package.json', 'package-lock.json', 'public', 'generated', 'prisma']
await Promise.all(files.map(file => cp(new URL(file, import.meta.url), new URL(file, compute), { recursive: true })))
await writeFile(new URL('runtime.json', compute), JSON.stringify({ origin, secretArn, databaseUrl }))
await writeFile(new URL('deploy-manifest.json', root), JSON.stringify({
  version: 1,
  framework: { name: 'trackline', version: '1.0.0' },
  routes: [{ path: '/*', target: { kind: 'Compute', src: 'default' } }],
  computeResources: [{ name: 'default', runtime: 'nodejs24.x', entrypoint: 'amplify-server.mjs' }],
}, null, 2))
