import { envSchema, type Env } from './env-schema';

let validatedEnv: Env | null = null;

/**
 * 验证 process.env 并返回类型安全的环境变量对象。
 * 初期阶段：验证失败仅 warn，不阻断启动，逐步收紧。
 */
export function validateEnv(): Env {
  if (validatedEnv) return validatedEnv;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Environment validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    // 初期仅 warn 不阻断，逐步收紧
    console.warn('⚠️ Continuing with defaults (env validation is in warn-only mode)');
  }

  validatedEnv = result.success ? result.data : (envSchema.parse({}) as Env);
  return validatedEnv;
}

/**
 * 获取已验证的环境变量。如果尚未验证，自动触发验证。
 */
export function getEnv(): Env {
  return validatedEnv ?? validateEnv();
}
