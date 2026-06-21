package types

// GitFile represents a single file change in the working tree.
type GitFile struct {
	Name     string `json:"name"`
	Status   string `json:"status"`   // modified | untracked | added | deleted | renamed
	Staged   bool   `json:"staged"`
	RawType  string `json:"rawType"`
}

// CommitLog represents a single commit entry.
type CommitLog struct {
	Hash         string `json:"hash"`
	Author       string `json:"author"`
	RelativeTime string `json:"relativeTime"`
	Message      string `json:"message"`
}

// StatusResponse is returned by /api/git/status.
type StatusResponse struct {
	Success     bool        `json:"success"`
	Initialized bool        `json:"initialized"`
	Branch      string      `json:"branch"`
	RemoteURL   string      `json:"remoteUrl"`
	UserName    string      `json:"userName"`
	UserEmail   string      `json:"userEmail"`
	Files       []GitFile   `json:"files"`
	Commits     []CommitLog `json:"commits"`
	Error       string      `json:"error,omitempty"`
}

// MessageResponse is a generic success/error response.
type MessageResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

// BranchesResponse is returned by /api/git/branches.
type BranchesResponse struct {
	Success  bool     `json:"success"`
	Branches []string `json:"branches"`
	Current  string   `json:"current"`
	Error    string   `json:"error,omitempty"`
}

// DiffResponse is returned by /api/git/diff.
type DiffResponse struct {
	Success bool   `json:"success"`
	Diff    string `json:"diff,omitempty"`
	Error   string `json:"error,omitempty"`
}

// FileDiffResponse is returned by /api/git/file-diff.
type FileDiffResponse struct {
	Success     bool   `json:"success"`
	Diff        string `json:"diff,omitempty"`
	HasConflict bool   `json:"hasConflict"`
	RawContent  string `json:"rawContent,omitempty"`
	Error       string `json:"error,omitempty"`
}

// InitRequest for POST /api/git/init.
type InitRequest struct{}

// ConfigRequest for POST /api/git/config.
type ConfigRequest struct {
	UserName  string `json:"userName"`
	UserEmail string `json:"userEmail"`
	RemoteURL string `json:"remoteUrl"`
}

// AddRequest for POST /api/git/add.
type AddRequest struct {
	FilePaths []string `json:"filePaths"`
}

// CommitRequest for POST /api/git/commit.
type CommitRequest struct {
	Message     string `json:"message"`
	GPGSign     bool   `json:"gpgSign"`
	AuthorEmail string `json:"authorEmail"`
	AuthorName  string `json:"authorName"`
}

// PushRequest for POST /api/git/push.
type PushRequest struct {
	RemoteURL string `json:"remoteUrl"`
	Token     string `json:"token"`
	Branch    string `json:"branch"`
	Force     bool   `json:"force"`
}

// CheckoutRequest for POST /api/git/checkout.
type CheckoutRequest struct {
	Branch string `json:"branch"`
	Create bool   `json:"create"`
}

// ResolveConflictRequest for POST /api/git/resolve-conflict.
type ResolveConflictRequest struct {
	File       string `json:"file"`
	Resolution string `json:"resolution"` // ours | theirs | both
}
