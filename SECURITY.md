# Security policy

Do not submit real credentials, database dumps or personal data in public issues.

## Reporting

For a suspected vulnerability, use **GitHub's private vulnerability reporting**
on the repository's **Security** tab (if enabled). If it is not enabled,
contact the repository owner through a private channel; do not post exploit
details publicly.

## Scope

This is an educational API and not a hosted service. Its bearer API key
is a single-service administrative credential, not a multi-tenant identity
solution. The default Docker Compose configuration binds services to localhost
and contains development-only database credentials.

Before production deployment: rotate secrets, use TLS, apply least privilege,
review retention and GDPR requirements, patch dependencies, configure backups,
monitor logs, and run an independent security assessment.
