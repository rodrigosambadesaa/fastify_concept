import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Pool } from 'pg';
import { withTransaction } from './db.js';

type Status = 'active' | 'suspended';
type Purpose = 'marketing' | 'analytics';
type EventType = 'user.created' | 'user.updated' | 'user.deleted'
  | 'consent.granted' | 'consent.withdrawn';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: Status;
  created_at: Date;
  updated_at: Date;
}
interface ConsentRow {
  id: string;
  user_id: string;
  purpose: Purpose;
  policy_version: string;
  granted_at: Date;
  withdrawn_at: Date | null;
}
interface AuditRow {
  id: string;
  user_id: string | null;
  event_type: EventType;
  occurred_at: Date;
}
interface CreateUserBody { email: string; displayName: string }
interface UpdateUserBody { email?: string; displayName?: string; status?: Status }
interface GrantConsentBody { purpose: Purpose; policyVersion: string }
interface IdParams { id: string }
interface PurposeParams extends IdParams { purpose: Purpose }
interface ListQuery { limit?: number; offset?: number }

export interface AppOptions {
  pool: Pool;
  apiKey: string;
  enableDocs?: boolean;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  logger?: boolean;
}

const userColumns = 'id, email, display_name, status, created_at, updated_at';
const consentColumns = 'id, user_id, purpose, policy_version, granted_at, withdrawn_at';
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const pageQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
  },
} as const;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
function isEmail(email: string): boolean {
  return email.length <= 254 && emailShape.test(email);
}
function userView(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
function consentView(row: ConsentRow) {
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    policyVersion: row.policy_version,
    grantedAt: row.granted_at.toISOString(),
    withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
  };
}
function auditView(row: AuditRow) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.event_type,
    occurredAt: row.occurred_at.toISOString(),
  };
}
function validKey(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const errorResponse = (error: string, message: string) => ({ error, message });

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  if (Buffer.byteLength(options.apiKey, 'utf8') < 32) {
    throw new Error('An API key of at least 32 bytes is required');
  }

  const app = Fastify({
    bodyLimit: 16 * 1024,
    trustProxy: false,
    logger: options.logger === false ? false : {
      level: options.logLevel ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'request.headers.authorization',
          'res.headers.set-cookie', 'headers.authorization'],
        censor: '[REDACTED]',
      },
    },
  });

  await app.register(helmet);
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: () => errorResponse('rate_limited', 'Too many requests'),
  });

  if (options.enableDocs) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'Fastify Concept API', version: '2.0.0',
          description: 'User records and purpose-specific consent history' },
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        },
        security: [{ bearerAuth: [] }],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  // Only API resources require the administrator key. Health checks do not
  // disclose user data; documentation is opt-in and disabled in production.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!validKey(token, options.apiKey)) {
      return reply.code(401).send(errorResponse('unauthorized', 'Bearer API key required'));
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const dbCode = (error as Error & { code?: string }).code;
    if (dbCode === '23505') {
      return reply.code(409).send(errorResponse('conflict', 'Duplicate or conflicting resource'));
    }
    if (dbCode === '23514' || dbCode === '23502' || dbCode === '22001') {
      return reply.code(422).send(errorResponse('invalid_data', 'Database constraint violated'));
    }
    const possibleStatus = (error as { statusCode?: number }).statusCode;
    const status = possibleStatus && possibleStatus >= 400 && possibleStatus < 500
      ? possibleStatus : 500;
    if (status === 500) {
      // Avoid logging SQL values, request bodies, API keys or connection strings.
      request.log.error({ code: dbCode ?? 'unexpected', method: request.method },
        'Request failed');
    }
    return reply.code(status).send(errorResponse(
      status === 500 ? 'internal_error' : 'bad_request',
      status === 500 ? 'Unexpected server error' : 'Invalid request',
    ));
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await options.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post<{ Body: CreateUserBody }>('/api/v1/users', {
    schema: {
      tags: ['Users'], summary: 'Create a user',
      body: {
        type: 'object', required: ['email', 'displayName'], additionalProperties: false,
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          displayName: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
    },
  }, async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    const displayName = request.body.displayName.trim();
    if (!isEmail(email) || displayName.length === 0) {
      return reply.code(400).send(errorResponse('invalid_user', 'Valid email and displayName required'));
    }
    const created = await withTransaction(options.pool, async (client) => {
      const result = await client.query<UserRow>(
        'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING ' + userColumns,
        [email, displayName],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Insert failed');
      await client.query(
        "INSERT INTO audit_events (user_id, event_type) VALUES ($1, 'user.created')",
        [row.id],
      );
      return userView(row);
    });
    return reply.code(201).header('location', '/api/v1/users/' + created.id).send(created);
  });

  app.get<{ Querystring: ListQuery }>('/api/v1/users', {
    schema: { tags: ['Users'], summary: 'List users', querystring: pageQuery },
  }, async (request) => {
    const limit = request.query.limit ?? 20;
    const offset = request.query.offset ?? 0;
    const [users, count] = await Promise.all([
      options.pool.query<UserRow>(
        'SELECT ' + userColumns + ' FROM users ORDER BY created_at DESC, id LIMIT $1 OFFSET $2',
        [limit, offset],
      ),
      options.pool.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM users'),
    ]);
    return {
      data: users.rows.map(userView),
      total: Number(count.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  });

  app.get<{ Params: IdParams }>('/api/v1/users/:id', {
    schema: { tags: ['Users'], summary: 'Get a user', params: idParams },
  }, async (request, reply) => {
    const result = await options.pool.query<UserRow>(
      'SELECT ' + userColumns + ' FROM users WHERE id = $1', [request.params.id],
    );
    const row = result.rows[0];
    return row ? userView(row)
      : reply.code(404).send(errorResponse('not_found', 'User not found'));
  });

  app.patch<{ Params: IdParams; Body: UpdateUserBody }>('/api/v1/users/:id', {
    schema: {
      tags: ['Users'], summary: 'Update a user', params: idParams,
      body: {
        type: 'object', minProperties: 1, additionalProperties: false,
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          displayName: { type: 'string', minLength: 1, maxLength: 120 },
          status: { type: 'string', enum: ['active', 'suspended'] },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    const email = body.email === undefined ? null : normalizeEmail(body.email);
    const displayName = body.displayName === undefined ? null : body.displayName.trim();
    if ((email !== null && !isEmail(email)) ||
        (displayName !== null && !displayName)) {
      return reply.code(400).send(errorResponse('invalid_user', 'Invalid email or displayName'));
    }
    const updated = await withTransaction(options.pool, async (client) => {
      const result = await client.query<UserRow>(
        'UPDATE users SET email = COALESCE($2, email), ' +
        'display_name = COALESCE($3, display_name), ' +
        'status = COALESCE($4, status), updated_at = CURRENT_TIMESTAMP ' +
        'WHERE id = $1 RETURNING ' + userColumns,
        [request.params.id, email, displayName, body.status ?? null],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        "INSERT INTO audit_events (user_id, event_type) VALUES ($1, 'user.updated')",
        [row.id],
      );
      return userView(row);
    });
    return updated ?? reply.code(404).send(errorResponse('not_found', 'User not found'));
  });

  app.delete<{ Params: IdParams }>('/api/v1/users/:id', {
    schema: { tags: ['Users'], summary: 'Erase a user and their consents', params: idParams },
  }, async (request, reply) => {
    const deleted = await withTransaction(options.pool, async (client) => {
      const result = await client.query('DELETE FROM users WHERE id = $1 RETURNING id',
        [request.params.id]);
      if (result.rowCount === 0) return false;
      // No personally identifying information is retained after erasure.
      await client.query("INSERT INTO audit_events (event_type) VALUES ('user.deleted')");
      return true;
    });
    return deleted ? reply.code(204).send()
      : reply.code(404).send(errorResponse('not_found', 'User not found'));
  });

  app.get<{ Params: IdParams }>('/api/v1/users/:id/consents', {
    schema: { tags: ['Consents'], summary: 'List consent history', params: idParams },
  }, async (request, reply) => {
    const found = await options.pool.query('SELECT 1 FROM users WHERE id = $1',
      [request.params.id]);
    if (found.rowCount === 0) {
      return reply.code(404).send(errorResponse('not_found', 'User not found'));
    }
    const consents = await options.pool.query<ConsentRow>(
      'SELECT ' + consentColumns +
      ' FROM user_consents WHERE user_id = $1 ORDER BY granted_at DESC, id',
      [request.params.id],
    );
    return { data: consents.rows.map(consentView) };
  });

  app.post<{ Params: IdParams; Body: GrantConsentBody }>('/api/v1/users/:id/consents', {
    schema: {
      tags: ['Consents'], summary: 'Record explicit purpose-specific consent',
      params: idParams,
      body: {
        type: 'object', required: ['purpose', 'policyVersion'], additionalProperties: false,
        properties: {
          purpose: { type: 'string', enum: ['marketing', 'analytics'] },
          policyVersion: { type: 'string', minLength: 1, maxLength: 32 },
        },
      },
    },
  }, async (request, reply) => {
    const version = request.body.policyVersion.trim();
    if (!version) {
      return reply.code(400).send(errorResponse('invalid_consent', 'policyVersion required'));
    }
    const created = await withTransaction(options.pool, async (client) => {
      const found = await client.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE',
        [request.params.id]);
      if (found.rowCount === 0) return null;
      const result = await client.query<ConsentRow>(
        'INSERT INTO user_consents (user_id, purpose, policy_version) ' +
        'VALUES ($1, $2, $3) RETURNING ' + consentColumns,
        [request.params.id, request.body.purpose, version],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Insert failed');
      await client.query(
        "INSERT INTO audit_events (user_id, event_type) VALUES ($1, 'consent.granted')",
        [request.params.id],
      );
      return consentView(row);
    });
    return created ? reply.code(201).send(created)
      : reply.code(404).send(errorResponse('not_found', 'User not found'));
  });

  app.delete<{ Params: PurposeParams }>('/api/v1/users/:id/consents/:purpose', {
    schema: {
      tags: ['Consents'], summary: 'Withdraw an active consent',
      params: {
        type: 'object', required: ['id', 'purpose'], additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          purpose: { type: 'string', enum: ['marketing', 'analytics'] },
        },
      },
    },
  }, async (request, reply) => {
    const removed = await withTransaction(options.pool, async (client) => {
      const result = await client.query(
        'UPDATE user_consents SET withdrawn_at = GREATEST(CURRENT_TIMESTAMP, granted_at) ' +
        'WHERE user_id = $1 AND purpose = $2 AND withdrawn_at IS NULL RETURNING id',
        [request.params.id, request.params.purpose],
      );
      if (result.rowCount === 0) return false;
      await client.query(
        "INSERT INTO audit_events (user_id, event_type) VALUES ($1, 'consent.withdrawn')",
        [request.params.id],
      );
      return true;
    });
    return removed ? reply.code(204).send()
      : reply.code(404).send(errorResponse('not_found', 'No active consent found'));
  });

  app.get<{ Params: IdParams; Querystring: ListQuery }>('/api/v1/users/:id/audit', {
    schema: { tags: ['Audit'], summary: 'List non-PII events for a user',
      params: idParams, querystring: pageQuery },
  }, async (request, reply) => {
    const exists = await options.pool.query('SELECT 1 FROM users WHERE id = $1',
      [request.params.id]);
    if (exists.rowCount === 0) {
      return reply.code(404).send(errorResponse('not_found', 'User not found'));
    }
    const result = await options.pool.query<AuditRow>(
      'SELECT id::text, user_id, event_type, occurred_at FROM audit_events ' +
      'WHERE user_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3',
      [request.params.id, request.query.limit ?? 20, request.query.offset ?? 0],
    );
    return { data: result.rows.map(auditView) };
  });

  return app;
}
