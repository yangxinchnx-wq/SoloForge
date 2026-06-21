export interface GitFile {
  name: string;
  status: 'modified' | 'untracked' | 'added' | 'deleted' | 'renamed';
  staged: boolean;
  rawType: string;
}

export interface CommitLog {
  hash: string;
  author: string;
  relativeTime: string;
  message: string;
}

export interface GitStatusData {
  success: boolean;
  initialized: boolean;
  branch: string;
  remoteUrl: string;
  userName: string;
  userEmail: string;
  files: GitFile[];
  commits: CommitLog[];
}

export interface MessageResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface BranchesResponse {
  success: boolean;
  branches: string[];
  current: string;
  error?: string;
}

export interface DiffResponse {
  success: boolean;
  diff?: string;
  error?: string;
}

export interface FileDiffResponse {
  success: boolean;
  diff?: string;
  hasConflict: boolean;
  rawContent?: string;
  error?: string;
}
