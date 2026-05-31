// scripts/launch-production.ts
import { RuntimeKernel } from '../src/kernel/runtime-kernel';
import { RoleEvolutionEngine } from '../src/core/society/role-evolution';
import { CoalitionEngine } from '../src/core/society/coalition';
import { SocialMemoryEngine } from '../src/core/society/social-memory';
import { LawEngine } from '../src/core/law/law-engine';
import { SocialReputationEngine } from '../src/core/society/reputation';
import { ConsensAgentCourtRoom } from '../src/core/court/consensagent';
import { LlmEscalationRoom } from '../src/core/court/llm_escalation';

// Storage sink infrastructure consumers
import { initializeSocietyEvolutionConsumer } from '../src/data/consumers/society-evolution-consumer';
import { initializeSocialMemoryConsumer } from '../src/data/consumers/social-memory-consumer';
import { initializeLawComplianceConsumer } from '../src/data/consumers/law-compliance-consumer';
import { initializeReputationAnalyticsConsumer } from '../src/data/consumers/reputation-analytics-consumer';
import { initializeCourtAdjudicationConsumer } from '../src/data/consumers/court-adjudication-consumer';
import { initializeSocietyGovernanceConsumer } from '../src/data/consumers/society-governance-consumer';

import { logger } from '../src/core/logger';
import { SurrealPersistence } from '../src/data/surreal_persistence';

/**
 * 🚀 SoloForge Integrated Universe Master Hot-Bootstrapper
 * Responsibility: Dynamically chains all Phase 2 and Phase 3 isolated card modules into the core kernel loop slots.
 */
export async function launchProductionOrchestrationEngine(kernel: RuntimeKernel): Promise<void> {
  logger.warn('MASTER_BOOT', '🪐 [System Ignition Sequence Initiated] Chaining multi-universe multi-agent fabrics...');

  try {
    // ─── STEP 1: Mount Outmost Asynchronous Infrastructure Sink Pipes ───
    initializeSocietyEvolutionConsumer(kernel);
    initializeSocialMemoryConsumer(kernel);
    initializeLawComplianceConsumer(kernel);
    initializeReputationAnalyticsConsumer(kernel);
    initializeCourtAdjudicationConsumer(kernel);
    initializeSocietyGovernanceConsumer(kernel);
    logger.info('MASTER_BOOT', '🔌 Level 1: Outmost non-blocking asynchronous storage consumers pinned.');

    // ─── STEP 2: Instantiate Domain Card Subsystems ───
    const geminiPersistenceManager = new SurrealPersistence();

    const roleEvolution = new RoleEvolutionEngine(kernel);
    const coalitionEngine = new CoalitionEngine(kernel);
    const socialMemory = new SocialMemoryEngine(kernel);
    const lawEngine = new LawEngine(kernel);
    const reputationEngine = new SocialReputationEngine(kernel);
    const courtRoom = new ConsensAgentCourtRoom(kernel);
    const supremeCourt = new LlmEscalationRoom(kernel, geminiPersistenceManager);

    // ─── STEP 3: Linear Sequential Cold Boot Activation ───
    await roleEvolution.boot();
    await coalitionEngine.boot();
    await socialMemory.boot();
    await lawEngine.boot();
    await reputationEngine.boot();
    await courtRoom.bootCourtRoom();
    await supremeCourt.initializeSupremeTribunal();

    logger.warn('MASTER_BOOT', '✅ [Ignition Successful] SoloForge multi-agent runtime operating universe is live. Base frozen.');

  } catch (criticalFailure: any) {
    logger.critical('MASTER_BOOT', `💥 Core boot linkage structural breakdown! Emergency fallback shutdown triggered. Reason: ${criticalFailure.message}`);
    process.exit(1);
  }
}
