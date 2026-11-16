import { cp, mkdir, writeFile } from 'node:fs/promises'

const origin = process.env.TRACKLINE_ORIGIN
const secretArn = process.env.TRACKLINE_DATABASE_SECRET_ARN
if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://')) {
  throw new Error('Set TRACKLINE_ORIGIN to the Amplify HTTPS origin with no trailing slash.')
}
if (!/^arn:aws(?:-[a-z-]+)?:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(secretArn || '')) {
  throw new Error('Set TRACKLINE_DATABASE_SECRET_ARN to the database secret ARN.')
}

const root = new URL('./.amplify-hosting/', import.meta.url)
const compute = new URL('compute/default/', root)
await mkdir(compute, { recursive: true })
const files = ['amplify-server.mjs', 'auth.mjs', 'database.mjs', 'server.mjs', 'package.json', 'package-lock.json', 'public', 'generated']
await Promise.all(files.map(file => cp(new URL(file, import.meta.url), new URL(file, compute), { recursive: true })))
await writeFile(new URL('runtime.json', compute), JSON.stringify({ origin, secretArn }))
await writeFile(new URL('deploy-manifest.json', root), JSON.stringify({
  version: 1,
  framework: { name: 'trackline', version: '1.0.0' },
  routes: [{ path: '/*', target: { kind: 'Compute', src: 'default' } }],
  computeResources: [{ name: 'default', runtime: 'nodejs24.x', entrypoint: 'amplify-server.mjs' }],
}, null, 2))
