-- Performance and defensive integrity for growing user and consent datasets.
-- New migration: do not edit 001_init.sql after it has been applied.
CREATE INDEX ix_users_status_created_page
    ON users (status, created_at DESC, id);

CREATE INDEX ix_consents_user_page
    ON user_consents (user_id, granted_at DESC, id DESC);

ALTER TABLE users
    ADD CONSTRAINT ck_users_timestamp_order CHECK (updated_at >= created_at);
