-- PostgreSQL 14+. UUID generation via gen_random_uuid() (built into modern PostgreSQL).
-- Timestamps represent instants (UTC internally); no personal data is stored in audit events.
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(254) NOT NULL UNIQUE,
    display_name VARCHAR(120) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_users_email_lowercase CHECK (email = lower(btrim(email))),
    CONSTRAINT ck_users_email_shape CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
    CONSTRAINT ck_users_display_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_users_status CHECK (status IN ('active', 'suspended'))
);

CREATE INDEX ix_users_created_at ON users (created_at DESC, id);

CREATE TABLE user_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose VARCHAR(16) NOT NULL,
    policy_version VARCHAR(32) NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    withdrawn_at TIMESTAMPTZ,
    CONSTRAINT ck_consents_purpose CHECK (purpose IN ('marketing', 'analytics')),
    CONSTRAINT ck_consents_version CHECK (length(btrim(policy_version)) BETWEEN 1 AND 32),
    CONSTRAINT ck_consents_dates CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

-- History is preserved; at most one active consent per user and purpose.
CREATE UNIQUE INDEX ux_consents_active_purpose
    ON user_consents(user_id, purpose) WHERE withdrawn_at IS NULL;
CREATE INDEX ix_consents_user_history
    ON user_consents(user_id, granted_at DESC);

CREATE TABLE audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type VARCHAR(32) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_audit_type CHECK (event_type IN (
        'user.created', 'user.updated', 'user.deleted',
        'consent.granted', 'consent.withdrawn'
    ))
);

CREATE INDEX ix_audit_user_time ON audit_events(user_id, occurred_at DESC);
CREATE INDEX ix_audit_time ON audit_events(occurred_at DESC);
