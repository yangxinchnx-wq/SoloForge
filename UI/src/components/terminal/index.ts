export { default as TerminalPanelWithWorkdir } from './TerminalPanelWithWorkdir';
export { default as ConfirmationDock } from './ConfirmationDock';
export { useChatWorkdir } from './hooks/useChatWorkdir';
export { usePendingConfirmBadge } from './hooks/usePendingConfirmBadge';
export {
  useChatWorkdirStore,
  installWorkdirSyncChannel,
} from './store/chatWorkdirStore';
export {
  useConfirmQueueStore,
} from './store/confirmQueueStore';
export type {
  ChatWorkdirEntry,
  ChatWorkdirPersisted,
  ResolveOrCreateOptions,
  SetWorkdirOptions,
  WorkdirSource,
  WorkdirValidationResult,
} from './types';
export type {
  PolicyDecision,
  RiskLevel,
  PermissionMode,
} from './service/commandPolicy';
export {
  validateWorkdir,
  normalizeForIndex,
  isSameRealPath,
  ensureDirExists,
  joinPath,
  defaultWorkspaceRoot,
} from './service/chatWorkdirService';
export {
  evaluateCommand,
  POLICY_KW,
} from './service/commandPolicy';
