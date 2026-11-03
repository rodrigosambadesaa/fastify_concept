import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const endpoint = 'http://127.0.0.1:3000';
const secret = process.env.API_KEY;
assert.ok(secret && secret.length >= 32, 'Missing CI-only API_KEY');

const auth = { authorization: 'Bearer ' + secret };
const email = 'compose-' + randomUUID() + '@example.org';

async function request(path, options = {}) {
  const response = await fetch(endpoint + path, {
    ...options,
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const result = await request('/health/ready');
      if (result.status === 200 && result.body.status === 'ok') return;
    } catch {
      // Docker has not finished restarting the application yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('The application did not become healthy after its restart');
}

await ready();
const unauthenticated = await request('/api/v1/users');
assert.equal(unauthenticated.status, 401, 'API must reject anonymous clients');

const created = await request('/api/v1/users', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ email, displayName: 'Persistent record' }),
});
assert.equal(created.status, 201, JSON.stringify(created.body));
assert.match(created.body.id, /^[0-9a-f-]{36}$/);
const id = created.body.id;

const before = await request('/api/v1/users/' + id, { headers: auth });
assert.equal(before.status, 200);
assert.equal(before.body.email, email);

// Recreate the Node process but retain its separate PostgreSQL volume.
execFileSync('docker', ['compose', 'restart', 'api'], { stdio: 'inherit' });
await ready();

const after = await request('/api/v1/users/' + id, { headers: auth });
assert.equal(after.status, 200, 'PostgreSQL must preserve users across API restarts');
assert.equal(after.body.email, email);

const erased = await request('/api/v1/users/' + id, {
  method: 'DELETE', headers: auth,
});
assert.equal(erased.status, 204);
const missing = await request('/api/v1/users/' + id, { headers: auth });
assert.equal(missing.status, 404);
console.log('Compose smoke passed: authorization, CRUD and persistence after API restart');
