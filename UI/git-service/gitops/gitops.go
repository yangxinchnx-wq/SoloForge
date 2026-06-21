package gitops

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"git-service/types"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport/http"
)

// relativeTime formats a time.Time into a human-readable relative string (Chinese).
func relativeTime(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "刚刚"
	case d < time.Hour:
		return fmt.Sprintf("%d 分钟前", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d 小时前", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%d 天前", int(d.Hours()/24))
	case d < 365*24*time.Hour:
		return fmt.Sprintf("%d 个月前", int(d.Hours()/(24*30)))
	default:
		return fmt.Sprintf("%d 年前", int(d.Hours()/(24*365)))
	}
}

// OpenRepo opens an existing git repository at the given path.
func OpenRepo(repoPath string) (*git.Repository, error) {
	return git.PlainOpen(repoPath)
}

// IsRepo checks if a valid git repository exists at the given path.
func IsRepo(repoPath string) bool {
	_, err := git.PlainOpen(repoPath)
	return err == nil
}

// InitRepo initializes a new git repository at the given path.
func InitRepo(repoPath string) (*git.Repository, error) {
	repo, err := git.PlainInit(repoPath, false)
	if err != nil {
		return nil, err
	}
	// Create a default .gitignore if not present
	ignorePath := filepath.Join(repoPath, ".gitignore")
	if _, err := os.Stat(ignorePath); os.IsNotExist(err) {
		os.WriteFile(ignorePath, []byte("node_modules/\ndist/\n.env\n*.local\n.env.production\n"), 0644)
	}
	return repo, nil
}

// GetStatus returns the full git status including branch, files, and commits.
func GetStatus(repoPath string) (*types.StatusResponse, error) {
	if !IsRepo(repoPath) {
		return &types.StatusResponse{
			Success:     true,
			Initialized: false,
			Files:       []types.GitFile{},
			Commits:     []types.CommitLog{},
		}, nil
	}

	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open repo: %w", err)
	}

	// Get current branch
	headRef, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("failed to get HEAD: %w", err)
	}
	branch := headRef.Name().Short()

	// Get remote URL
	remoteURL := ""
	if remote, err := repo.Remote("origin"); err == nil {
		if urls := remote.Config().URLs; len(urls) > 0 {
			remoteURL = urls[0]
		}
	}

	// Get user config
	cfg, err := repo.Config()
	if err != nil {
		return nil, fmt.Errorf("failed to get config: %w", err)
	}
	userName := cfg.Author.Name
	userEmail := cfg.Author.Email

	// Get working tree status
	worktree, err := repo.Worktree()
	if err != nil {
		return nil, fmt.Errorf("failed to get worktree: %w", err)
	}
	status, err := worktree.Status()
	if err != nil {
		return nil, fmt.Errorf("failed to get status: %w", err)
	}

	// Build file list from status
	var files []types.GitFile
	for path, fileStatus := range status {
		// go-git status codes: X = staging area, Y = worktree
		// '?' = untracked, 'M' = modified, 'A' = added, 'D' = deleted, 'R' = renamed
		x := fileStatus.Staging
		y := fileStatus.Worktree

		var statusStr string
		var staged bool

		if x == '?' && y == '?' {
			statusStr = "untracked"
			staged = false
		} else {
			// Check staging area first
			if x != '?' && x != ' ' && x != 0 {
				staged = true
				switch x {
				case 'M':
					statusStr = "modified"
				case 'A':
					statusStr = "added"
				case 'D':
					statusStr = "deleted"
				case 'R':
					statusStr = "renamed"
				default:
					statusStr = "modified"
				}
			}
			// Check worktree
			if y != '?' && y != ' ' && y != 0 {
				if !staged {
					staged = false
					switch y {
					case 'M':
						statusStr = "modified"
					case 'D':
						statusStr = "deleted"
					default:
						statusStr = "modified"
					}
				}
			}
		}

		if statusStr == "" {
			statusStr = "modified"
		}

		// Get file modification time
		mtime := ""
		if fi, err := os.Stat(filepath.Join(repoPath, path)); err == nil {
			mtime = fi.ModTime().Format("01-02 15:04")
		}

		rawType := string(x) + string(y)
		files = append(files, types.GitFile{
			Name:    path,
			Status:  statusStr,
			Staged:  staged,
			RawType: rawType,
			Mtime:   mtime,
		})
	}

	// Sort files by name for consistent output
	sort.Slice(files, func(i, j int) bool {
		return files[i].Name < files[j].Name
	})

	// Get recent commits
	commits, err := getRecentCommits(repo, 15)
	if err != nil {
		commits = []types.CommitLog{} // non-fatal
	}

	return &types.StatusResponse{
		Success:     true,
		Initialized: true,
		Branch:      branch,
		RemoteURL:   remoteURL,
		UserName:    userName,
		UserEmail:   userEmail,
		Files:       files,
		Commits:     commits,
	}, nil
}

// getRecentCommits returns the N most recent commits.
func getRecentCommits(repo *git.Repository, count int) ([]types.CommitLog, error) {
	headRef, err := repo.Head()
	if err != nil {
		return nil, err
	}

	commitIter, err := repo.Log(&git.LogOptions{
		From:  headRef.Hash(),
		Order: git.LogOrderCommitterTime,
	})
	if err != nil {
		return nil, err
	}

	var commits []types.CommitLog
	err = commitIter.ForEach(func(c *object.Commit) error {
		if len(commits) >= count {
			return io.EOF
		}
		commits = append(commits, types.CommitLog{
			Hash:         c.Hash.String()[:7],
			Author:       c.Author.Name,
			RelativeTime: relativeTime(c.Author.When),
			Message:      strings.Split(c.Message, "\n")[0],
		})
		return nil
	})
	if err != nil && err != io.EOF {
		return commits, err
	}
	return commits, nil
}

// GetBranches returns all local branches and the current branch name.
func GetBranches(repoPath string) (*types.BranchesResponse, error) {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, err
	}

	branches := []string{}
	current := ""

	refs, err := repo.References()
	if err != nil {
		return nil, err
	}

	headRef, err := repo.Head()
	if err != nil {
		return nil, err
	}

	err = refs.ForEach(func(ref *plumbing.Reference) error {
		if ref.Name().IsBranch() {
			name := ref.Name().Short()
			branches = append(branches, name)
			if ref.Hash() == headRef.Hash() {
				current = name
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// If current not found by hash match, try by HEAD symbolic target
	if current == "" {
		current = headRef.Name().Short()
	}

	sort.Strings(branches)

	return &types.BranchesResponse{
		Success:  true,
		Branches: branches,
		Current:  current,
	}, nil
}

// Checkout switches to an existing branch or creates a new one.
func Checkout(repoPath, branch string, create bool) (*types.MessageResponse, error) {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, err
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return nil, err
	}

	if create {
		err = worktree.Checkout(&git.CheckoutOptions{
			Branch: plumbing.NewBranchReferenceName(branch),
			Create: true,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to create branch %s: %w", branch, err)
		}
		return &types.MessageResponse{
			Success: true,
			Message: fmt.Sprintf("已创建并切换到新分支 %s", branch),
		}, nil
	}

	err = worktree.Checkout(&git.CheckoutOptions{
		Branch: plumbing.NewBranchReferenceName(branch),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to checkout branch %s: %w", branch, err)
	}

	return &types.MessageResponse{
		Success: true,
		Message: fmt.Sprintf("已切换到分支 %s", branch),
	}, nil
}

// SetConfig updates the local git user config and remote URL.
func SetConfig(repoPath, userName, userEmail, remoteURL string) (*types.MessageResponse, error) {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, err
	}

	cfg, err := repo.Config()
	if err != nil {
		return nil, err
	}

	if userName != "" {
		cfg.Author.Name = userName
	}
	if userEmail != "" {
		cfg.Author.Email = userEmail
	}

	// Handle remote URL
	if remoteURL != "" {
		found := false
		for i, r := range cfg.Remotes {
			if r.Name == "origin" {
				cfg.Remotes[i].URLs = []string{remoteURL}
				found = true
				break
			}
		}
		if !found {
			cfg.Remotes["origin"] = &config.RemoteConfig{
				Name:  "origin",
				URLs:  []string{remoteURL},
			}
		}
	} else {
		delete(cfg.Remotes, "origin")
	}

	if err := repo.SetConfig(cfg); err != nil {
		return nil, err
	}

	return &types.MessageResponse{
		Success: true,
		Message: "Git 配置已更新",
	}, nil
}

// AddFiles stages specified files, or all files if filePaths is empty.
func AddFiles(repoPath string, filePaths []string) (*types.MessageResponse, error) {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, err
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return nil, err
	}

	if len(filePaths) == 0 {
		// Stage all
		if err := worktree.AddGlob("."); err != nil {
			return nil, fmt.Errorf("failed to stage all files: %w", err)
		}
	} else {
		for _, fp := range filePaths {
			if _, err := worktree.Add(fp); err != nil {
				return nil, fmt.Errorf("failed to stage %s: %w", fp, err)
			}
		}
	}

	return &types.MessageResponse{
		Success: true,
		Message: "文件已暂存",
	}, nil
}

// Commit creates a new commit with the given message and optional author info.
func Commit(repoPath, message, authorName, authorEmail string) (*types.MessageResponse, error) {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, err
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return nil, err
	}

	// Update config if author info provided
	if authorName != "" || authorEmail != "" {
		cfg, err := repo.Config()
		if err != nil {
			return nil, err
		}
		if authorName != "" {
			cfg.Author.Name = authorName
		}
		if authorEmail != "" {
			cfg.Author.Email = authorEmail
		}
		if err := repo.SetConfig(cfg); err != nil {
			return nil, err
		}
	}

	hash, err := worktree.Commit(message, &git.CommitOptions{
		Author: &object.Signature{
			Name:  authorName,
			Email: authorEmail,
			When:  time.Now(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("commit failed: %w", err)
	}

	return &types.MessageResponse{
		Success: true,
		Message: fmt.Sprintf("提交成功: %s", hash.String()[:7]),
	}, nil
}

// Push pushes to the remote repository.
func Push(repoPath, remoteURL, token, branch string, force bool) (*types.MessageResponse, error) {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, err
	}

	// Determine the remote URL to use
	targetURL := remoteURL
	if targetURL == "" {
		remote, err := repo.Remote("origin")
		if err != nil {
			return nil, fmt.Errorf("未配置远程仓库")
		}
		urls := remote.Config().URLs
		if len(urls) == 0 {
			return nil, fmt.Errorf("远程仓库 URL 为空")
		}
		targetURL = urls[0]
	}

	// Build auth
	var auth *http.BasicAuth
	if token != "" {
		auth = &http.BasicAuth{
			Username: "token",
			Password: token,
		}
	}

	refSpec := fmt.Sprintf("refs/heads/%s:refs/heads/%s", branch, branch)

	err = repo.Push(&git.PushOptions{
		RemoteName: "origin",
		RemoteURL:  targetURL,
		RefSpecs:   []config.RefSpec{config.RefSpec(refSpec)},
		Auth:       auth,
		Force:      force,
	})
	if err != nil && err != git.NoErrAlreadyUpToDate {
		return nil, fmt.Errorf("push failed: %w", err)
	}

	return &types.MessageResponse{
		Success: true,
		Message: "推送成功",
	}, nil
}

// GetCommitDiff returns the diff for a specific commit.
func GetCommitDiff(repoPath, hashStr string) (*types.DiffResponse, error) {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, err
	}

	// Resolve short hash
	hash, err := repo.ResolveRevision(plumbing.Revision(hashStr))
	if err != nil {
		return nil, fmt.Errorf("invalid commit hash: %w", err)
	}

	commit, err := repo.CommitObject(*hash)
	if err != nil {
		return nil, fmt.Errorf("commit not found: %w", err)
	}

	var buf bytes.Buffer
	fmt.Fprintf(&buf, "commit %s\n", commit.Hash)
	fmt.Fprintf(&buf, "Author: %s <%s>\n", commit.Author.Name, commit.Author.Email)
	fmt.Fprintf(&buf, "Date:   %s\n\n", commit.Author.When.Format(time.RFC1123))
	fmt.Fprintf(&buf, "    %s\n", commit.Message)

	// Get diff from parent
	if commit.NumParents() > 0 {
		parent, err := commit.Parent(0)
		if err == nil {
			patch, err := parent.Patch(commit)
			if err == nil {
				fmt.Fprintf(&buf, "\n%s", patch.String())
			}
		}
	} else {
		// First commit - show all files as additions
		tree, err := commit.Tree()
		if err == nil {
			for _, e := range tree.Entries {
				fmt.Fprintf(&buf, "+++ %s\n", e.Name)
			}
		}
	}

	return &types.DiffResponse{
		Success: true,
		Diff:    buf.String(),
	}, nil
}

// GetFileDiff returns the diff for a specific file in the working tree.
func GetFileDiff(repoPath, filePath string) (*types.FileDiffResponse, error) {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return nil, err
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return nil, err
	}

	// Read the file content
	fullPath := filepath.Join(repoPath, filePath)
	rawContent := ""
	if data, err := os.ReadFile(fullPath); err == nil {
		rawContent = string(data)
	}

	// Get diff from go-git
	status, err := worktree.Status()
	if err != nil {
		return nil, err
	}

	diffContent := ""
	fileStatus, exists := status[filePath]
	if exists {
		if fileStatus.Staging == '?' && fileStatus.Worktree == '?' {
			// Untracked file - show full content as diff
			diffContent = rawContent
		} else {
			// Use git diff for tracked files
			diffContent = getDiffForFile(repoPath, filePath)
			if diffContent == "" {
				diffContent = rawContent
			}
		}
	} else {
		diffContent = rawContent
	}

	// Check for conflict markers
	hasConflict := strings.Contains(rawContent, "<<<<<<<") &&
		strings.Contains(rawContent, "=======") &&
		strings.Contains(rawContent, ">>>>>>>")

	return &types.FileDiffResponse{
		Success:     true,
		Diff:        diffContent,
		HasConflict: hasConflict,
		RawContent:  rawContent,
	}, nil
}

// getDiffForFile generates a diff for a tracked file by comparing worktree with HEAD.
func getDiffForFile(repoPath, filePath string) string {
	repo, err := OpenRepo(repoPath)
	if err != nil {
		return ""
	}

	headRef, err := repo.Head()
	if err != nil {
		return ""
	}

	commit, err := repo.CommitObject(headRef.Hash())
	if err != nil {
		return ""
	}

	tree, err := commit.Tree()
	if err != nil {
		return ""
	}

	// Read current file content
	fullPath := filepath.Join(repoPath, filePath)
	currentContent, err := os.ReadFile(fullPath)
	if err != nil {
		return ""
	}

	// Get file from tree
	entry, err := tree.FindEntry(filePath)
	if err != nil {
		// File is new
		return fmt.Sprintf("--- /dev/null\n+++ %s\n@@ -0,0 +1,%d @@\n%s",
			filePath, countLines(string(currentContent)), addPrefix(string(currentContent), "+"))
	}

	blob, err := repo.BlobObject(entry.Hash)
	if err != nil {
		return ""
	}

	reader, err := blob.Reader()
	if err != nil {
		return ""
	}
	oldContent, err := io.ReadAll(reader)
	if err != nil {
		return ""
	}

	// Simple diff output
	return generateSimpleDiff(filePath, string(oldContent), string(currentContent))
}

// generateSimpleDiff creates a simple unified diff between two strings.
func generateSimpleDiff(fileName, old, new_ string) string {
	oldLines := strings.Split(old, "\n")
	newLines := strings.Split(new_, "\n")

	var buf bytes.Buffer
	fmt.Fprintf(&buf, "--- a/%s\n+++ b/%s\n", fileName, fileName)

	// Simple line-by-line comparison
	maxLines := len(oldLines)
	if len(newLines) > maxLines {
		maxLines = len(newLines)
	}

	var hunks []string
	for i := 0; i < maxLines; i++ {
		oldLine := ""
		newLine := ""
		if i < len(oldLines) {
			oldLine = oldLines[i]
		}
		if i < len(newLines) {
			newLine = newLines[i]
		}

		if oldLine != newLine {
			if i < len(oldLines) {
				hunks = append(hunks, "-"+oldLine)
			}
			if i < len(newLines) {
				hunks = append(hunks, "+"+newLine)
			}
		} else {
			hunks = append(hunks, " "+oldLine)
		}
	}

	fmt.Fprintf(&buf, "@@ -1,%d +1,%d @@\n", len(oldLines), len(newLines))
	for _, h := range hunks {
		fmt.Fprintf(&buf, "%s\n", h)
	}

	return buf.String()
}

// countLines counts the number of lines in a string.
func countLines(s string) int {
	if s == "" {
		return 0
	}
	return len(strings.Split(s, "\n"))
}

// addPrefix adds a prefix to each line.
func addPrefix(s, prefix string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = prefix + line
	}
	return strings.Join(lines, "\n")
}

// ResolveConflict resolves merge conflicts in a file.
func ResolveConflict(repoPath, filePath, resolution string) (*types.MessageResponse, error) {
	fullPath := filepath.Join(repoPath, filePath)
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("文件不存在: %s", filePath)
	}

	content, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}

	if !bytes.Contains(content, []byte("<<<<<<<")) {
		return nil, fmt.Errorf("文件未检测到合并冲突")
	}

	lines := strings.Split(string(content), "\n")
	var result []string
	resolvedCount := 0
	conflictRe := regexp.MustCompile(`^<{7}`)
	separatorRe := regexp.MustCompile(`^={7}`)
	endRe := regexp.MustCompile(`^>{7}`)

	i := 0
	for i < len(lines) {
		line := lines[i]
		if conflictRe.MatchString(line) {
			var ours, theirs []string
			inOurs := true
			i++ // skip <<<<<<< line

			for i < len(lines) && !endRe.MatchString(lines[i]) {
				if separatorRe.MatchString(lines[i]) {
					inOurs = false
				} else {
					if inOurs {
						ours = append(ours, lines[i])
					} else {
						theirs = append(theirs, lines[i])
					}
				}
				i++
			}
			if i < len(lines) {
				i++ // skip >>>>>>> line
			}

			switch resolution {
			case "ours":
				result = append(result, ours...)
			case "theirs":
				result = append(result, theirs...)
			default: // both
				result = append(result, ours...)
				result = append(result, theirs...)
			}
			resolvedCount++
		} else {
			result = append(result, line)
			i++
		}
	}

	if err := os.WriteFile(fullPath, []byte(strings.Join(result, "\n")), 0644); err != nil {
		return nil, fmt.Errorf("写入文件失败: %w", err)
	}

	// Auto-stage resolved file
	if IsRepo(repoPath) {
		repo, err := OpenRepo(repoPath)
		if err == nil {
			worktree, err := repo.Worktree()
			if err == nil {
				worktree.Add(filePath)
			}
		}
	}

	return &types.MessageResponse{
		Success: true,
		Message: fmt.Sprintf("已解决 %d 个冲突，采用策略: %s", resolvedCount, resolution),
	}, nil
}
