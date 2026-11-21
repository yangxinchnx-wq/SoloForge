// ─────────────────────────────────────────────────────────────────
// routes — 安全层 HTTP 路由 (15 条, 对齐 docs/protocol.md §12.1)
//
//	vault: GET/POST /api/vault/keys, GET/PUT/DELETE /api/vault/keys/{id},
//	       GET /api/vault/keys/{id}/reveal, POST /api/vault/keys/{id}/verify,
//	       POST /api/vault/export|import|verify-passphrase
//	auth : GET /api/auth/bootstrap
//	audit: GET /api/audit/list|stats|sinks, POST /api/audit/sinks/config
//
// ─────────────────────────────────────────────────────────────────
package security

import (
	"encoding/json"
	"net/http"
)

// Register 注册安全层路由 (core main.go 调用)
func (s *Service) Register(mux *http.ServeMux) {
	// ── vault ──
	mux.HandleFunc("GET /api/vault/keys", func(w http.ResponseWriter, r *http.Request) {
		s.emit(r.Context(), "vault.list", r.URL.Path, r.Method, 200, nil)
		writeJSON(w, 200, map[string]any{"items": s.vault.List()})
	})

	mux.HandleFunc("POST /api/vault/keys", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID      string `json:"id"`
			APIKey  string `json:"apiKey"`
			BaseURL string `json:"baseUrl"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {id, apiKey, baseUrl?}"})
			return
		}
		rec, err := s.vault.SetKey(req.ID, req.APIKey, req.BaseURL)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		s.emit(r.Context(), "vault.key.created", r.URL.Path, r.Method, 200,
			map[string]any{"providerId": rec.ID})
		writeJSON(w, 200, map[string]any{"item": rec})
	})

	mux.HandleFunc("GET /api/vault/keys/{id}", func(w http.ResponseWriter, r *http.Request) {
		meta := s.vault.Meta(r.PathValue("id"))
		s.emit(r.Context(), "vault.key.get", r.URL.Path, r.Method, 200,
			map[string]any{"providerId": r.PathValue("id")})
		writeJSON(w, 200, map[string]any{"item": meta}) // meta null = 不存在 (对齐 TS 语义)
	})

	mux.HandleFunc("PUT /api/vault/keys/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var req struct {
			APIKey  string `json:"apiKey"`
			BaseURL string `json:"baseUrl"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		rec, err := s.vault.SetKey(id, req.APIKey, req.BaseURL)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		s.emit(r.Context(), "vault.key.updated", r.URL.Path, r.Method, 200,
			map[string]any{"providerId": id})
		writeJSON(w, 200, map[string]any{"item": rec})
	})

	mux.HandleFunc("DELETE /api/vault/keys/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		deleted := s.vault.Delete(id)
		s.emit(r.Context(), "vault.key.deleted", r.URL.Path, r.Method, 200,
			map[string]any{"providerId": id, "deleted": deleted})
		writeJSON(w, 200, map[string]any{"deleted": deleted})
	})

	mux.HandleFunc("GET /api/vault/keys/{id}/reveal", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		pass := r.Header.Get("X-Vault-Passphrase") // 门禁口令经 header 传入
		if !s.vault.VerifyVaultPassphrase(pass) {
			s.emit(r.Context(), "vault.reveal.denied", r.URL.Path, r.Method, 403,
				map[string]any{"providerId": id})
			writeJSON(w, 403, map[string]any{"error": "passphrase 校验失败或未设置 (POST /api/vault/verify-passphrase 设置)"})
			return
		}
		apiKey, baseURL, source, ok := s.vault.Resolve(id)
		if !ok {
			writeJSON(w, 404, map[string]any{"error": "不存在: " + id})
			return
		}
		s.emit(r.Context(), "vault.key.revealed", r.URL.Path, r.Method, 200,
			map[string]any{"providerId": id, "sensitive": true})
		writeJSON(w, 200, map[string]any{"item": map[string]any{
			"id": id, "baseUrl": baseURL, "apiKey": apiKey, "source": source,
		}})
	})

	mux.HandleFunc("POST /api/vault/keys/{id}/verify", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var req struct {
			APIKey string `json:"apiKey"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		apiKey, _, _, ok := s.vault.Resolve(id)
		match := ok && apiKey == req.APIKey
		s.emit(r.Context(), "vault.key.verified", r.URL.Path, r.Method, 200,
			map[string]any{"providerId": id, "match": match})
		writeJSON(w, 200, map[string]any{"match": match})
	})

	mux.HandleFunc("POST /api/vault/verify-passphrase", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Passphrase string `json:"passphrase"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		ok := s.vault.VerifyVaultPassphrase(req.Passphrase)
		writeJSON(w, 200, map[string]any{"match": ok, "set": s.vault.PassphraseSet()})
	})

	mux.HandleFunc("POST /api/vault/export", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Passphrase string `json:"passphrase"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Passphrase == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {passphrase}"})
			return
		}
		blob, err := s.vault.Export(req.Passphrase)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		s.emit(r.Context(), "vault.export", r.URL.Path, r.Method, 200, nil)
		writeJSON(w, 200, map[string]any{"version": 1, "blob": blob})
	})

	mux.HandleFunc("POST /api/vault/import", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Passphrase string `json:"passphrase"`
			Blob       string `json:"blob"`
			Replace    bool   `json:"replace"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Blob == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {passphrase, blob, replace?}"})
			return
		}
		n, err := s.vault.Import(req.Passphrase, req.Blob, req.Replace)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		s.emit(r.Context(), "vault.import", r.URL.Path, r.Method, 200,
			map[string]any{"imported": n})
		writeJSON(w, 200, map[string]any{"imported": n})
	})

	// ── auth ──
	mux.HandleFunc("GET /api/auth/bootstrap", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"token":    s.auth.Token(),
			"issuedAt": s.auth.IssuedAt(),
			"tenant":   s.tenant.DefaultTenant,
		})
	})

	// ── token 轮换族 v2 (keychain 高级特性; 管理面, RequireAdmin 守卫) ──
	// GET /api/auth/tokens — 非 revoked kid 清单 (审计/调试)
	mux.Handle("GET /api/auth/tokens", RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var kids []TokenKidInfo
		if s.tokens != nil {
			kids = s.tokens.ListActiveKids()
		}
		if kids == nil {
			kids = []TokenKidInfo{}
		}
		writeJSON(w, 200, map[string]any{"success": true, "kids": kids})
	})))
	// POST /api/auth/tokens/rotate — 手动轮换 (body: {parentKid}; 轮换链建立)
	mux.Handle("POST /api/auth/tokens/rotate", RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.tokens == nil {
			writeJSON(w, 501, map[string]any{"success": false, "error": "token store 未启用"})
			return
		}
		var req struct {
			ParentKID string `json:"parentKid"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ParentKID == "" {
			writeJSON(w, 400, map[string]any{"success": false, "error": "body 需为 {parentKid}"})
			return
		}
		rec, err := s.tokens.CreateToken(CreateTokenOptions{ParentKID: req.ParentKID, Source: TokenSourceManual})
		if err != nil {
			writeJSON(w, 400, map[string]any{"success": false, "error": err.Error()})
			return
		}
		s.emit(r.Context(), "token.rotation.manual", "/api/auth/tokens/rotate", "POST", 200, map[string]any{
			"parentKid": req.ParentKID, "newKid": rec.KID, "familyId": rec.FamilyID,
		})
		// 返回脱敏 (不含 token 明文)
		writeJSON(w, 200, map[string]any{"success": true, "newKid": rec.KID,
			"familyId": rec.FamilyID, "expiresAt": rec.ExpiresAt})
	})))

	// ── audit ──
	mux.HandleFunc("GET /api/audit/list", func(w http.ResponseWriter, r *http.Request) {
		events := s.store.EventsByType(EventAuditRecorded, 100)
		out := make([]map[string]any, 0, len(events))
		for _, ev := range events {
			m := map[string]any{"seq": ev.Seq, "ts": ev.TS}
			json.Unmarshal(ev.Payload, &m)
			out = append(out, m)
		}
		writeJSON(w, 200, map[string]any{"items": out})
	})

	mux.HandleFunc("GET /api/audit/stats", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		sinks := make([]SinkState, 0, len(s.sinks))
		total := uint64(0)
		for _, st := range s.sinks {
			sinks = append(sinks, *st)
			total += st.Received
		}
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"sinks": sinks, "totalReceived": total})
	})

	mux.HandleFunc("GET /api/audit/sinks", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		names := make([]string, 0, len(s.sinks))
		for name := range s.sinks {
			names = append(names, name)
		}
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"sinks": names})
	})

	mux.HandleFunc("POST /api/audit/sinks/config", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name    string `json:"name"`
			Enabled *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {name, enabled}"})
			return
		}
		s.mu.Lock()
		if st, ok := s.sinks[req.Name]; ok && req.Enabled != nil {
			// memory sink 恒开 (store 落库本身不可关)
			if req.Name != "memory" {
				st.Enabled = *req.Enabled
			}
		}
		s.mu.Unlock()
		s.emit(r.Context(), "audit.sinks.config", r.URL.Path, r.Method, 200,
			map[string]any{"sink": req.Name})
		writeJSON(w, 200, map[string]any{"ok": true})
	})
}
