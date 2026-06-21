import { useState, useEffect, useCallback } from 'react';
import { gitApi } from './api';
import type { GitStatusData } from './types';

export type SubTab = 'changes' | 'history' | 'settings';

export interface FeedbackState {
  type: 'success' | 'error';
  text: string;
}

export function useGit() {
  const [loading, setLoading] = useState(false);
  const [statusData, setStatusData] = useState<GitStatusData | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('changes');
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [branches, setBranches] = useState<string[]>([]);

  // Config state
  const [remoteUrl, setRemoteUrl] = useState('');
  const [accessToken, setAccessToken] = useState(() => localStorage.getItem('git_access_token') || '');
  const [targetBranch, setTargetBranch] = useState('main');
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [commitMessage, setCommitMessage] = useState('');

  // Push state
  const [pushProgress, setPushProgress] = useState<number | null>(null);
  const [pushSuccessState, setPushSuccessState] = useState(false);

  // Diff modal state
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffTitle, setDiffTitle] = useState('');
  const [diffHasConflict, setDiffHasConflict] = useState(false);
  const [diffFileName, setDiffFileName] = useState<string | null>(null);

  const showFeedback = useCallback((type: 'success' | 'error', text: string) => {
    setFeedback({ type, text });
    setTimeout(() => {
      setFeedback(prev => (prev?.text === text ? null : prev));
    }, 6000);
  }, []);

  const fetchGitStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await gitApi.getStatus();
      if (data.success) {
        setStatusData(data);
        if (data.initialized) {
          setRemoteUrl(data.remoteUrl || '');
          setUserName(data.userName || '');
          setUserEmail(data.userEmail || '');
          setTargetBranch(data.branch || 'main');
        }
      } else {
        showFeedback('error', data.error || '获取 Git 状态失败');
      }
    } catch (err: any) {
      showFeedback('error', err.message || '连接 Git 服务出错');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [showFeedback]);

  const fetchBranches = useCallback(async () => {
    try {
      const data = await gitApi.getBranches();
      if (data.success) {
        setBranches(data.branches || []);
        if (data.current) setTargetBranch(data.current);
      }
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    fetchGitStatus();
  }, [fetchGitStatus]);

  const initializeRepository = useCallback(async () => {
    setLoading(true);
    try {
      const data = await gitApi.init();
      if (data.success) {
        showFeedback('success', data.message || '仓库初始化成功！');
        await fetchGitStatus();
      } else {
        showFeedback('error', data.error || '初始化失败');
      }
    } catch {
      showFeedback('error', '初始化请求失败');
    } finally {
      setLoading(false);
    }
  }, [showFeedback, fetchGitStatus]);

  const stageFile = useCallback(async (filePath?: string) => {
    setLoading(true);
    try {
      const data = await gitApi.addFiles(filePath ? [filePath] : []);
      if (data.success) {
        showFeedback('success', filePath ? `已暂存: ${filePath}` : '已暂存所有更改');
        await fetchGitStatus(true);
      } else {
        showFeedback('error', data.error || '暂存失败');
      }
    } catch {
      showFeedback('error', '暂存请求失败');
    } finally {
      setLoading(false);
    }
  }, [showFeedback, fetchGitStatus]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) {
      showFeedback('error', '提交信息不能为空');
      return;
    }
    setLoading(true);
    try {
      const data = await gitApi.commit(commitMessage, userName, userEmail);
      if (data.success) {
        showFeedback('success', data.message || '提交成功！');
        setCommitMessage('');
        await fetchGitStatus();
      } else {
        showFeedback('error', data.error || '提交失败');
      }
    } catch {
      showFeedback('error', '提交请求失败');
    } finally {
      setLoading(false);
    }
  }, [commitMessage, userName, userEmail, showFeedback, fetchGitStatus]);

  const handlePush = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setPushSuccessState(false);
    setPushProgress(5);

    let currentProgress = 5;
    const intervalId = setInterval(() => {
      if (currentProgress < 90) {
        currentProgress += Math.floor(Math.random() * 15) + 3;
        if (currentProgress > 90) currentProgress = 90;
        setPushProgress(currentProgress);
      }
    }, 150);

    try {
      const data = await gitApi.push(remoteUrl, accessToken, targetBranch);
      clearInterval(intervalId);

      if (data.success) {
        setPushProgress(100);
        setPushSuccessState(true);
        showFeedback('success', `推送成功！已推送到 ${targetBranch} 分支`);
        await fetchGitStatus(true);
        setTimeout(() => {
          setPushSuccessState(false);
          setPushProgress(null);
        }, 2200);
      } else {
        showFeedback('error', data.error || '推送失败');
        setPushProgress(null);
      }
    } catch {
      clearInterval(intervalId);
      showFeedback('error', '推送请求出错');
      setPushProgress(null);
    } finally {
      setLoading(false);
    }
  }, [loading, remoteUrl, accessToken, targetBranch, showFeedback, fetchGitStatus]);

  const handleSaveConfig = useCallback(async () => {
    setLoading(true);
    try {
      localStorage.setItem('git_access_token', accessToken);
      const data = await gitApi.setConfig(userName, userEmail, remoteUrl);
      if (data.success) {
        showFeedback('success', '配置已保存');
        await fetchGitStatus();
      } else {
        showFeedback('error', data.error || '保存配置失败');
      }
    } catch {
      showFeedback('error', '配置请求出错');
    } finally {
      setLoading(false);
    }
  }, [accessToken, userName, userEmail, remoteUrl, showFeedback, fetchGitStatus]);

  const handleCheckoutBranch = useCallback(async (branchName: string, createNew = false) => {
    setLoading(true);
    try {
      const data = await gitApi.checkout(branchName, createNew);
      if (data.success) {
        showFeedback('success', data.message || `已切换到 ${branchName}`);
        await fetchGitStatus();
      } else {
        showFeedback('error', data.error || '切换分支失败');
      }
    } catch {
      showFeedback('error', '切换分支请求失败');
    } finally {
      setLoading(false);
    }
  }, [showFeedback, fetchGitStatus]);

  const handleViewCommitDiff = useCallback(async (hash: string) => {
    setLoading(true);
    try {
      const data = await gitApi.getCommitDiff(hash);
      if (data.success) {
        setDiffContent(data.diff || null);
        setDiffTitle(`Commit: ${hash}`);
        setDiffHasConflict(false);
        setDiffFileName(null);
        setDiffModalOpen(true);
      } else {
        showFeedback('error', data.error || '获取差异失败');
      }
    } catch {
      showFeedback('error', '获取差异请求失败');
    } finally {
      setLoading(false);
    }
  }, [showFeedback]);

  const handleViewFileDiff = useCallback(async (fileName: string) => {
    setLoading(true);
    try {
      const data = await gitApi.getFileDiff(fileName);
      if (data.success) {
        setDiffContent(data.diff || null);
        setDiffTitle('工作区差异对比');
        setDiffHasConflict(data.hasConflict);
        setDiffFileName(fileName);
        setDiffModalOpen(true);
      } else {
        showFeedback('error', data.error || '获取文件差异失败');
      }
    } catch {
      showFeedback('error', '获取文件差异请求出错');
    } finally {
      setLoading(false);
    }
  }, [showFeedback]);

  const handleResolveConflict = useCallback(async (resolution: 'ours' | 'theirs' | 'both') => {
    if (!diffFileName) return;
    setLoading(true);
    try {
      const data = await gitApi.resolveConflict(diffFileName, resolution);
      if (data.success) {
        showFeedback('success', data.message || '冲突已解决');
        setDiffModalOpen(false);
        setDiffFileName(null);
        setDiffContent(null);
        setDiffHasConflict(false);
        await fetchGitStatus(true);
      } else {
        showFeedback('error', data.error || '解决冲突失败');
      }
    } catch {
      showFeedback('error', '解决冲突请求出错');
    } finally {
      setLoading(false);
    }
  }, [diffFileName, showFeedback, fetchGitStatus]);

  const closeDiffModal = useCallback(() => {
    setDiffModalOpen(false);
    setDiffContent(null);
    setDiffFileName(null);
    setDiffHasConflict(false);
  }, []);

  const stagedFiles = statusData?.files?.filter(f => f.staged) || [];
  const unstagedFiles = statusData?.files?.filter(f => !f.staged) || [];

  return {
    // State
    loading,
    statusData,
    activeSubTab,
    feedback,
    branches,
    remoteUrl,
    accessToken,
    targetBranch,
    userName,
    userEmail,
    commitMessage,
    pushProgress,
    pushSuccessState,
    diffModalOpen,
    diffContent,
    diffTitle,
    diffHasConflict,
    diffFileName,
    stagedFiles,
    unstagedFiles,

    // Setters
    setActiveSubTab,
    setRemoteUrl,
    setAccessToken,
    setTargetBranch,
    setUserName,
    setUserEmail,
    setCommitMessage,
    setFeedback,

    // Actions
    fetchGitStatus,
    fetchBranches,
    initializeRepository,
    stageFile,
    handleCommit,
    handlePush,
    handleSaveConfig,
    handleCheckoutBranch,
    handleViewCommitDiff,
    handleViewFileDiff,
    handleResolveConflict,
    closeDiffModal,
    showFeedback,
  };
}
