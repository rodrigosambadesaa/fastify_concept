# Fastify Concept API · REST + PostgreSQL

[![CI](https://github.com/rodrigosambadesaa/fastify_concept/actions/workflows/ci.yml/badge.svg)](https://github.com/rodrigosambadesaa/fastify_concept/actions/workflows/ci.yml)

Modernización del proyecto de ejemplo Fastify. API REST en **TypeScript + Fastify 5**
con **PostgreSQL 17**, migraciones SQL transaccionales, persistencia real,
autenticación administrativa, historial de consentimientos, auditoría sin guardar correos ni cuerpos de solicitudes, validación JSON Schema, Swagger opcional, pruebas de integración
y GitHub Actions.

## Modelo de datos

Consultar [modelo entidad-relación, modelo relacional, claves, cardinalidades,
tipos, normalización y restricciones](docs/data-model.md), además de
[la migración SQL inicial](sql/001_init.sql).

Tablas: `users` (identidad y estado), `user_consents` (histórico voluntario
por finalidad y versión), `audit_events` (traza de operaciones sin almacenar solicitudes ni correos) y
`schema_migrations` (versionado y sumas SHA-256). Los datos no se guardan
en un array: sobreviven a reinicios de la API gracias al volumen PostgreSQL.

## Puesta en marcha con Docker Compose

Requiere Docker y Compose. La API y la base de datos quedan vinculadas
**solo a 127.0.0.1**, no expuestas públicamente.

```sh
cp .env.example .env
# Sustituir API_KEY por una cadena aleatoria, por ejemplo:
# openssl rand -hex 32
# Editar .env y guardar API_KEY=... (no subir .env a Git)
docker compose --env-file .env up --build -d
curl http://127.0.0.1:3000/health/ready
```

En `compose.yml` la clave de DB `fastify_dev_only` sirve **únicamente para
desarrollo local**. Cambiar `POSTGRES_PASSWORD` y `POSTGRES_USER` en `.env`
antes de un despliegue real; para contraseñas especiales en URL, aplicar
codificación porcentual. Para producción use un gestor de secretos, TLS y
una base de datos gestionada o con backups verificados. **No exponga la API
directamente a Internet** sin introducir controles de acceso adaptados a su
caso y una pasarela TLS.

La migración se aplica en el arranque. Los datos de PostgreSQL permanecen
en el volumen `postgres_data`. **No utilice `docker compose down -v`**
si quiere conservarlos.

## Desarrollo local sin contenedor de aplicación

Se necesita Node.js >=22, npm, PostgreSQL >=14 y una base `fastify_concept`.

```sh
cp .env.example .env
npm ci
# Exportar las variables de .env en el entorno
npm run db:migrate
npm run dev
```

Node no carga automáticamente los archivos `.env` con el comando de desarrollo:
puede usar `node --env-file=.env` o exportar las variables desde su shell.
Como alternativa, ejecute todo con Docker Compose.

Para realizar las pruebas, cree **otra base de datos independiente**
llamada `fastify_concept_test`, ajuste `DATABASE_URL` y ejecute:

```sh
npm run typecheck
npm run build
npm run db:migrate
npm test
npm audit --omit=dev --audit-level=high
```

Las pruebas se niegan a ejecutarse si la base de datos no se llama
`fastify_concept_test`; nunca deberían borrar datos reales.

## Autenticación

Todas las rutas de `/api/v1/` requieren la cabecera
`Authorization: Bearer <API_KEY>`. La clave se configura exclusivamente
mediante una variable de entorno con al menos 32 bytes. La comparación
utiliza `crypto.timingSafeEqual`; no hay una contraseña codificada en el repositorio.
Este mecanismo es de **administración de una única aplicación**:
no equivale a un sistema de autenticación multiusuario ni a un servidor de identidad.
Sustituirlo por OAuth2/OIDC y permisos por usuario si el uso previsto lo exige.

Los endpoints de salud no revelan datos personales. `/docs` con Swagger UI
solo está disponible si `ENABLE_DOCS=true` y `NODE_ENV` no es `production`. Los paquetes de Swagger son dependencias exclusivas de desarrollo: la imagen de producción no los instala.

## Endpoints

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | `/health/live` | Proceso activo |
| GET | `/health/ready` | Conexión PostgreSQL comprobada |
| POST | `/api/v1/users` | Crear usuario |
| GET | `/api/v1/users?limit=20&offset=0` | Listar usuarios con paginación |
| GET | `/api/v1/users/:id` | Obtener usuario |
| PATCH | `/api/v1/users/:id` | Cambiar correo, nombre o estado |
| DELETE | `/api/v1/users/:id` | Borrar usuario y sus consentimientos |
| GET | `/api/v1/users/:id/consents` | Consultar histórico |
| POST | `/api/v1/users/:id/consents` | Registrar consentimiento explícito |
| DELETE | `/api/v1/users/:id/consents/:purpose` | Retirar consentimiento |
| GET | `/api/v1/users/:id/audit` | Consultar eventos sin contenido privado |

Ejemplos:

```sh
export API_KEY='clave-secreta-configurada-en-el-servidor'
curl -i -X POST http://127.0.0.1:3000/api/v1/users \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"ejemplo@example.org","displayName":"Ejemplo"}'

# Use el UUID que devuelve la creación
curl -H "Authorization: Bearer $API_KEY" \
  "http://127.0.0.1:3000/api/v1/users?limit=10&offset=0"
```

Las finalidades aceptadas de consentimiento son `marketing` y `analytics`.
La petición de alta es, por ejemplo,
`{"purpose":"analytics","policyVersion":"v1"}`. Se mantiene el histórico
de concesiones y retiradas.

## Seguridad y limitaciones

- Solo SQL parametrizado; datos y eventos confirmados en la misma transacción.
- Integridad referencial mediante claves foráneas, índices, restricciones
  `CHECK`, unicidad del correo y unicidad parcial de consentimientos activos.
- Límites de tamaño de petición (16 KiB), rate limiting global, cabeceras de
  Helmet, validación de tipos, longitud, formato UUID y campos permitidos.
- Sin contraseñas en logs ni respuestas SQL detalladas; `trustProxy=false`.
- Eliminado el workflow anterior que reescribía el puerto en cada push.
- La documentación Swagger está desactivada por defecto y en producción.
- La configuración contiene credenciales solo mediante variables de entorno.
- CI realiza typecheck, build, migraciones, integración con PostgreSQL real y
  auditoría de dependencias de producción para todas las severidades conocidas.

**No es automáticamente una plataforma lista para datos personales reales.**
Antes de un uso productivo: autenticación/autorización fina, TLS, política de
retención, control de acceso a backups, gestión de incidentes, monitorización,
control de acceso operativo y revisión legal del RGPD.

## Migraciones y recuperaciones

`sql/001_init.sql` es la migración inicial. Se registra en
`schema_migrations` con SHA-256 y se aplica de manera atómica.
Para evolucionar el modelo, añadir `002_nueva_migracion.sql`: **no editar**
archivos ya aplicados. En producción, realizar copia verificada antes de cada
migración y ensayar la recuperación.

Ejemplo de backup local:
```sh
docker compose exec -T postgres pg_dump -U fastify -d fastify_concept -Fc > fastify.backup
```

El script anterior presupone `POSTGRES_USER=fastify`. Ajustarlo si se han
modificado las credenciales. Los backups contienen información personal:
cifrarlos, protegerlos y definir su caducidad.

## Desarrollo y contribuciones

El código está separado en configuración, acceso a datos, migraciones,
rutas de aplicación y pruebas. La política de calidad está en
[GitHub Actions](.github/workflows/ci.yml); Dependabot revisa periódicamente
las dependencias. Consulte [SECURITY.md](SECURITY.md) para reportar fallos.
