import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';

const API_KEY = 'ci-only-secret-key-12345678901234567890';
let pool: Pool;
let app: FastifyInstance;
let userId = '';
const email = 'person-' + randomUUID() + '@example.org';
const secondEmail = 'new-' + randomUUID() + '@example.org';

function auth() {
  return { authorization: 'Bearer ' + API_KEY };
}

before(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/fastify_concept_test') {
    throw new Error('Integration tests require dedicated database fastify_concept_test');
  }
  pool = createPool(url);
  await migrate(pool);
  await migrate(pool); // Idempotent migration runner.
  app = await buildApp({ pool, apiKey: API_KEY, logger: false, enableDocs: false });
});

after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

test('health endpoints work and protected endpoints reject invalid credentials', async () => {
  const live = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(live.statusCode, 200);
  const ready = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ready.statusCode, 200);

  const noKey = await app.inject({ method: 'GET', url: '/api/v1/users' });
  assert.equal(noKey.statusCode, 401);
  const wrongKey = await app.inject({
    method: 'GET', url: '/api/v1/users',
    headers: { authorization: 'Bearer ' + '0'.repeat(API_KEY.length) },
  });
  assert.equal(wrongKey.statusCode, 401);
  assert.doesNotMatch(wrongKey.body, new RegExp(API_KEY));
  const docs = await app.inject({ method: 'GET', url: '/docs' });
  assert.equal(docs.statusCode, 404);
});

test('payload and UUID validation reject invalid requests', async () => {
  const invalid = await app.inject({
    method: 'POST', url: '/api/v1/users', headers: auth(),
    payload: { email: 'not-an-email', displayName: 'Someone' },
  });
  assert.equal(invalid.statusCode, 400);
  const injection = await app.inject({
    method: 'POST', url: '/api/v1/users', headers: auth(),
    payload: { email: "' OR 1=1 --", displayName: 'Someone' },
  });
  assert.equal(injection.statusCode, 400);
  const wrongId = await app.inject({
    method: 'GET', url: '/api/v1/users/not-a-uuid', headers: auth(),
  });
  assert.equal(wrongId.statusCode, 400);
  const extra = await app.inject({
    method: 'POST', url: '/api/v1/users', headers: auth(),
    payload: { email, displayName: 'Someone', isAdmin: true },
  });
  assert.equal(extra.statusCode, 400);
});

test('create user, enforce unique normalized email and paginate', async () => {
  const created = await app.inject({
    method: 'POST', url: '/api/v1/users', headers: auth(),
    payload: { email: email.toUpperCase(), displayName: ' Test Person ' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const user = created.json();
  assert.match(user.id, /^[a-f0-9-]{36}$/);
  assert.equal(user.email, email);
  assert.equal(user.displayName, 'Test Person');
  assert.equal(user.status, 'active');
  assert.equal(created.headers.location, '/api/v1/users/' + user.id);
  userId = user.id;

  const duplicate = await app.inject({
    method: 'POST', url: '/api/v1/users', headers: auth(),
    payload: { email, displayName: 'Duplicate' },
  });
  assert.equal(duplicate.statusCode, 409);

  const list = await app.inject({
    method: 'GET', url: '/api/v1/users?limit=1&offset=0', headers: auth(),
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.length, 1);
  assert.ok(list.json().total >= 1);
  const badPage = await app.inject({
    method: 'GET', url: '/api/v1/users?limit=99999', headers: auth(),
  });
  assert.equal(badPage.statusCode, 400);
});

test('read, patch, reject invalid status and fetch audit trail', async () => {
  const found = await app.inject({
    method: 'GET', url: '/api/v1/users/' + userId, headers: auth(),
  });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().email, email);

  const modified = await app.inject({
    method: 'PATCH', url: '/api/v1/users/' + userId, headers: auth(),
    payload: { email: secondEmail, displayName: 'New Name', status: 'suspended' },
  });
  assert.equal(modified.statusCode, 200, modified.body);
  assert.equal(modified.json().email, secondEmail);
  assert.equal(modified.json().status, 'suspended');
  assert.equal(modified.json().displayName, 'New Name');

  const invalid = await app.inject({
    method: 'PATCH', url: '/api/v1/users/' + userId, headers: auth(),
    payload: { status: 'superuser' },
  });
  assert.equal(invalid.statusCode, 400);

  const audit = await app.inject({
    method: 'GET', url: '/api/v1/users/' + userId + '/audit', headers: auth(),
  });
  assert.equal(audit.statusCode, 200);
  const types = audit.json().data.map((row: { type: string }) => row.type);
  assert.ok(types.includes('user.created'));
  assert.ok(types.includes('user.updated'));
});

test('consent history handles duplicates, withdrawals and re-consent', async () => {
  const url = '/api/v1/users/' + userId + '/consents';
  const create = () => app.inject({
    method: 'POST', url, headers: auth(),
    payload: { purpose: 'marketing', policyVersion: 'v1' },
  });
  const first = await create();
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().purpose, 'marketing');
  assert.equal(first.json().withdrawnAt, null);

  const duplicate = await create();
  assert.equal(duplicate.statusCode, 409);

  const withdrawn = await app.inject({
    method: 'DELETE', url: url + '/marketing', headers: auth(),
  });
  assert.equal(withdrawn.statusCode, 204);

  const withdrawnAgain = await app.inject({
    method: 'DELETE', url: url + '/marketing', headers: auth(),
  });
  assert.equal(withdrawnAgain.statusCode, 404);

  const second = await app.inject({
    method: 'POST', url, headers: auth(),
    payload: { purpose: 'marketing', policyVersion: 'v2' },
  });
  assert.equal(second.statusCode, 201);

  const history = await app.inject({ method: 'GET', url, headers: auth() });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().data.length, 2);
  assert.equal(history.json().data.filter((row: { withdrawnAt: string | null }) =>
    row.withdrawnAt === null).length, 1);

  const dbCount = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM user_consents WHERE user_id = $1',
    [userId],
  );
  assert.equal(dbCount.rows[0]?.count, '2');
});

test('database persists between Fastify application instances', async () => {
  await app.close();
  app = await buildApp({ pool, apiKey: API_KEY, logger: false });
  const found = await app.inject({
    method: 'GET', url: '/api/v1/users/' + userId, headers: auth(),
  });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().email, secondEmail);
});

test('hard deletion cascades consents and removes personal audit linkage', async () => {
  const deleted = await app.inject({
    method: 'DELETE', url: '/api/v1/users/' + userId, headers: auth(),
  });
  assert.equal(deleted.statusCode, 204);
  const missing = await app.inject({
    method: 'GET', url: '/api/v1/users/' + userId, headers: auth(),
  });
  assert.equal(missing.statusCode, 404);
  const count = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM user_consents WHERE user_id = $1', [userId],
  );
  assert.equal(count.rows[0]?.count, '0');
  const linked = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM audit_events WHERE user_id = $1', [userId],
  );
  assert.equal(linked.rows[0]?.count, '0');

  const deletedAgain = await app.inject({
    method: 'DELETE', url: '/api/v1/users/' + userId, headers: auth(),
  });
  assert.equal(deletedAgain.statusCode, 404);
});

test('Swagger documentation is available only when explicitly enabled', async () => {
  const docsApp = await buildApp({
    pool, apiKey: API_KEY, logger: false, enableDocs: true,
  });
  try {
    const spec = await docsApp.inject({ method: 'GET', url: '/docs/json' });
    assert.equal(spec.statusCode, 200, spec.body);
    const json = spec.json();
    assert.equal(json.info.version, '2.0.0');
    assert.ok(json.paths['/api/v1/users']);
    assert.ok(json.components.securitySchemes.bearerAuth);
  } finally {
    await docsApp.close();
  }
});

test('PostgreSQL rejects invalid data even if another client bypasses HTTP validation', async () => {
  await assert.rejects(
    pool.query(
      'INSERT INTO users (email, display_name, status) VALUES ($1, $2, $3)',
      ['invalid@example.org', 'Invalid state', 'root'],
    ),
    (error: unknown) => (error as { code?: string }).code === '23514',
  );
});

test('migration checksums detect changes to an already-applied SQL migration', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'fastify-migrations-'));
  try {
    const original = await readFile(join(process.cwd(), 'sql', '001_init.sql'), 'utf8');
    await writeFile(join(temporary, '001_init.sql'), original + '\n-- modified after application\n');
    const second = await readFile(join(process.cwd(), 'sql', '002_pagination_indexes.sql'), 'utf8');
    await writeFile(join(temporary, '002_pagination_indexes.sql'), second);
    await assert.rejects(migrate(pool, temporary), /Applied migration has changed/);
    // A failed migration leaves the existing database accessible.
    const check = await pool.query('SELECT COUNT(*)::text AS count FROM schema_migrations');
    assert.equal(check.rows[0]?.count, '2');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('user status filter validates input and returns only matching rows', async () => {
  const address = 'filter-' + randomUUID() + '@example.org';
  const create = await app.inject({
    method: 'POST', url: '/api/v1/users', headers: auth(),
    payload: { email: address, displayName: 'Filter example' },
  });
  assert.equal(create.statusCode, 201, create.body);
  const id = create.json().id as string;
  try {
    const updated = await app.inject({
      method: 'PATCH', url: '/api/v1/users/' + id, headers: auth(),
      payload: { status: 'suspended' },
    });
    assert.equal(updated.statusCode, 200, updated.body);

    const filtered = await app.inject({
      method: 'GET', url: '/api/v1/users?status=suspended&limit=10',
      headers: auth(),
    });
    assert.equal(filtered.statusCode, 200, filtered.body);
    const result = filtered.json();
    assert.ok(result.data.some((row: { id: string }) => row.id === id));
    assert.ok(result.data.every((row: { status: string }) => row.status === 'suspended'));
    assert.ok(result.total >= 1);
    assert.equal(result.limit, 10);
    assert.equal(result.offset, 0);

    const invalid = await app.inject({
      method: 'GET', url: '/api/v1/users?status=admin', headers: auth(),
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.inject({ method: 'DELETE', url: '/api/v1/users/' + id, headers: auth() });
  }
});

test('consent history is paginated, ordered and bounded', async () => {
  const address = 'pagination-' + randomUUID() + '@example.org';
  const create = await app.inject({
    method: 'POST', url: '/api/v1/users', headers: auth(),
    payload: { email: address, displayName: 'History example' },
  });
  assert.equal(create.statusCode, 201, create.body);
  const id = create.json().id as string;
  const url = '/api/v1/users/' + id + '/consents';
  try {
    for (let i = 1; i <= 5; i++) {
      const response = await app.inject({
        method: 'POST', url, headers: auth(),
        payload: { purpose: 'analytics', policyVersion: 'v' + i },
      });
      assert.equal(response.statusCode, 201, response.body);
      if (i !== 5) {
        const withdrawal = await app.inject({
          method: 'DELETE', url: url + '/analytics', headers: auth(),
        });
        assert.equal(withdrawal.statusCode, 204);
      }
    }
    const first = await app.inject({
      method: 'GET', url: url + '?limit=2&offset=0', headers: auth(),
    });
    const next = await app.inject({
      method: 'GET', url: url + '?limit=2&offset=2', headers: auth(),
    });
    const final = await app.inject({
      method: 'GET', url: url + '?limit=2&offset=4', headers: auth(),
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(final.statusCode, 200, final.body);
    const p1 = first.json(), p2 = next.json(), p3 = final.json();
    assert.equal(p1.total, 5);
    assert.equal(p1.limit, 2);
    assert.equal(p1.offset, 0);
    assert.equal(p1.data.length, 2);
    assert.equal(p2.data.length, 2);
    assert.equal(p3.data.length, 1);
    assert.equal(new Set([...p1.data, ...p2.data, ...p3.data]
      .map((row: { id: string }) => row.id)).size, 5);
    const invalid = await app.inject({
      method: 'GET', url: url + '?limit=101', headers: auth(),
    });
    assert.equal(invalid.statusCode, 400);
    const invalidOffset = await app.inject({
      method: 'GET', url: url + '?offset=-1', headers: auth(),
    });
    assert.equal(invalidOffset.statusCode, 400);
  } finally {
    await app.inject({ method: 'DELETE', url: '/api/v1/users/' + id, headers: auth() });
  }
});

test('concurrent duplicate creations produce only one user and one audit event', async () => {
  const address = 'race-' + randomUUID() + '@example.org';
  const requests = Array.from({ length: 4 }, () =>
    app.inject({
      method: 'POST', url: '/api/v1/users', headers: auth(),
      payload: { email: address, displayName: 'Race example' },
    }),
  );
  const results = await Promise.all(requests);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409, 409, 409]);
  const created = results.find((r) => r.statusCode === 201);
  assert.ok(created);
  const id = created.json().id as string;
  try {
    const records = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM users WHERE email = $1',
      [address],
    );
    assert.equal(records.rows[0]?.count, '1');
    const audit = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM audit_events WHERE user_id = $1 AND event_type = 'user.created'",
      [id],
    );
    assert.equal(audit.rows[0]?.count, '1');
  } finally {
    await app.inject({ method: 'DELETE', url: '/api/v1/users/' + id, headers: auth() });
  }
});

test('database validates the timestamp chronology from migration 002', async () => {
  await assert.rejects(
    pool.query(
      "INSERT INTO users (email, display_name, created_at, updated_at) " +
      "VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 hour')",
      ['clock-' + randomUUID() + '@example.org', 'Chronology example'],
    ),
    (error: unknown) => (error as { code?: string }).code === '23514',
  );
});
