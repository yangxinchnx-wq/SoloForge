package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"

	"git-service/gitops"
	"git-service/types"
)

// Handler holds the repo path and provides HTTP handlers.
type Handler struct {
	RepoPath string
}

// New creates a new Handler with the given repo path.
func New(repoPath string) *Handler {
	abs, err := filepath.Abs(repoPath)
	if err != nil {
		abs = repoPath
	}
	return &Handler{RepoPath: abs}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (h *Handler) GetStatus(w http.ResponseWriter, r *http.Request) {
	resp, err := gitops.GetStatus(h.RepoPath)
	if err != nil {
		writeJSON(w, 500, types.StatusResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) PostInit(w http.ResponseWriter, r *http.Request) {
	if gitops.IsRepo(h.RepoPath) {
		writeJSON(w, 200, types.MessageResponse{Success: true, Message: "仓库已是 Git 资源库，无需再次初始化。"})
		return
	}
	_, err := gitops.InitRepo(h.RepoPath)
	if err != nil {
		writeJSON(w, 500, types.MessageResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, types.MessageResponse{Success: true, Message: "本地 Git 仓库创建并初始化成功！"})
}

func (h *Handler) PostConfig(w http.ResponseWriter, r *http.Request) {
	var req types.ConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "请求格式错误"})
		return
	}
	resp, err := gitops.SetConfig(h.RepoPath, req.UserName, req.UserEmail, req.RemoteURL)
	if err != nil {
		writeJSON(w, 500, types.MessageResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) PostAdd(w http.ResponseWriter, r *http.Request) {
	var req types.AddRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "请求格式错误"})
		return
	}
	resp, err := gitops.AddFiles(h.RepoPath, req.FilePaths)
	if err != nil {
		writeJSON(w, 500, types.MessageResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) PostCommit(w http.ResponseWriter, r *http.Request) {
	var req types.CommitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "请求格式错误"})
		return
	}
	if req.Message == "" {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "提交信息不能为空"})
		return
	}
	resp, err := gitops.Commit(h.RepoPath, req.Message, req.AuthorName, req.AuthorEmail)
	if err != nil {
		writeJSON(w, 500, types.MessageResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) PostPush(w http.ResponseWriter, r *http.Request) {
	var req types.PushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "请求格式错误"})
		return
	}
	branch := req.Branch
	if branch == "" {
		branch = "main"
	}
	resp, err := gitops.Push(h.RepoPath, req.RemoteURL, req.Token, branch, req.Force)
	if err != nil {
		writeJSON(w, 500, types.MessageResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) GetBranches(w http.ResponseWriter, r *http.Request) {
	resp, err := gitops.GetBranches(h.RepoPath)
	if err != nil {
		writeJSON(w, 500, types.BranchesResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) PostCheckout(w http.ResponseWriter, r *http.Request) {
	var req types.CheckoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "请求格式错误"})
		return
	}
	if req.Branch == "" {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "分支名不能为空"})
		return
	}
	resp, err := gitops.Checkout(h.RepoPath, req.Branch, req.Create)
	if err != nil {
		writeJSON(w, 500, types.MessageResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) GetDiff(w http.ResponseWriter, r *http.Request) {
	hash := r.URL.Query().Get("hash")
	if hash == "" {
		writeJSON(w, 400, types.DiffResponse{Success: false, Error: "哈希值不能为空"})
		return
	}
	resp, err := gitops.GetCommitDiff(h.RepoPath, hash)
	if err != nil {
		writeJSON(w, 500, types.DiffResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) GetFileDiff(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		writeJSON(w, 400, types.FileDiffResponse{Success: false, Error: "文件名不能为空"})
		return
	}
	resp, err := gitops.GetFileDiff(h.RepoPath, file)
	if err != nil {
		writeJSON(w, 500, types.FileDiffResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) PostResolveConflict(w http.ResponseWriter, r *http.Request) {
	var req types.ResolveConflictRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "请求格式错误"})
		return
	}
	if req.File == "" || req.Resolution == "" {
		writeJSON(w, 400, types.MessageResponse{Success: false, Error: "文件路径和解决方案不能为空"})
		return
	}
	resp, err := gitops.ResolveConflict(h.RepoPath, req.File, req.Resolution)
	if err != nil {
		writeJSON(w, 500, types.MessageResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

// RegisterRoutes registers all git API routes on the given mux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/git/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			h.GetStatus(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/init", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.PostInit(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.PostConfig(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/add", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.PostAdd(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/commit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.PostCommit(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/push", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.PostPush(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/branches", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			h.GetBranches(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/checkout", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.PostCheckout(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/diff", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			h.GetDiff(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/file-diff", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			h.GetFileDiff(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/git/resolve-conflict", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.PostResolveConflict(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})

	log.Printf("[git-service] Routes registered for repo: %s", h.RepoPath)
}

// CORS middleware wraps a handler to allow cross-origin requests.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// StartServer starts the git service HTTP server on the given port.
func StartServer(port, repoPath string) error {
	h := New(repoPath)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	// Health check
	mux.HandleFunc("/api/git/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]interface{}{
			"success":  true,
			"service":  "git-service",
			"repoPath": h.RepoPath,
			"hasRepo":  gitops.IsRepo(h.RepoPath),
		})
	})

	addr := "0.0.0.0:" + port
	log.Printf("[git-service] Starting git-service on %s (repo: %s)", addr, h.RepoPath)
	return http.ListenAndServe(addr, CORS(mux))
}
