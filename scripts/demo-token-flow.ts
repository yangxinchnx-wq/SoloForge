/**
 * CLI 端到端测试 (单进程, 跑全 init/rotate/revoke 流程)
 */
import { tokenStoreInit, listActiveKids, findByKid } from '../src/security/tokenStore';
import { checkReuse, processBearerToken } from '../src/security/tokenFamily';
import { createToken, revokeToken, revokeFamily } from '../src/security/tokenStore';
import { __resetTokenStoreCacheForTest } from '../src/security/tokenStore';

(async () => {
  console.log('===== 端到端流程演示 =====');
  __resetTokenStoreCacheForTest();
  await tokenStoreInit();

  console.log('\n[1] init: 创建第一个 active token');
  const t1 = await createToken({ source: 'init' });
  console.log(`  kid=${t1.kid}, family=${t1.familyId}, token=${t1.token.slice(0, 12)}...`);

  console.log('\n[2] 主动 rotate: 旧 token 进入 rotating, 新 active');
  const t2 = await createToken({ parentKid: t1.kid, source: 'rotate', graceMs: 30_000 });
  console.log(`  t1.status=${(await findByKid(t1.kid))!.status} (rotating)`);
  console.log(`  t2.kid=${t2.kid}, status=${t2.status} (active)`);

  console.log('\n[3] 客户端用 t1 (rotating) 在 grace period 内访问: 仍允许');
  const r3 = await checkReuse(t1.token);
  console.log(`  decision=${r3.decision}`);

  console.log('\n[4] 模拟攻击: 同一个 t1 在 grace 之外被使用 (注入 now=很久之后)');
  const r4 = await processBearerToken({ bearer: t1.token, now: Date.now() + 999_999_999, autoRevokeFamily: true });
  console.log(`  decision=${r4.decision}, autoRevokedTokens=${r4.autoRevokedTokens}`);
  console.log(`  t2.status=${(await findByKid(t2.kid))!.status} (也应被整族吊销)`);

  console.log('\n[5] 再次用 t2 访问: 应被拒 (整族 revoked)');
  const r5 = await checkReuse(t2.token);
  console.log(`  decision=${r5.decision}`);

  console.log('\n[6] listActiveKids:');
  const all = await listActiveKids();
  for (const e of all) {
    console.log(`  ${e.kid}  status=${e.status}  family=${e.familyId}`);
  }
  console.log('\n===== 演示结束 =====');
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
