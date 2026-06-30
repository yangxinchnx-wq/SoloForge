// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SoloForge Acceptance Test Harness: Data Governance & Rollback
// Path: tests/integration/data-governance.test.ts
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

import { describe, it, expect } from 'vitest';
// 100% ç²¾åå¯¹é½ delete_protection.ts ç©çå¯¼åºçæ¥å£ä¸ç±»å
import { DeleteProtection, DeleteCommand } from '../../src/data/delete_protection';
// 100% ç²¾åå¯¹é½ transaction_kernel.ts ç©çå¯¼åºçæ¥å£ä¸ç±»å
import { TransactionKernel, StatePatch } from '../../src/data/transaction_kernel';

describe('SoloForge Layer 3 æ°æ®æ²»çé»æ­ä¸åå­åæ ¸äºå¡èªæéæéªæ¶æµè¯å¥ä»¶', () => {

  it('éªæ¶ç¹ 1ï¼[ä¸å¯åå®ªæ³ç¡¬æ¦æª] å½ä»»ææºè½ä½ä¼å¾ç©ç drop æç¯¡æ¹æ ¸å¿å®ªæ³èµäº§æ¶ï¼æ²»çæ¦æªå¨å¿é¡»ç¡¬æ§é»æ­ï¼æç»ç©çæ¹é¤', async () => {
    // ç©çå®ä¾åæ¬å°åè£ç±»
    const interceptor = new DeleteProtection();

    // ä¸¥å¯æé å®å¨ç¬¦å DeleteCommand å¥çº¦çæ°æ®è·è½½
    const command: DeleteCommand = {
      targetId: 'constitution_global', // è§¦å 'constitution_' ç¡¬æ¦æªåç¼
      contentType: 'governance_rule',
      requestedBy: 'rogue_agent_xyz'
    };

    const mockLiveExtractedData = { version: 3, content: "Sovereign Rules" };

    // æ§è¡çå®çæ¦æªæ¹æ³
    const result = await interceptor.interceptAndExecute(command, mockLiveExtractedData);

    // æ­è¨ï¼ç³»ç»å¿é¡»é»æ­ç©çå é¤ï¼è¿å success = false ä¸ action = 'BLOCKED'
    expect(result.success).toBe(false);
    expect(result.action).toBe('BLOCKED');
    
    // æ­è¨ï¼ç¡¬æ¦æªè¯·æ±ç»ä¸è½æ¼è¿è½¯å é¤å·å¤åæ¶ç«ä¸­
    expect((await interceptor.getTrashManifest()).length).toBe(0);
  });

  it('éªæ¶ç¹ 2ï¼[å¯éçº§è½¯å é¤å½æ¡£] å½å é¤éæ ¸å¿æ®éææ¡£èµäº§æ¶ï¼ç³»ç»å¿é¡»åè®¸éè¿ï¼ä½å¿é¡»å¥ç¦»åºæ´»è·ç©éµå¹¶è·¯ç±è³ 30å¤© TTL å·å¤åº', async () => {
    const interceptor = new DeleteProtection();

    const command: DeleteCommand = {
      targetId: 'document_old_obsolete_logs_2025', // æ®éæ¥å¿ï¼ä¸å½ä¸­ä»»ä½ immutablePrefixes é»æ­åç¼
      contentType: 'document',
      requestedBy: 'agent_beta'
    };

    const mockData = { size: "12MB", payload: "stale text data" };

    // æ§è¡çå®çè½¯å é¤å½æ¡£æ¹æ³
    const result = await interceptor.interceptAndExecute(command, mockData);

    // æ­è¨ï¼æ®éèµäº§åè®¸ä¸çº¿è½¯å é¤ï¼è¿å success = true ä¸ action = 'SOFT_DELETED'
    expect(result.success).toBe(true);
    expect(result.action).toBe('SOFT_DELETED');

    // æ­è¨ï¼åæ¶ç«å·å¤åºï¼mockTrashDbï¼ä¸­å¿é¡»è½ç²¾åè¿½æº¯å°è¿ä¸æ¡è¢«æ¹å¹³æ°æ®çåå²ç©çå¿«ç§
    const trash = await interceptor.getTrashManifest();
    expect(trash.length).toBe(1);
    expect(trash[0].deletedBy).toBe('agent_beta');
    expect(trash[0].payload.size).toBe('12MB');
  });

  it('éªæ¶ç¹ 3ï¼[äºå¡åå­æ§ä¸åæ ¸ç¾é¾èªæ] éªè¯åæ ¸å¨çæ¬å²çªæ¶æç»æäº¤ï¼å¹¶å¨é­éè¿è¡æ¶å¼å¸¸æ¶éè¿ rollback æ å®ç¾åå­åå¤å', async () => {
    const initialRegistry = {
      'core_scheduler_memory': { status: 'nominal' }
    };
    
    // 1. ç©çå®ä¾åäºå¡åæ ¸ï¼å½ååºå± currentSnapshot.version é»è®¤ä¸º 1
    const kernel = new TransactionKernel(initialRegistry);

    // 2. æµè¯æ­£å¸¸æäº¤é¾è·¯
    const validPatches: StatePatch[] = [
      { targetKey: 'core_scheduler_memory', value: { status: 'active_running' } }
    ];
    const success = kernel.commitTransaction(validPatches, 1); // ä¼ å¥é¢æçæ¬å· 1
    expect(success).toBe(true);
    expect(kernel.getSnapshot().version).toBe(2); // çæ¬åå­æ§èªå¢ä¸º 2
    expect(kernel.getSnapshot().data['core_scheduler_memory'].status).toBe('active_running');

    // 3. æµè¯çæ¬å²çªæ¦æªé¾è·¯ (OCC)
    const conflictPatches: StatePatch[] = [
      { targetKey: 'core_scheduler_memory', value: { status: 'hacked_state' } }
    ];
    // ææä¼ å¥å·²ç»è¿æçé¢æçæ¬å· 1ï¼å½åå®éçæ¬å·²ç»æ¯ 2ï¼
    const conflictResult = kernel.commitTransaction(conflictPatches, 1);
    expect(conflictResult).toBe(false); // è§¦åå²çªæ¦æªï¼æç»æäº¤
    expect(kernel.getSnapshot().version).toBe(2); // çæ¬å·ç¨³åºéå®å¨ 2
    expect(kernel.getSnapshot().data['core_scheduler_memory'].status).toBe('active_running'); // æ°æ®æªè¢«èå

    // 4. æµè¯äºå¡å¨è¿­ä»£ patches åºç¨å¤±è´¥æ¶ï¼try-catch ä»£ç åä¸­èªå¨è§¦å this.rollback() çåºæ¥åå·èªæè½å
    // ææå¨ patches æ°ç»ä¸­æ··å¥ä¸ä¸ª undefined é¡¹ï¼ä½¿å¾ for å¾ªç¯å¨æ§è¡ patch.targetKey æ¶ç©çå¼ç TypeError
    const brokenPatches = [
      { targetKey: 'core_scheduler_memory', value: { status: 'broken_dirty_data' } },
      undefined as unknown as StatePatch
    ];

    // æ§è¡æäº¤ãåçå´©æºåï¼catch åæè·å¹¶æ§è¡ this.rollback()ï¼æ ¹æ®ç©çæºç ï¼rollback æåæç»è¿åå¸å°å¼ true
    // Commit must NOT silently report success. Surface the error to the caller.
    expect(() => kernel.commitTransaction(brokenPatches, 2)).toThrow(/ERR_TX_PATCH_APPLY_FAILED/);

    // æ ¸å¿èªææ­è¨ï¼æ£æ¥åæ»åçåºå±ç©çç¶æå¿«ç§
    const finalSnapshot = kernel.getSnapshot();
    expect(finalSnapshot.version).toBe(2); // çæ¬å·å¿é¡»åå­æ§åæ»åå·å° 2ï¼æç»åæéè¯¯ç 3
    expect(finalSnapshot.data['core_scheduler_memory'].status).toBe('active_running'); // åä¸æ­¥åå¥ç broken_dirty_data å¿é¡»è¢«å½»åºæ¹é¤ï¼ç¶æå®å¥½å¦åï¼
  });
});