import { z } from 'zod';

export const envSchema = z.object({
  // ─────────────────────────────────────────────
  // Server
  // ─────────────────────────────────────────────
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // ─────────────────────────────────────────────
  // Database - SurrealDB
  // ─────────────────────────────────────────────
  SURREALDB_HOST: z.string().default('localhost'),
  SURREALDB_PORT: z.coerce.number().default(8400),
  SURREALDB_USER: z.string().default('root'),
  SURREALDB_PASS: z.string().default('root'),
  DATABASE_URL: z.string().optional(),

  // ─────────────────────────────────────────────
  // Database - Garnet (Redis-compatible cache)
  // ─────────────────────────────────────────────
  GARNET_HOST: z.string().default('localhost'),
  GARNET_PORT: z.coerce.number().default(6379),
  GARNET_PASSWORD: z.string().optional().default(''),
  GARNET_DB: z.coerce.number().default(0),

  // ─────────────────────────────────────────────
  // LLM / AI Integration
  // ─────────────────────────────────────────────
  SOLOFORGE_LLM_PROVIDER: z.string().default('openai'),
  SOLOFORGE_LLM_API_KEY: z.string().optional(),
  SOLOFORGE_LLM_BASE_URL: z.string().optional(),
  SOLOFORGE_LLM_MODEL: z.string().default('gpt-4'),
  SOLOFORGE_LLM_TIMEOUT_MS: z.coerce.number().default(60000),
  OPENAI_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),

  // ─────────────────────────────────────────────
  // Security
  // ─────────────────────────────────────────────
  JWT_SECRET: z.string().default('dev-jwt-secret-change-in-production'),
  SESSION_SECRET: z.string().default('dev-session-secret-change-in-production'),
  SOLOFORGE_PII_SALT: z.string().default('dev-pii-salt'),
  SOLOFORGE_API_TOKENS: z.string().optional(),
  SOLOFORGE_CORS_ORIGINS: z.string().default('*'),
  SOLOFORGE_REQUIRE_TOKENS: z.coerce.boolean().default(false),
  SOLOFORGE_ROTATION_DISABLED: z.coerce.boolean().default(false),

  // ─────────────────────────────────────────────
  // Multi-Tenant
  // ─────────────────────────────────────────────
  SOLOFORGE_TENANT_HEADER: z.string().default('x-tenant-id'),
  SOLOFORGE_TENANT_PATH_PREFIX: z.string().default(''),
  SOLOFORGE_TENANT_DEFAULT: z.string().default('default'),
  SOLOFORGE_TENANT_BINDINGS: z.string().optional(),

  // ─────────────────────────────────────────────
  // Feature Flags
  // ─────────────────────────────────────────────
  ENABLE_RUST_SCHEDULER: z.coerce.boolean().default(false),
  ENABLE_OBSERVATION: z.coerce.boolean().default(false),

  // ─────────────────────────────────────────────
  // Observability - OpenTelemetry
  // ─────────────────────────────────────────────
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('soloforge'),
  OTEL_SERVICE_VERSION: z.string().default('1.0.0'),
  OTEL_TRACES_EXPORTER: z.string().default('console'),
  OTEL_LOGS_EXPORTER: z.string().default('console'),
  OTEL_METRICS_EXPORTER: z.string().default('none'),
  OTEL_TRACES_SAMPLER: z.string().default('parentbased_always_on'),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().default(1.0),
  LOG_LEVEL: z.string().default('info'),
  SENTRY_DSN: z.string().optional(),

  // ─────────────────────────────────────────────
  // Kafka
  // ─────────────────────────────────────────────
  SOLOFORGE_KAFKA_BROKERS: z.string().optional(),
  SOLOFORGE_KAFKA_TOPIC: z.string().default('soloforge-events'),

  // ─────────────────────────────────────────────
  // Change Feed (Audit)
  // ─────────────────────────────────────────────
  SOLOFORGE_CHANGE_FEED_DISABLED: z.coerce.boolean().default(false),
  SOLOFORGE_CHANGE_FEED_INTERVAL_MS: z.coerce.number().default(5000),
  SOLOFORGE_CHANGE_FEED_BATCH_SIZE: z.coerce.number().default(100),
  SOLOFORGE_CHANGE_FEED_LOOKBACK_MS: z.coerce.number().default(60000),

  // ─────────────────────────────────────────────
  // Misc / Test
  // ─────────────────────────────────────────────
  API_PORT: z.coerce.number().optional(),
  SOLOFORGE_ENABLE_TEST_HOOK: z.coerce.boolean().default(false),
}).passthrough();

export type Env = z.infer<typeof envSchema>;
