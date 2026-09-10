export const ErrorCodes = {
  // 1xxx: Constitution (startup dependencies)
  CONSTITUTION_KERNEL_MISSING: { code: 'ERR_SF_1001', statusCode: 503, message: 'Runtime kernel not initialized' },
  CONSTITUTION_COMMAND_BUS_MISSING: { code: 'ERR_SF_1002', statusCode: 503, message: 'Command bus not initialized' },
  CONSTITUTION_EVENT_BUS_MISSING: { code: 'ERR_SF_1003', statusCode: 503, message: 'Event bus not initialized' },
  CONSTITUTION_PERSISTENCE_MISSING: { code: 'ERR_SF_1004', statusCode: 503, message: 'Persistence layer not initialized' },
  // 2xxx: Transaction
  TX_NOT_FOUND: { code: 'ERR_SF_2001', statusCode: 404, message: 'Transaction not found' },
  TX_CONFLICT: { code: 'ERR_SF_2002', statusCode: 409, message: 'Transaction conflict' },
  TX_PATCH_APPLY_FAILED: { code: 'ERR_SF_2003', statusCode: 500, message: 'Transaction patch apply failed' },
  // 3xxx: Optimistic Lock
  OPTIMISTIC_LOCK_FAILED: { code: 'ERR_SF_3001', statusCode: 409, message: 'Optimistic lock version conflict', isRetryable: true },
  // 4xxx: Court / Arbitration
  COURT_RACE_CONDITION: { code: 'ERR_SF_4001', statusCode: 409, message: 'Court race condition detected' },
  COURT_FLOW_VIOLATION: { code: 'ERR_SF_4002', statusCode: 400, message: 'Court flow violation' },
  COURT_SUPREME_CONCURRENCY: { code: 'ERR_SF_4003', statusCode: 409, message: 'Supreme court concurrency error' },
  // 5xxx: Governance / Society
  GOVERNANCE_RACE: { code: 'ERR_SF_5001', statusCode: 409, message: 'Governance race condition' },
  GOVERNANCE_ACTION_RACE: { code: 'ERR_SF_5002', statusCode: 409, message: 'Governance action race condition' },
  INSTITUTION_RACE: { code: 'ERR_SF_5003', statusCode: 409, message: 'Institution race condition' },
  INSTITUTION_DELETE_RACE: { code: 'ERR_SF_5004', statusCode: 409, message: 'Institution delete race condition' },
  // 6xxx: Agent / Decision
  AGENT_DISPATCH_ERROR: { code: 'ERR_SF_6001', statusCode: 500, message: 'Agent dispatch error' },
  AGENT_POOL_EMPTY: { code: 'ERR_SF_6002', statusCode: 503, message: 'Agent pool is empty' },
  ACCESS_DENIED: { code: 'ERR_SF_6003', statusCode: 403, message: 'Access denied' },
  // 7xxx: LLM
  LLM_CALL_FAILED: { code: 'ERR_SF_7001', statusCode: 502, message: 'LLM call failed' },
  LLM_TIMEOUT: { code: 'ERR_SF_7002', statusCode: 504, message: 'LLM call timed out', isRetryable: true },
  LLM_RATE_LIMITED: { code: 'ERR_SF_7003', statusCode: 429, message: 'LLM rate limited', isRetryable: true },
  // 8xxx: Security / Auth
  AUTH_FAILED: { code: 'ERR_SF_8001', statusCode: 401, message: 'Authentication failed' },
  AUTH_TOKEN_INVALID: { code: 'ERR_SF_8002', statusCode: 401, message: 'Token invalid or expired' },
  AUTH_FORBIDDEN: { code: 'ERR_SF_8003', statusCode: 403, message: 'Insufficient permissions' },
} as const;

export type ErrorCodeKey = keyof typeof ErrorCodes;
