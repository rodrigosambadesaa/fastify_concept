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
# Generar dos valores distintos, aleatorios y seguros para una URL:
openssl rand -hex 32   # Guardar como POSTGRES_PASSWORD=... en .env
openssl rand -hex 32   # Guardar como API_KEY=... en .env
# No subir .env a Git. Ambos valores son obligatorios.
docker compose --env-file .env up --build -d --wait
curl http://127.0.0.1:3000/health/ready
```

Docker Compose **no utiliza ninguna contraseña PostgreSQL predeterminada**:
exige `POSTGRES_PASSWORD` no vacío en `.env`, junto con `API_KEY`.
Genere contraseñas distintas y aleatorias con `openssl rand -hex 32` para
evitar caracteres especiales que requieren codificación porcentual en la URL.
En despliegues reales deben almacenarse en un gestor de secretos. Si ya existe
un volumen PostgreSQL, **cambiar la variable no cambia automáticamente la
contraseña del usuario dentro de la base existente**: deberá rotarla
explícitamente sin destruir los datos. Para producción use un gestor de secretos, TLS y
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
# Ajustar DATABASE_URL en .env con la contraseña PostgreSQL real;
# exportar después las variables desde el shell.
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
| GET | `/api/v1/users?limit=20&offset=0&status=active` | Listar usuarios con paginación y filtro opcional por estado |
| GET | `/api/v1/users/:id` | Obtener usuario |
| PATCH | `/api/v1/users/:id` | Cambiar correo, nombre o estado |
| DELETE | `/api/v1/users/:id` | Borrar usuario y sus consentimientos |
| GET | `/api/v1/users/:id/consents?limit=20&offset=0` | Consultar histórico paginado |
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

## Mejora de paginación y protección de integridad

Los listados de usuarios e historial de consentimientos aceptan `limit` (1–100) y
`offset` (0–100000), devuelven `data`, `total`, `limit` y `offset`, y ordenan
siempre por fechas e identificadores para resolver empates. Los usuarios también
pueden filtrarse por `status=active|suspended`.

Los intentos de insertar correos duplicados o consentimientos ya activos se
resuelven con `ON CONFLICT DO NOTHING`: la API devuelve HTTP 409 sin provocar
una excepción SQL que pudiese incluir datos personales en los registros del
servidor PostgreSQL. Se comprueba que no generen eventos de auditoría duplicados.
La migración `002_pagination_indexes.sql` añade índices para consultas paginadas
y una restricción cronológica sobre `users.updated_at`.

## Aislamiento y prueba completa de Docker Compose

La API ejecuta el proceso Node como usuario no privilegiado, con sistema de
archivos raíz de solo lectura, sin capacidades Linux adicionales y con
`no-new-privileges`. Sus servicios se publican exclusivamente en
`127.0.0.1`; la base de datos mantiene sus datos en un volumen persistente.
El contenedor de la API tiene un `healthcheck` que comprueba PostgreSQL.

El trabajo `compose-smoke` de GitHub Actions construye y levanta los dos
contenedores, comprueba autenticación y operaciones reales, reinicia el
contenedor de la API y verifica que el usuario creado sigue presente en
PostgreSQL. Finalmente prueba el borrado. Las credenciales de CI son
exclusivamente ficticias y efímeras.
