// ─────────────────────────────────────────────────────────────────
// tokenfamily.go — Token 轮换族复用检测
// (从 TS src/security/tokenFamily.ts 迁移 — security 高级特性补齐)
//
// 核心语义: 客户端用某个 token 来请求, 服务端判定:
//
//	allow            token 有效 (active)
//	allow_in_grace   已 rotating 但仍在宽限期内 (网络重试容忍)
//	reuse_detected   已 rotating 且过了宽限期 → 攻击信号 → 整族吊销
//	revoked          已被吊销
//	unknown          不在金库中 (可能来自 env 或未知源)
//
// 复用检测命中 → revokeFamily(reuse_detected) → 整族物理拒绝,
// 攻击者持有的旧 token 与失主的新 token 一起失效 (防窃取后持续使用)。
// ─────────────────────────────────────────────────────────────────
package security

import "time"

// ReuseDecision 复用检测判定 (对齐 TS ReuseCheckResult.decision)
type ReuseDecision string

const (
	ReuseAllow        ReuseDecision = "allow"
	ReuseAllowInGrace ReuseDecision = "allow_in_grace"
	ReuseDetected     ReuseDecision = "reuse_detected"
	ReuseRevoked      ReuseDecision = "revoked"
	ReuseUnknown      ReuseDecision = "unknown"
)

// ReuseCheckResult 复用检测结果 (对齐 TS ReuseCheckResult)
type ReuseCheckResult struct {
	Decision   ReuseDecision `json:"decision"`
	Record     *TokenRecord  `json:"-"`
	Family     *FamilyRecord `json:"-"`
	Reason     string        `json:"reason"`
	GraceUntil int64         `json:"graceUntil"`
}

// CheckReuse 核心检查 (对齐 TS checkReuse)。
// bearer 为客户端传的明文 token。
func (s *TokenStore) CheckReuse(bearer string, now time.Time) ReuseCheckResult {
	if bearer == "" {
		return ReuseCheckResult{Decision: ReuseUnknown, Reason: "empty_bearer"}
	}
	if now.IsZero() {
		now = time.Now()
	}
	record := s.FindByToken(bearer)
	if record == nil {
		return ReuseCheckResult{Decision: ReuseUnknown, Reason: "not_in_vault"}
	}

	switch record.Status {
	case TokenRevoked:
		return ReuseCheckResult{Decision: ReuseRevoked, Record: record, Reason: "token_revoked"}
	case TokenActive:
		return ReuseCheckResult{Decision: ReuseAllow, Record: record, Reason: "active"}
	case TokenRotating:
		grace := record.GraceUntil
		if grace == 0 {
			grace = record.RotatedAt
		}
		if now.UnixMilli() <= grace {
			return ReuseCheckResult{
				Decision: ReuseAllowInGrace, Record: record,
				Reason: "in_grace_period", GraceUntil: grace,
			}
		}
		// 已过宽限期, 有人偷了旧 token 来用 → 攻击信号
		return ReuseCheckResult{
			Decision: ReuseDetected, Record: record,
			Reason: "past_grace_period", GraceUntil: grace,
		}
	default:
		return ReuseCheckResult{Decision: ReuseUnknown, Record: record, Reason: "unknown_status"}
	}
}

// HandleReuseDetected 检测到复用攻击 → 吊销整族。
// 返回被吊销的 token 数量 (对齐 TS handleReuseDetected)。
func (s *TokenStore) HandleReuseDetected(record *TokenRecord, now time.Time) int {
	if record == nil {
		return 0
	}
	return s.RevokeFamily(record.FamilyID, FamilyRevokeReuse, now)
}
