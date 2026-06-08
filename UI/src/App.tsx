// ─────────────────────────────────────────────────────────────────
// SoloForge App — 主布局
// 完全按线框图：左 资源+代码 | 中 流送+历史+对话 | 右 预览 | 顶 栏 | 底 状态栏
// 接入后端：http://localhost:3001
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { useBackend, useObservation, useScheduler } from './hooks/useBackend';
import { useEventStream } from './hooks/useEventStream';
import { useChat } from './hooks/useChat';
import { useResources } from './hooks/useResources';
import { useKeyboard } from './hooks/useKeyboard';
import { useKeybindings } from './hooks/useKeybindingStore';
import { useTheme } from './themes/ThemeProvider';
import { API_BASE } from './api/client';
import { TopBar } from './components/layout/TopBar';
import { ActivityBar } from './components/layout/ActivityBar';
import { LeftSidebar } from './components/layout/LeftSidebar';
import { CenterPanels } from './components/panels/CenterPanels';
import { PreviewPane } from './components/preview/PreviewPane';
import { StatusBar } from './components/statusbar/StatusBar';
import { SettingsModal } from './components/panels/SettingsModal';
import { NotificationCenter, WelcomeNotifications, ToastCenter, pushNotification, pushToast } from './components/overlays/Notifications';
import { Splash } from './components/overlays/Splash';
import { CommandPalette } from './components/overlays/CommandPalette';
import { GlobalSearch } from './components/overlays/GlobalSearch';
import { QuickJump } from './components/overlays/QuickJump';
import { FeatureTour } from './components/overlays/FeatureTour';
import { DeployWizard } from './components/overlays/DeployWizard';
import { HotkeyCheatsheet } from './components/overlays/HotkeyCheatsheet';
import { ChatHistorySearch } from './components/overlays/ChatHistorySearch';
import { SplitCompare } from './components/overlays/SplitCompare';
import { ABTest } from './components/overlays/ABTest';
import { DetachSelector, openDetachedWindow, broadcastState, closeAllDetached } from './components/overlays/DetachedWindow';
import { CodeReview } from './components/overlays/CodeReview';
import { TaskScheduler } from './components/overlays/TaskScheduler';
import { ProjectIO } from './components/overlays/ProjectIO';
import { SkillsMarket } from './components/overlays/SkillsMarket';
import { RecentActivity } from './components/overlays/RecentActivity';
import { CollabCursors } from './components/overlays/CollabCursors';
import { BreakpointDebugger } from './components/overlays/BreakpointDebugger';
import { PluginRegistry } from './components/overlays/PluginRegistry';
import { SnippetsManager } from './components/overlays/SnippetsManager';
import { SurrealExplorer } from './components/overlays/SurrealExplorer';
import { GitTimeMachine } from './components/overlays/GitTimeMachine';
import { WorkflowPipeline } from './components/overlays/WorkflowPipeline';
import { MermaidEditor } from './components/overlays/MermaidEditor';
import { ThemeGenerator } from './components/overlays/ThemeGenerator';
import { CodeMap } from './components/overlays/CodeMap';
import { PomodoroStats } from './components/overlays/PomodoroStats';
import { RegexLab } from './components/overlays/RegexLab';
import { StickyNotes } from './components/overlays/StickyNotes';
import { Dashboard } from './components/overlays/Dashboard';
import { PromptTemplates } from './components/overlays/PromptTemplates';
import { CommandHistory } from './components/overlays/CommandHistory';
import { PerformanceMonitor } from './components/overlays/PerformanceMonitor';
import { CodingTimeline } from './components/overlays/CodingTimeline';
import { Translator } from './components/overlays/Translator';
import { SharedCollab } from './components/overlays/SharedCollab';
import { EventBrowser } from './components/overlays/EventBrowser';
import { AgentTheater } from './components/overlays/AgentTheater';
import { VoiceChat } from './components/overlays/VoiceChat';
import { AdvancedSearch } from './components/overlays/AdvancedSearch';
import { DocCollab } from './components/overlays/DocCollab';
import { LogStream } from './components/overlays/LogStream';
import { MindMap } from './components/overlays/MindMap';
import { ApiTester } from './components/overlays/ApiTester';
import { DbDesigner } from './components/overlays/DbDesigner';
import { UmlTools } from './components/overlays/UmlTools';
import { TaskBoard } from './components/overlays/TaskBoard';
import { SnapshotManager } from './components/overlays/SnapshotManager';
import { NotifierRules } from './components/overlays/NotifierRules';
import { FullTextSearch } from './components/overlays/FullTextSearch';
import { JsonTools } from './components/overlays/JsonTools';
import { CronEditor } from './components/overlays/CronEditor';
import { Changelog } from './components/overlays/Changelog';
import { EnvManager } from './components/overlays/EnvManager';
import { BookmarkManager } from './components/overlays/BookmarkManager';
import { ColorPalette } from './components/overlays/ColorPalette';
import { IconBrowser } from './components/overlays/IconBrowser';
import { DiffViewer } from './components/overlays/DiffViewer';
import { WebPreview } from './components/overlays/WebPreview';
import { NotesEditor } from './components/overlays/NotesEditor';
import { NetworkMonitor } from './components/overlays/NetworkMonitor';
import { AssetLibrary } from './components/overlays/AssetLibrary';
import { BuildMonitor } from './components/overlays/BuildMonitor';
import { WebhookTester } from './components/overlays/WebhookTester';
import { ScriptRunner } from './components/overlays/ScriptRunner';
import { QrGenerator } from './components/overlays/QrGenerator';
import { DatabaseSeeder } from './components/overlays/DatabaseSeeder';
import { K8sPanel } from './components/overlays/K8sPanel';
import { DependencyGraph } from './components/overlays/DependencyGraph';
import { LicenseAudit } from './components/overlays/LicenseAudit';
import { CostMonitor } from './components/overlays/CostMonitor';
import { TestCoverage } from './components/overlays/TestCoverage';
import { DatabaseBrowser } from './components/overlays/DatabaseBrowser';
import { ApiMonitor } from './components/overlays/ApiMonitor';
import { SecretScanner } from './components/overlays/SecretScanner';
import { PrivacyScanner } from './components/overlays/PrivacyScanner';
import { VulnScanner } from './components/overlays/VulnScanner';
import { AccessAuditor } from './components/overlays/AccessAuditor';
import { IncidentManager } from './components/overlays/IncidentManager';
import { ComplianceAudit } from './components/overlays/ComplianceAudit';
import { DataMasking } from './components/overlays/DataMasking';
import { ThreatModel } from './components/overlays/ThreatModel';
import { PromptLab } from './components/overlays/PromptLab';
import { TokenTracker } from './components/overlays/TokenTracker';
import { AgentOrchestrator } from './components/overlays/AgentOrchestrator';
import { EmbeddingExplorer } from './components/overlays/EmbeddingExplorer';
import { CacheInspector } from './components/overlays/CacheInspector';
import { DeploymentPipeline } from './components/overlays/DeploymentPipeline';
import { ExperimentBoard } from './components/overlays/ExperimentBoard';
import { ModelRegistry } from './components/overlays/ModelRegistry';
import { QueueMonitor } from './components/overlays/QueueMonitor';
import { GitWorktree } from './components/overlays/GitWorktree';
import { PRReviewer } from './components/overlays/PRReviewer';
import { KanbanBoard } from './components/overlays/KanbanBoard';
import { LoadTester } from './components/overlays/LoadTester';
import { DocGenerator } from './components/overlays/DocGenerator';
import { KnowledgeBase } from './components/overlays/KnowledgeBase';
import { TeamDirectory } from './components/overlays/TeamDirectory';
import { ReleasePlanner } from './components/overlays/ReleasePlanner';
import { Splitter } from './components/layout/Splitter';
import { ThemeEditor } from './components/overlays/ThemeEditor';

const PROJECT_KEY = 'soloforge.project.name';
const LAYOUT_KEY = 'soloforge.layout.v1';

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { leftWidth: 460, rightWidth: 420, activity: 'explorer' };
}

export function App() {
  // 后端
  const { kernel, system, db, agents, events: polledEvents, connected, lastUpdate, error, refresh, retryAttempt, latencyMs } = useBackend();
  const { data: observation, start: obsStart, stop: obsStop } = useObservation();
  const { stats: scheduler } = useScheduler();
  // 实时事件流 (SSE) — 后端不可达时回落到 polling
  const stream = useEventStream(true);
  const events = stream.events.length > 0 ? stream.events : polledEvents;
  const eventConnected = stream.connected || connected;

  // 业务 hooks
  const chat = useChat();
  const resources = useResources();
  const { current: theme, setTheme } = useTheme();
  // 快捷键 store — 提供用户自定义覆盖
  const { bindings: kbBindings, setBinding: setKb } = useKeybindings();

  // UI 状态
  const [projectName, setProjectName] = useState<string>(
    () => localStorage.getItem(PROJECT_KEY) || 'SoloForge'
  );
  const initialLayout = loadLayout();
  const [leftWidth, setLeftWidth] = useState(initialLayout.leftWidth);
  const [rightWidth, setRightWidth] = useState(initialLayout.rightWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activity, setActivity] = useState('explorer');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickJumpOpen, setQuickJumpOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [activityFeedOpen, setActivityFeedOpen] = useState(false);

  // 打开活动面板时清零新事件计数
  const openActivityFeed = useCallback(() => {
    setActivityFeedOpen(true);
    stream.ackNew();
  }, [stream]);
  const [tourOpen, setTourOpen] = useState(() => !localStorage.getItem('soloforge.tour.completed'));
  const [deployOpen, setDeployOpen] = useState(false);
  const [hotkeyOpen, setHotkeyOpen] = useState(false);
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const [projectIOOpen, setProjectIOOpen] = useState(false);
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [abTestOpen, setAbTestOpen] = useState(false);
  const [detachOpen, setDetachOpen] = useState(false);
  const [codeReviewOpen, setCodeReviewOpen] = useState(false);
  const [taskSchedulerOpen, setTaskSchedulerOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [debuggerOpen, setDebuggerOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [surrealOpen, setSurrealOpen] = useState(false);
  const [gitTimeOpen, setGitTimeOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [themeGenOpen, setThemeGenOpen] = useState(false);
  const [codeMapOpen, setCodeMapOpen] = useState(false);
  const [pomodoroOpen, setPomodoroOpen] = useState(false);
  const [regexOpen, setRegexOpen] = useState(false);
  const [stickyOpen, setStickyOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [cmdHistoryOpen, setCmdHistoryOpen] = useState(false);
  const [perfMonOpen, setPerfMonOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [translatorOpen, setTranslatorOpen] = useState(false);
  const [collabOpen2, setCollabOpen2] = useState(false);
  const [eventBrowserOpen, setEventBrowserOpen] = useState(false);
  const [agentTheaterOpen, setAgentTheaterOpen] = useState(false);
  const [voiceChatOpen, setVoiceChatOpen] = useState(false);
  const [advSearchOpen, setAdvSearchOpen] = useState(false);
  const [docCollabOpen, setDocCollabOpen] = useState(false);
  const [logStreamOpen, setLogStreamOpen] = useState(false);
  const [mindMapOpen, setMindMapOpen] = useState(false);
  const [apiTesterOpen, setApiTesterOpen] = useState(false);
  const [dbDesignerOpen, setDbDesignerOpen] = useState(false);
  const [umlToolsOpen, setUmlToolsOpen] = useState(false);
  const [taskBoardOpen, setTaskBoardOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [notifierOpen, setNotifierOpen] = useState(false);
  const [fullTextOpen, setFullTextOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [cronOpen, setCronOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [envMgrOpen, setEnvMgrOpen] = useState(false);
  const [bookmarkOpen, setBookmarkOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [webPreviewOpen, setWebPreviewOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [netMonOpen, setNetMonOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [dbSeederOpen, setDbSeederOpen] = useState(false);
  const [k8sOpen, setK8sOpen] = useState(false);
  const [depGraphOpen, setDepGraphOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [testCovOpen, setTestCovOpen] = useState(false);
  const [dbBrowserOpen, setDbBrowserOpen] = useState(false);
  const [apiMonOpen, setApiMonOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [vulnOpen, setVulnOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [dataMaskOpen, setDataMaskOpen] = useState(false);
  const [threatOpen, setThreatOpen] = useState(false);
  const [promptLabOpen, setPromptLabOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [agentOrchOpen, setAgentOrchOpen] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [deployPipelineOpen, setDeployPipelineOpen] = useState(false);
  const [experimentOpen, setExperimentOpen] = useState(false);
  const [modelRegOpen, setModelRegOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [kanbanOpen, setKanbanOpen] = useState(false);
  const [loadTestOpen, setLoadTestOpen] = useState(false);
  const [docGenOpen, setDocGenOpen] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);

  useEffect(() => { localStorage.setItem(PROJECT_KEY, projectName); }, [projectName]);
  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ leftWidth, rightWidth })); } catch { /* ignore */ }
  }, [leftWidth, rightWidth]);

  const onLeftDrag = useCallback((delta: number) => {
    setLeftWidth((w: number) => Math.max(280, Math.min(800, w + delta)));
  }, []);
  const onRightDrag = useCallback((delta: number) => {
    setRightWidth((w: number) => Math.max(280, Math.min(700, w - delta)));
  }, []);

  // 发送时自动开始观测
  useEffect(() => {
    if (chat.busy && observation && !observation.isObserving) {
      obsStart().catch(() => {});
    }
  }, [chat.busy, observation, obsStart]);

  // 后端连接变化时通知
  useEffect(() => {
    if (connected) {
      pushNotification({ level: 'success', title: '后端已连接', message: API_BASE });
    } else {
      pushNotification({ level: 'warning', title: '后端离线', message: '已切换到本地模式' });
    }
  }, [connected]);

  // ─── 广播状态到独立窗口 (throttle 500ms) ───
  useEffect(() => {
    const t = setTimeout(() => {
      broadcastState({
        ts: Date.now(),
        project: projectName,
        activity,
        activeSession: chat.activeSession ? {
          id: chat.activeSession.id,
          title: chat.activeSession.title,
          messages: chat.activeSession.messages.length,
        } : null,
        streamCount: chat.stream?.length || 0,
        eventsCount: events.length,
        kernel: kernel ? { state: kernel.state, version: kernel.version } : null,
        agents: agents?.length || 0,
      });
    }, 500);
    return () => clearTimeout(t);
  }, [projectName, activity, chat.activeSession, chat.stream, events, kernel, agents]);

  // 全局快捷键 — 从 store 派生,用户自定义可生效
  const handlers: Record<string, (e: KeyboardEvent) => void> = {
    palette:       () => setPaletteOpen(true),
    paletteAlt:    () => setPaletteOpen(true),
    search:        () => setSearchOpen(true),
    deploy:        () => setDeployOpen(true),
    settings:      () => setSettingsOpen(true),
    terminal:      () => setActivity('terminal'),
    explorer:      () => setActivity('explorer'),
    quickJump:     () => setQuickJumpOpen(true),
    quickJumpAlt:  () => setQuickJumpOpen(true),
    git:           () => setActivity('git'),
    searchPane:    () => setActivity('search'),
    newSession:    () => chat.newSession(),
    clearStream:   () => chat.clearStream(),
    refresh:       () => refresh(),
    hotkey:        () => setHotkeyOpen(true),
    chatHistory:   () => setHistorySearchOpen(true),
    splitCompare:  () => setSplitOpen(true),
    abTest:        () => setAbTestOpen(true),
    detach:        () => setDetachOpen(true),
    codeReview:    () => setCodeReviewOpen(true),
    taskScheduler: () => setTaskSchedulerOpen(true),
    collab:        () => setCollabOpen(true),
    debugger:      () => setDebuggerOpen(true),
    plugins:       () => setPluginOpen(true),
    snippets:      () => setSnippetsOpen(true),
    surreal:       () => setSurrealOpen(true),
    gitTime:       () => setGitTimeOpen(true),
    workflow:      () => setWorkflowOpen(true),
    mermaid:       () => setMermaidOpen(true),
    themeGen:      () => setThemeGenOpen(true),
    codeMap:       () => setCodeMapOpen(true),
    pomodoro:      () => setPomodoroOpen(true),
    regexLab:      () => setRegexOpen(true),
    sticky:        () => setStickyOpen(true),
    dashboard:     () => setDashboardOpen(true),
    prompts:       () => setPromptsOpen(true),
    cmdHistory:    () => setCmdHistoryOpen(true),
    perfMon:       () => setPerfMonOpen(true),
    timeline:      () => setTimelineOpen(true),
    translator:    () => setTranslatorOpen(true),
    collab2:       () => setCollabOpen2(true),
    eventBrowser:  () => setEventBrowserOpen(true),
    agentTheater:  () => setAgentTheaterOpen(true),
    voiceChat:     () => setVoiceChatOpen(true),
    advSearch:     () => setAdvSearchOpen(true),
    docCollab:     () => setDocCollabOpen(true),
    logStream:     () => setLogStreamOpen(true),
    mindMap:       () => setMindMapOpen(true),
    apiTester:     () => setApiTesterOpen(true),
    dbDesigner:    () => setDbDesignerOpen(true),
    umlTools:      () => setUmlToolsOpen(true),
    taskBoard:     () => setTaskBoardOpen(true),
    snapshotMgr:   () => setSnapshotOpen(true),
    notifierRules: () => setNotifierOpen(true),
    fullTextSearch:() => setFullTextOpen(true),
    jsonTools:     () => setJsonOpen(true),
    cronEditor:    () => setCronOpen(true),
    changelog:     () => setChangelogOpen(true),
    envManager:    () => setEnvMgrOpen(true),
    bookmarkMgr:   () => setBookmarkOpen(true),
    colorPalette:  () => setColorOpen(true),
    iconBrowser:   () => setIconOpen(true),
    diffViewer:    () => setDiffOpen(true),
    webPreview:    () => setWebPreviewOpen(true),
    notesEditor:   () => setNotesOpen(true),
    netMon:        () => setNetMonOpen(true),
    assetLib:      () => setAssetOpen(true),
    buildMon:      () => setBuildOpen(true),
    webhook:       () => setWebhookOpen(true),
    scriptRun:     () => setScriptOpen(true),
    qrGen:         () => setQrOpen(true),
    dbSeeder:      () => setDbSeederOpen(true),
    k8sPanel:      () => setK8sOpen(true),
    depGraph:      () => setDepGraphOpen(true),
    licenseAudit:  () => setLicenseOpen(true),
    costMonitor:   () => setCostOpen(true),
    testCoverage:  () => setTestCovOpen(true),
    dbBrowser:     () => setDbBrowserOpen(true),
    apiMonitor:    () => setApiMonOpen(true),
    secretScanner: () => setSecretOpen(true),
    privacyScanner:() => setPrivacyOpen(true),
    vulnScanner:   () => setVulnOpen(true),
    accessAuditor: () => setAccessOpen(true),
    incidentMgr:   () => setIncidentOpen(true),
    compliance:    () => setComplianceOpen(true),
    dataMasking:   () => setDataMaskOpen(true),
    threatModel:   () => setThreatOpen(true),
    promptLab:     () => setPromptLabOpen(true),
    tokenTracker:  () => setTokenOpen(true),
    agentOrch:     () => setAgentOrchOpen(true),
    embedding:     () => setEmbedOpen(true),
    cacheInsp:     () => setCacheOpen(true),
    deployPipe:    () => setDeployPipelineOpen(true),
    experiment:    () => setExperimentOpen(true),
    modelReg:      () => setModelRegOpen(true),
    queueMon:      () => setQueueOpen(true),
    worktree:      () => setWorktreeOpen(true),
    prReviewer:    () => setPrOpen(true),
    kanban:        () => setKanbanOpen(true),
    loadTest:      () => setLoadTestOpen(true),
    docGen:        () => setDocGenOpen(true),
    knowledge:     () => setKbOpen(true),
    teamDir:       () => setTeamOpen(true),
    release:       () => setReleaseOpen(true),
  };
  useKeyboard(
    kbBindings
      .filter(b => handlers[b.id])
      .map(b => ({
        key: b.combo.key,
        ctrl: b.combo.ctrl,
        shift: b.combo.shift,
        alt: b.combo.alt,
        meta: b.combo.meta,
        description: b.description,
        handler: handlers[b.id],
      })),
  );

  // ─── 全局 Esc 关闭栈 (按打开顺序反向关闭) ───
  // 每个 overlay 状态都通过 stack 注册, Esc 关掉栈顶的那个
  // 注册格式: [id, isOpen, closeFn]
  useEffect(() => {
    const stack: Array<{ id: string; close: () => void }> = [];
    if (paletteOpen)      stack.push({ id: 'palette', close: () => setPaletteOpen(false) });
    if (searchOpen)       stack.push({ id: 'search', close: () => setSearchOpen(false) });
    if (quickJumpOpen)    stack.push({ id: 'quickJump', close: () => setQuickJumpOpen(false) });
    if (skillsOpen)       stack.push({ id: 'skills', close: () => setSkillsOpen(false) });
    if (activityFeedOpen) stack.push({ id: 'activity', close: () => setActivityFeedOpen(false) });
    if (tourOpen)         stack.push({ id: 'tour', close: () => setTourOpen(false) });
    if (deployOpen)       stack.push({ id: 'deploy', close: () => setDeployOpen(false) });
    if (hotkeyOpen)       stack.push({ id: 'hotkey', close: () => setHotkeyOpen(false) });
    if (themeEditorOpen)  stack.push({ id: 'themeEditor', close: () => setThemeEditorOpen(false) });
    if (projectIOOpen)    stack.push({ id: 'projectIO', close: () => setProjectIOOpen(false) });
    if (historySearchOpen)stack.push({ id: 'historySearch', close: () => setHistorySearchOpen(false) });
    if (splitOpen)        stack.push({ id: 'splitCompare', close: () => setSplitOpen(false) });
    if (abTestOpen)       stack.push({ id: 'abTest', close: () => setAbTestOpen(false) });
    if (detachOpen)       stack.push({ id: 'detach', close: () => setDetachOpen(false) });
    if (codeReviewOpen)   stack.push({ id: 'codeReview', close: () => setCodeReviewOpen(false) });
    if (taskSchedulerOpen)stack.push({ id: 'taskScheduler', close: () => setTaskSchedulerOpen(false) });
    if (collabOpen)       stack.push({ id: 'collab', close: () => setCollabOpen(false) });
    if (debuggerOpen)     stack.push({ id: 'debugger', close: () => setDebuggerOpen(false) });
    if (pluginOpen)       stack.push({ id: 'plugins', close: () => setPluginOpen(false) });
    if (snippetsOpen)     stack.push({ id: 'snippets', close: () => setSnippetsOpen(false) });
    if (surrealOpen)      stack.push({ id: 'surreal', close: () => setSurrealOpen(false) });
    if (gitTimeOpen)      stack.push({ id: 'gitTime', close: () => setGitTimeOpen(false) });
    if (workflowOpen)     stack.push({ id: 'workflow', close: () => setWorkflowOpen(false) });
    if (mermaidOpen)      stack.push({ id: 'mermaid', close: () => setMermaidOpen(false) });
    if (themeGenOpen)     stack.push({ id: 'themeGen', close: () => setThemeGenOpen(false) });
    if (codeMapOpen)      stack.push({ id: 'codeMap', close: () => setCodeMapOpen(false) });
    if (pomodoroOpen)     stack.push({ id: 'pomodoro', close: () => setPomodoroOpen(false) });
    if (regexOpen)        stack.push({ id: 'regexLab', close: () => setRegexOpen(false) });
    if (stickyOpen)       stack.push({ id: 'sticky', close: () => setStickyOpen(false) });
    if (dashboardOpen)    stack.push({ id: 'dashboard', close: () => setDashboardOpen(false) });
    if (promptsOpen)      stack.push({ id: 'prompts', close: () => setPromptsOpen(false) });
    if (cmdHistoryOpen)   stack.push({ id: 'cmdHistory', close: () => setCmdHistoryOpen(false) });
    if (perfMonOpen)      stack.push({ id: 'perfMon', close: () => setPerfMonOpen(false) });
    if (timelineOpen)     stack.push({ id: 'timeline', close: () => setTimelineOpen(false) });
    if (translatorOpen)   stack.push({ id: 'translator', close: () => setTranslatorOpen(false) });
    if (collabOpen2)      stack.push({ id: 'collab2', close: () => setCollabOpen2(false) });
    if (eventBrowserOpen) stack.push({ id: 'eventBrowser', close: () => setEventBrowserOpen(false) });
    if (agentTheaterOpen)  stack.push({ id: 'agentTheater', close: () => setAgentTheaterOpen(false) });
    if (voiceChatOpen)     stack.push({ id: 'voiceChat', close: () => setVoiceChatOpen(false) });
    if (advSearchOpen)     stack.push({ id: 'advSearch', close: () => setAdvSearchOpen(false) });
    if (docCollabOpen)     stack.push({ id: 'docCollab', close: () => setDocCollabOpen(false) });
    if (logStreamOpen)     stack.push({ id: 'logStream', close: () => setLogStreamOpen(false) });
    if (mindMapOpen)       stack.push({ id: 'mindMap', close: () => setMindMapOpen(false) });
    if (apiTesterOpen)     stack.push({ id: 'apiTester', close: () => setApiTesterOpen(false) });
    if (dbDesignerOpen)    stack.push({ id: 'dbDesigner', close: () => setDbDesignerOpen(false) });
    if (umlToolsOpen)      stack.push({ id: 'umlTools', close: () => setUmlToolsOpen(false) });
    if (taskBoardOpen)     stack.push({ id: 'taskBoard', close: () => setTaskBoardOpen(false) });
    if (snapshotOpen)      stack.push({ id: 'snapshotMgr', close: () => setSnapshotOpen(false) });
    if (notifierOpen)      stack.push({ id: 'notifierRules', close: () => setNotifierOpen(false) });
    if (fullTextOpen)      stack.push({ id: 'fullTextSearch', close: () => setFullTextOpen(false) });
    if (jsonOpen)          stack.push({ id: 'jsonTools', close: () => setJsonOpen(false) });
    if (cronOpen)          stack.push({ id: 'cronEditor', close: () => setCronOpen(false) });
    if (changelogOpen)     stack.push({ id: 'changelog', close: () => setChangelogOpen(false) });
    if (envMgrOpen)        stack.push({ id: 'envManager', close: () => setEnvMgrOpen(false) });
    if (bookmarkOpen)      stack.push({ id: 'bookmarkMgr', close: () => setBookmarkOpen(false) });
    if (colorOpen)         stack.push({ id: 'colorPalette', close: () => setColorOpen(false) });
    if (iconOpen)          stack.push({ id: 'iconBrowser', close: () => setIconOpen(false) });
    if (diffOpen)          stack.push({ id: 'diffViewer', close: () => setDiffOpen(false) });
    if (webPreviewOpen)    stack.push({ id: 'webPreview', close: () => setWebPreviewOpen(false) });
    if (notesOpen)         stack.push({ id: 'notesEditor', close: () => setNotesOpen(false) });
    if (netMonOpen)        stack.push({ id: 'netMon', close: () => setNetMonOpen(false) });
    if (assetOpen)         stack.push({ id: 'assetLib', close: () => setAssetOpen(false) });
    if (buildOpen)         stack.push({ id: 'buildMon', close: () => setBuildOpen(false) });
    if (webhookOpen)       stack.push({ id: 'webhook', close: () => setWebhookOpen(false) });
    if (scriptOpen)        stack.push({ id: 'scriptRun', close: () => setScriptOpen(false) });
    if (qrOpen)            stack.push({ id: 'qrGen', close: () => setQrOpen(false) });
    if (dbSeederOpen)      stack.push({ id: 'dbSeeder', close: () => setDbSeederOpen(false) });
    if (k8sOpen)           stack.push({ id: 'k8sPanel', close: () => setK8sOpen(false) });
    if (depGraphOpen)      stack.push({ id: 'depGraph', close: () => setDepGraphOpen(false) });
    if (licenseOpen)       stack.push({ id: 'licenseAudit', close: () => setLicenseOpen(false) });
    if (costOpen)          stack.push({ id: 'costMonitor', close: () => setCostOpen(false) });
    if (testCovOpen)       stack.push({ id: 'testCoverage', close: () => setTestCovOpen(false) });
    if (dbBrowserOpen)     stack.push({ id: 'dbBrowser', close: () => setDbBrowserOpen(false) });
    if (apiMonOpen)        stack.push({ id: 'apiMonitor', close: () => setApiMonOpen(false) });
    if (secretOpen)        stack.push({ id: 'secretScanner', close: () => setSecretOpen(false) });
    if (privacyOpen)       stack.push({ id: 'privacyScanner', close: () => setPrivacyOpen(false) });
    if (vulnOpen)          stack.push({ id: 'vulnScanner', close: () => setVulnOpen(false) });
    if (accessOpen)        stack.push({ id: 'accessAuditor', close: () => setAccessOpen(false) });
    if (incidentOpen)      stack.push({ id: 'incidentMgr', close: () => setIncidentOpen(false) });
    if (complianceOpen)    stack.push({ id: 'compliance', close: () => setComplianceOpen(false) });
    if (dataMaskOpen)      stack.push({ id: 'dataMasking', close: () => setDataMaskOpen(false) });
    if (threatOpen)        stack.push({ id: 'threatModel', close: () => setThreatOpen(false) });
    if (promptLabOpen)     stack.push({ id: 'promptLab', close: () => setPromptLabOpen(false) });
    if (tokenOpen)         stack.push({ id: 'tokenTracker', close: () => setTokenOpen(false) });
    if (agentOrchOpen)     stack.push({ id: 'agentOrch', close: () => setAgentOrchOpen(false) });
    if (embedOpen)         stack.push({ id: 'embedding', close: () => setEmbedOpen(false) });
    if (cacheOpen)         stack.push({ id: 'cacheInsp', close: () => setCacheOpen(false) });
    if (deployPipelineOpen)stack.push({ id: 'deployPipe', close: () => setDeployPipelineOpen(false) });
    if (experimentOpen)    stack.push({ id: 'experiment', close: () => setExperimentOpen(false) });
    if (modelRegOpen)      stack.push({ id: 'modelReg', close: () => setModelRegOpen(false) });
    if (queueOpen)         stack.push({ id: 'queueMon', close: () => setQueueOpen(false) });
    if (worktreeOpen)      stack.push({ id: 'worktree', close: () => setWorktreeOpen(false) });
    if (prOpen)            stack.push({ id: 'prReviewer', close: () => setPrOpen(false) });
    if (kanbanOpen)        stack.push({ id: 'kanban', close: () => setKanbanOpen(false) });
    if (loadTestOpen)      stack.push({ id: 'loadTest', close: () => setLoadTestOpen(false) });
    if (docGenOpen)        stack.push({ id: 'docGen', close: () => setDocGenOpen(false) });
    if (kbOpen)            stack.push({ id: 'knowledge', close: () => setKbOpen(false) });
    if (teamOpen)          stack.push({ id: 'teamDir', close: () => setTeamOpen(false) });
    if (releaseOpen)       stack.push({ id: 'release', close: () => setReleaseOpen(false) });
    if (settingsOpen)     stack.push({ id: 'settings', close: () => setSettingsOpen(false) });

    if (stack.length === 0) return;
    // 只在最后一层执行; 顶层触发后阻止冒泡
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 在 input/textarea 内时,让原生 Esc 行为生效 (如清空输入) 而不关 overlay
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      // 顶层 overlay 自己会处理 Esc (preventDefault 后这里不再二次触发)
      if (inEditable) return;
      // 找到栈顶 (最后 push 的), 只关它
      e.preventDefault();
      e.stopPropagation();
      const top = stack[stack.length - 1];
      top.close();
    };
    // capture phase 优先于子组件自己的 onKeyDown
    window.addEventListener('keydown', onEsc, true);
    return () => {
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [
    paletteOpen, searchOpen, quickJumpOpen, skillsOpen, activityFeedOpen,
    tourOpen, deployOpen, hotkeyOpen, themeEditorOpen, projectIOOpen,
    historySearchOpen, splitOpen, abTestOpen, detachOpen, codeReviewOpen, taskSchedulerOpen, collabOpen, debuggerOpen, pluginOpen, snippetsOpen, surrealOpen, gitTimeOpen, workflowOpen, mermaidOpen, themeGenOpen, codeMapOpen, pomodoroOpen, regexOpen, stickyOpen, dashboardOpen, promptsOpen, cmdHistoryOpen, perfMonOpen, timelineOpen, translatorOpen, collabOpen2, eventBrowserOpen, agentTheaterOpen, voiceChatOpen, advSearchOpen, docCollabOpen, logStreamOpen, mindMapOpen, apiTesterOpen, dbDesignerOpen, umlToolsOpen, taskBoardOpen, snapshotOpen, notifierOpen, fullTextOpen, jsonOpen, cronOpen, changelogOpen, envMgrOpen, bookmarkOpen, colorOpen, iconOpen, diffOpen, webPreviewOpen, notesOpen, netMonOpen, assetOpen, buildOpen, webhookOpen, scriptOpen, qrOpen, dbSeederOpen, k8sOpen, depGraphOpen, licenseOpen, costOpen, testCovOpen, dbBrowserOpen, apiMonOpen, secretOpen, privacyOpen, vulnOpen, accessOpen, incidentOpen, complianceOpen, dataMaskOpen, threatOpen, promptLabOpen, tokenOpen, agentOrchOpen, embedOpen, cacheOpen, deployPipelineOpen, experimentOpen, modelRegOpen, queueOpen, worktreeOpen, prOpen, kanbanOpen, loadTestOpen, docGenOpen, kbOpen, teamOpen, releaseOpen, settingsOpen,
  ]);

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg text-text font-sans relative">
      <Splash />
      <WelcomeNotifications />
      <TopBar
        settings={chat.settings}
        setSettings={chat.setSettings}
        connected={connected}
        lastUpdate={lastUpdate}
        latencyMs={latencyMs}
        retryAttempt={retryAttempt}
        onRefresh={refresh}
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenActivity={openActivityFeed}
        activityNewCount={stream.newCount}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenQuickJump={() => setQuickJumpOpen(true)}
        onOpenDeploy={() => setDeployOpen(true)}
        onOpenHotkey={() => setHotkeyOpen(true)}
        onOpenProjectIO={() => setProjectIOOpen(true)}
      />

      {error && (
        <div className="bg-danger/10 border-b border-danger/30 px-4 py-1.5 flex items-center gap-2 text-xs text-danger shrink-0">
          <span className="material-symbols-outlined text-sm">error</span>
          <span>后端不可达：{API_BASE} — 已切换到本地模式，部分功能不可用</span>
          <button onClick={refresh} className="ml-auto text-text-secondary hover:text-text">
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <ActivityBar
          active={activity}
          onChange={setActivity}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenHotkey={() => setHotkeyOpen(true)}
        />
        <div style={{ width: leftWidth }} className="shrink-0 flex">
          <LeftSidebar resources={resources} activity={activity} />
        </div>
        <Splitter onDrag={onLeftDrag} active />
        <div className="flex-1 min-w-0 flex">
          <CenterPanels chat={chat} resources={resources} onOpenSettings={() => setSettingsOpen(true)} />
        </div>
        <Splitter onDrag={onRightDrag} active />
        <div style={{ width: rightWidth }} className="shrink-0 flex">
          <PreviewPane
            system={system}
          kernel={kernel}
          observation={observation}
          db={db}
          agents={agents}
          events={events}
          onAction={(key) => {
            if (key === 'deploy') setDeployOpen(true);
            else if (key === 'openSettings') setSettingsOpen(true);
            else if (key === 'openTour') { setTourOpen(true); localStorage.removeItem('soloforge.tour.completed'); }
            else if (key === 'openTerminal') setActivity('terminal');
            else if (key === 'skill') setSkillsOpen(true);
            else if (key === 'newFile') {
              pushNotification({ level: 'info', title: '新建文件', message: '点击文件树工具栏的 + 按钮' });
              setActivity('explorer');
            }
          }}
        />
        </div>
      </div>

      <StatusBar
        projectName={projectName}
        kernel={kernel}
        system={system}
        scheduler={scheduler}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        apiBase={API_BASE}
        connected={connected}
        lastUpdate={lastUpdate}
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onClearHistory={chat.clearAll}
        onOpenThemeEditor={() => setThemeEditorOpen(true)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        setActivity={setActivity}
        chat={chat}
        onOpenSettings={() => setSettingsOpen(true)}
        setTheme={setTheme}
        currentTheme={theme.id}
        onOpenSkills={() => setSkillsOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenTour={() => { setTourOpen(true); localStorage.removeItem('soloforge.tour.completed'); }}
        setLeftWidth={setLeftWidth}
        setRightWidth={setRightWidth}
      />

      <SkillsMarket
        open={skillsOpen}
        onClose={() => setSkillsOpen(false)}
        onToggle={(id, enabled) => {
          pushNotification({
            level: enabled ? 'success' : 'info',
            title: enabled ? '技能已启用' : '技能已停用',
            message: id,
          });
        }}
      />

      <RecentActivity
        open={activityFeedOpen}
        onClose={() => setActivityFeedOpen(false)}
        events={events}
        connected={eventConnected}
      />

      <FeatureTour
        open={tourOpen}
        onClose={() => { localStorage.setItem('soloforge.tour.completed', '1'); setTourOpen(false); }}
      />

      <GlobalSearch
        open={searchOpen}
        onClose={closeSearch}
        tree={resources.tree}
        contents={(resources as any).contents || {}}
        onJumpToFile={(path) => {
          resources.setActiveFile(path);
          setActivity('explorer');
          closeSearch();
        }}
      />

      <QuickJump
        open={quickJumpOpen}
        onClose={() => setQuickJumpOpen(false)}
        tree={resources.tree}
        onJumpToFile={(path) => {
          resources.setActiveFile(path);
          setActivity('explorer');
        }}
      />

      <DeployWizard
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        projectName={projectName}
      />

      <HotkeyCheatsheet
        open={hotkeyOpen}
        onClose={() => setHotkeyOpen(false)}
        onAction={(id) => {
          if (id === '__openSettings') {
            setSettingsOpen(true);
            return;
          }
          // 触发对应 store 动作
          const map: Record<string, () => void> = {
            palette: () => setPaletteOpen(true),
            paletteAlt: () => setPaletteOpen(true),
            search: () => setSearchOpen(true),
            deploy: () => setDeployOpen(true),
            settings: () => setSettingsOpen(true),
            terminal: () => setActivity('terminal'),
            explorer: () => setActivity('explorer'),
            quickJump: () => setQuickJumpOpen(true),
            quickJumpAlt: () => setQuickJumpOpen(true),
            git: () => setActivity('git'),
            searchPane: () => setActivity('search'),
            newSession: () => chat.newSession(),
            clearStream: () => chat.clearStream(),
            refresh: () => refresh(),
            hotkey: () => setHotkeyOpen(true),
            chatHistory: () => setHistorySearchOpen(true),
            splitCompare: () => setSplitOpen(true),
          };
          map[id]?.();
        }}
      />

      <ThemeEditor
        open={themeEditorOpen}
        onClose={() => setThemeEditorOpen(false)}
      />

      <ProjectIO
        open={projectIOOpen}
        onClose={() => setProjectIOOpen(false)}
        projectName={projectName}
        chat={{ sessions: chat.sessions, settings: chat.settings }}
        resources={{ tree: resources.tree }}
      />

      <ChatHistorySearch
        open={historySearchOpen}
        onClose={() => setHistorySearchOpen(false)}
        sessions={chat.sessions}
        activeId={chat.activeId}
        onJumpToSession={(sessionId, _messageId) => {
          chat.switchSession(sessionId);
        }}
      />

      <SplitCompare
        open={splitOpen}
        onClose={() => setSplitOpen(false)}
        tree={resources.tree}
        contents={(resources as any).contents || {}}
        sessions={chat.sessions}
        agents={agents as any}
        events={events}
      />

      <ABTest
        open={abTestOpen}
        onClose={() => setAbTestOpen(false)}
        chat={{
          sessions: chat.sessions,
          activeId: chat.activeId,
          settings: chat.settings,
          send: chat.send,
          newSession: chat.newSession,
          setMessages: chat.setMessages,
        }}
        initialQuestion={chat.activeSession?.messages?.filter(m => m.role === 'user').slice(-1)[0]?.content || ''}
      />

      <DetachSelector
        open={detachOpen}
        onClose={() => setDetachOpen(false)}
        onSelect={(kind) => {
          const id = 'w_' + Date.now().toString(36);
          const sizes: Record<string, [number, number]> = {
            terminal: [800, 500],
            chat: [560, 720],
            stream: [640, 480],
            preview: [720, 540],
            court: [600, 600],
            git: [600, 500],
          };
          const [w, h] = sizes[kind] || [640, 480];
          const title = kind.charAt(0).toUpperCase() + kind.slice(1);
          openDetachedWindow({ id, kind, title, width: w, height: h });
          setDetachOpen(false);
          pushToast({ level: 'success', title: '已弹出', message: title, duration: 1500 });
        }}
      />

      <CodeReview
        open={codeReviewOpen}
        onClose={() => setCodeReviewOpen(false)}
        initialCode={''}
        initialFilePath=""
        initialLanguage="typescript"
      />

      <TaskScheduler
        open={taskSchedulerOpen}
        onClose={() => setTaskSchedulerOpen(false)}
      />

      <CollabCursors
        open={collabOpen}
        onClose={() => setCollabOpen(false)}
        activeFile={resources.activeFile || 'src/App.tsx'}
      />

      <BreakpointDebugger
        open={debuggerOpen}
        onClose={() => setDebuggerOpen(false)}
      />

      <PluginRegistry
        open={pluginOpen}
        onClose={() => setPluginOpen(false)}
      />

      <SnippetsManager
        open={snippetsOpen}
        onClose={() => setSnippetsOpen(false)}
      />

      <SurrealExplorer
        open={surrealOpen}
        onClose={() => setSurrealOpen(false)}
      />

      <GitTimeMachine
        open={gitTimeOpen}
        onClose={() => setGitTimeOpen(false)}
        initialFile={resources.activeFile}
      />

      <WorkflowPipeline
        open={workflowOpen}
        onClose={() => setWorkflowOpen(false)}
      />

      <MermaidEditor
        open={mermaidOpen}
        onClose={() => setMermaidOpen(false)}
      />

      <ThemeGenerator
        open={themeGenOpen}
        onClose={() => setThemeGenOpen(false)}
        onApply={() => { pushToast({ level: 'success', title: '主题已应用', message: '可在设置中保存为正式主题', duration: 2000 }); }}
      />

      <CodeMap
        open={codeMapOpen}
        onClose={() => setCodeMapOpen(false)}
        onJumpToFile={(p) => { resources.setActiveFile(p); setActivity('explorer'); pushToast({ level: 'info', title: '已跳转', message: p.split('/').pop(), duration: 1200 }); }}
      />

      <PomodoroStats
        open={pomodoroOpen}
        onClose={() => setPomodoroOpen(false)}
      />

      <RegexLab
        open={regexOpen}
        onClose={() => setRegexOpen(false)}
      />

      <StickyNotes
        open={stickyOpen}
        onClose={() => setStickyOpen(false)}
        projectName={projectName}
      />

      <Dashboard
        open={dashboardOpen}
        onClose={() => setDashboardOpen(false)}
        events={events}
        kernel={kernel}
        agents={agents as any}
        db={db}
      />

      <PromptTemplates
        open={promptsOpen}
        onClose={() => setPromptsOpen(false)}
        onUse={(text) => {
          pushToast({ level: 'info', title: '已复制到剪贴板', message: '可在对话中粘贴使用', duration: 1800 });
          navigator.clipboard?.writeText(text).catch(() => {});
        }}
      />

      <CommandHistory
        open={cmdHistoryOpen}
        onClose={() => setCmdHistoryOpen(false)}
        onReplay={() => pushToast({ level: 'info', title: '重放', message: '模拟执行命令', duration: 1200 })}
      />

      <PerformanceMonitor
        open={perfMonOpen}
        onClose={() => setPerfMonOpen(false)}
      />

      <CodingTimeline
        open={timelineOpen}
        onClose={() => setTimelineOpen(false)}
      />

      <Translator
        open={translatorOpen}
        onClose={() => setTranslatorOpen(false)}
      />

      <SharedCollab
        open={collabOpen2}
        onClose={() => setCollabOpen2(false)}
        userName={localStorage.getItem('soloforge.user.name') || 'me'}
      />

      <EventBrowser
        open={eventBrowserOpen}
        onClose={() => setEventBrowserOpen(false)}
        events={events}
      />

      <AgentTheater
        open={agentTheaterOpen}
        onClose={() => setAgentTheaterOpen(false)}
      />

      <VoiceChat
        open={voiceChatOpen}
        onClose={() => setVoiceChatOpen(false)}
      />

      <AdvancedSearch
        open={advSearchOpen}
        onClose={() => setAdvSearchOpen(false)}
        tree={resources.tree as any}
        contents={(resources as any).contents || {}}
        onJumpToFile={(path) => {
          resources.setActiveFile(path);
          setActivity('explorer');
          setAdvSearchOpen(false);
          pushToast({ level: 'info', title: '已跳转', message: path.split('/').pop(), duration: 1200 });
        }}
      />

      <DocCollab
        open={docCollabOpen}
        onClose={() => setDocCollabOpen(false)}
        userName={localStorage.getItem('soloforge.user.name') || 'me'}
      />

      <LogStream
        open={logStreamOpen}
        onClose={() => setLogStreamOpen(false)}
        events={events}
      />

      <MindMap
        open={mindMapOpen}
        onClose={() => setMindMapOpen(false)}
      />

      <ApiTester
        open={apiTesterOpen}
        onClose={() => setApiTesterOpen(false)}
      />

      <DbDesigner
        open={dbDesignerOpen}
        onClose={() => setDbDesignerOpen(false)}
      />

      <UmlTools
        open={umlToolsOpen}
        onClose={() => setUmlToolsOpen(false)}
      />

      <TaskBoard
        open={taskBoardOpen}
        onClose={() => setTaskBoardOpen(false)}
      />

      <SnapshotManager
        open={snapshotOpen}
        onClose={() => setSnapshotOpen(false)}
      />

      <NotifierRules
        open={notifierOpen}
        onClose={() => setNotifierOpen(false)}
      />

      <FullTextSearch
        open={fullTextOpen}
        onClose={() => setFullTextOpen(false)}
      />

      <JsonTools
        open={jsonOpen}
        onClose={() => setJsonOpen(false)}
      />

      <CronEditor
        open={cronOpen}
        onClose={() => setCronOpen(false)}
      />

      <Changelog
        open={changelogOpen}
        onClose={() => setChangelogOpen(false)}
      />

      <EnvManager
        open={envMgrOpen}
        onClose={() => setEnvMgrOpen(false)}
      />

      <BookmarkManager
        open={bookmarkOpen}
        onClose={() => setBookmarkOpen(false)}
      />

      <ColorPalette
        open={colorOpen}
        onClose={() => setColorOpen(false)}
      />

      <IconBrowser
        open={iconOpen}
        onClose={() => setIconOpen(false)}
      />

      <DiffViewer
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
      />

      <WebPreview
        open={webPreviewOpen}
        onClose={() => setWebPreviewOpen(false)}
      />

      <NotesEditor
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
      />

      <NetworkMonitor
        open={netMonOpen}
        onClose={() => setNetMonOpen(false)}
      />

      <AssetLibrary
        open={assetOpen}
        onClose={() => setAssetOpen(false)}
      />

      <BuildMonitor
        open={buildOpen}
        onClose={() => setBuildOpen(false)}
      />

      <WebhookTester
        open={webhookOpen}
        onClose={() => setWebhookOpen(false)}
      />

      <ScriptRunner
        open={scriptOpen}
        onClose={() => setScriptOpen(false)}
      />

      <QrGenerator
        open={qrOpen}
        onClose={() => setQrOpen(false)}
      />

      <DatabaseSeeder
        open={dbSeederOpen}
        onClose={() => setDbSeederOpen(false)}
      />

      <K8sPanel
        open={k8sOpen}
        onClose={() => setK8sOpen(false)}
      />

      <DependencyGraph
        open={depGraphOpen}
        onClose={() => setDepGraphOpen(false)}
      />

      <LicenseAudit
        open={licenseOpen}
        onClose={() => setLicenseOpen(false)}
      />

      <CostMonitor
        open={costOpen}
        onClose={() => setCostOpen(false)}
      />

      <TestCoverage
        open={testCovOpen}
        onClose={() => setTestCovOpen(false)}
      />

      <DatabaseBrowser
        open={dbBrowserOpen}
        onClose={() => setDbBrowserOpen(false)}
      />

      <ApiMonitor
        open={apiMonOpen}
        onClose={() => setApiMonOpen(false)}
      />

      <SecretScanner
        open={secretOpen}
        onClose={() => setSecretOpen(false)}
      />

      <PrivacyScanner
        open={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
      />

      <VulnScanner
        open={vulnOpen}
        onClose={() => setVulnOpen(false)}
      />

      <AccessAuditor
        open={accessOpen}
        onClose={() => setAccessOpen(false)}
      />

      <IncidentManager
        open={incidentOpen}
        onClose={() => setIncidentOpen(false)}
      />

      <ComplianceAudit
        open={complianceOpen}
        onClose={() => setComplianceOpen(false)}
      />

      <DataMasking
        open={dataMaskOpen}
        onClose={() => setDataMaskOpen(false)}
      />

      <ThreatModel
        open={threatOpen}
        onClose={() => setThreatOpen(false)}
      />

      <PromptLab
        open={promptLabOpen}
        onClose={() => setPromptLabOpen(false)}
      />

      <TokenTracker
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
      />

      <AgentOrchestrator
        open={agentOrchOpen}
        onClose={() => setAgentOrchOpen(false)}
      />

      <EmbeddingExplorer
        open={embedOpen}
        onClose={() => setEmbedOpen(false)}
      />

      <CacheInspector
        open={cacheOpen}
        onClose={() => setCacheOpen(false)}
      />

      <DeploymentPipeline
        open={deployPipelineOpen}
        onClose={() => setDeployPipelineOpen(false)}
      />

      <ExperimentBoard
        open={experimentOpen}
        onClose={() => setExperimentOpen(false)}
      />

      <ModelRegistry
        open={modelRegOpen}
        onClose={() => setModelRegOpen(false)}
      />

      <QueueMonitor
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
      />

      <GitWorktree
        open={worktreeOpen}
        onClose={() => setWorktreeOpen(false)}
      />

      <PRReviewer
        open={prOpen}
        onClose={() => setPrOpen(false)}
      />

      <KanbanBoard
        open={kanbanOpen}
        onClose={() => setKanbanOpen(false)}
      />

      <LoadTester
        open={loadTestOpen}
        onClose={() => setLoadTestOpen(false)}
      />

      <DocGenerator
        open={docGenOpen}
        onClose={() => setDocGenOpen(false)}
      />

      <KnowledgeBase
        open={kbOpen}
        onClose={() => setKbOpen(false)}
      />

      <TeamDirectory
        open={teamOpen}
        onClose={() => setTeamOpen(false)}
      />

      <ReleasePlanner
        open={releaseOpen}
        onClose={() => setReleaseOpen(false)}
      />

      <NotificationCenter />
      <ToastCenter />

      {false && <span>{obsStart.toString()}{obsStop.toString()}</span>}
    </div>
  );
}

