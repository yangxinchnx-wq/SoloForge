// src/kernel/state-ownership.ts
import { logger } from '../core/logger';

export class StateOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateOwnershipError';
  }
}

export class StateOwnerRegistry {
  private owners = new Map<string, string>();           // domain → ownerAgentId
  private registeredDomains = new Set<string>();

  registerDomain(domain: string, allowedOwnerAgentId?: string): void {
    this.registeredDomains.add(domain);
    this.owners.set(domain, allowedOwnerAgentId || `SYSTEM_DAEMON_${domain.toUpperCase()}`);
    logger.info('StateOwnerRegistry', `Sovereign domain registered: [${domain}]`);
  }

  verifyCommandOwnership(command: any): void {
    const domain = command.domain;
    if (!domain) {
      throw new StateOwnershipError('ERR_SF_OWNERSHIP: Command missing domain field');
    }

    if (!this.registeredDomains.has(domain)) {
      throw new StateOwnershipError(`ERR_SF_OWNERSHIP: Unregistered domain access: ${domain}`);
    }

    const expectedOwner = this.owners.get(domain);
    const actualCaller = command.caller || command.agentId || command.issuer;

    if (!actualCaller) {
      throw new StateOwnershipError(`ERR_SF_OWNERSHIP: Anonymous caller rejected on domain [${domain}]`);
    }

    if (expectedOwner && expectedOwner !== actualCaller && !actualCaller.startsWith('SYSTEM_MASTER')) {
      throw new StateOwnershipError(
        `ERR_SF_OWNERSHIP: Unauthorized access! Agent [${actualCaller}] cannot operate in domain [${domain}]. Expected: [${expectedOwner}]`
      );
    }

    logger.debug('StateOwnerRegistry', `Ownership verified`, { domain, caller: actualCaller });
  }
}