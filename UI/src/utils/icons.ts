/**
 * Lucide → Heroicons 映射模块
 *
 * 将所有原 lucide-react 图标按功能语义映射到 @heroicons/react/24/outline 等效图标。
 * 组件名保持 lucide 原名，业务代码无需改动任何 <IconName /> 用法。
 *
 * 映射原则:
 *  - 优先选择视觉/语义最接近的 heroicons 图标
 *  - heroicons 无直接对应的图标 (如 Bot, Brain, GitBranch 等) 选择功能最接近的替代
 *  - 统一使用 24/outline 风格 (与 lucide 默认 stroke 风格一致)
 */

// ── Heroicons 导入 ──────────────────────────────────────────────
import React from 'react';
import {
  AdjustmentsHorizontalIcon,
  ArrowDownRightIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  ArrowTrendingUpIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  ArrowUpTrayIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  ArrowsRightLeftIcon,
  Bars3BottomLeftIcon,
  Bars3Icon,
  BoltIcon,
  BookmarkIcon,
  CalendarDaysIcon,
  CameraIcon,
  ChartBarIcon,
  ChartPieIcon,
  ChatBubbleLeftIcon,
  CheckBadgeIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleStackIcon,
  ClipboardDocumentCheckIcon,
  ClipboardDocumentListIcon,
  ClipboardIcon,
  ClockIcon,
  CloudIcon,
  CodeBracketIcon,
  CodeBracketSquareIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  ComputerDesktopIcon,
  CpuChipIcon,
  CreditCardIcon,
  CubeIcon,
  CursorArrowRaysIcon,
  DevicePhoneMobileIcon,
  DeviceTabletIcon,
  DocumentCheckIcon,
  DocumentDuplicateIcon,
  DocumentPlusIcon,
  DocumentTextIcon,
  EllipsisHorizontalCircleIcon,
  EllipsisVerticalIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  FireIcon,
  GlobeAltIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HandThumbUpIcon,
  HandThumbDownIcon,
  HeartIcon,
  InformationCircleIcon,
  KeyIcon,
  LightBulbIcon,
  LinkIcon,
  LockClosedIcon,
  LockOpenIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  MapPinIcon,
  MinusIcon,
  MoonIcon,
  NumberedListIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusCircleIcon,
  PlusIcon,
  PresentationChartBarIcon,
  PresentationChartLineIcon,
  PuzzlePieceIcon,
  QuestionMarkCircleIcon,
  QueueListIcon,
  RadioIcon,
  RocketLaunchIcon,
  ScaleIcon,
  ScissorsIcon,
  ServerIcon,
  ShareIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  SignalIcon,
  SparklesIcon,
  Square3Stack3DIcon,
  Squares2X2Icon,
  StarIcon,
  StopIcon,
  SunIcon,
  SwatchIcon,
  TrashIcon,
  TrophyIcon,
  UserIcon,
  UsersIcon,
  ViewfinderCircleIcon,
  WifiIcon,
  WindowIcon,
  WrenchIcon,
  WrenchScrewdriverIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

// ── Lucide → Heroicons 映射表 ──────────────────────────────────
// 命名保持 lucide 原名，值指向 heroicons 组件 (类型自动推导)

// 导航 / 箭头
export const ArrowDownRight = ArrowDownRightIcon;
export const ArrowRight = ArrowRightIcon;
export const ArrowUp = ArrowUpIcon;
export const ArrowUpRight = ArrowUpRightIcon;
export const ChevronDown = ChevronDownIcon;
export const ChevronLeft = ChevronLeftIcon;
export const ChevronRight = ChevronRightIcon;
export const ChevronUp = ChevronUpIcon;
export const ExternalLink = ArrowTopRightOnSquareIcon;
export const Globe = GlobeAltIcon;             // 地球 → 全球
export const HelpCircle = QuestionMarkCircleIcon; // 帮助圆圈 → 问号圆圈
export const Navigation = MapPinIcon;

// 操作 / 通用
export const Check = CheckIcon;
export const CreditCard = CreditCardIcon;     // 信用卡
export const CheckCheck = CheckBadgeIcon;        // 双勾 → 已验证徽章
export const CheckCircle2 = CheckCircleIcon;
export const Circle = (props: React.SVGProps<SVGSVGElement>) =>
  React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, ...props },
    React.createElement('circle', { cx: 12, cy: 12, r: 9 })
  );
export const CircleDot = (props: React.SVGProps<SVGSVGElement>) =>
  React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, ...props },
    React.createElement('circle', { cx: 12, cy: 12, r: 9 }),
    React.createElement('circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor' })
  );
export const Copy = DocumentDuplicateIcon;
export const Download = ArrowDownTrayIcon;
export const Edit3 = PencilIcon;
export const Pencil = PencilIcon;             // 铅笔 (与 Edit3 同源)
export const Eye = EyeIcon;
export const EyeOff = EyeSlashIcon;
export const Link2 = LinkIcon;
export const Minus = MinusIcon;
export const MoreVertical = EllipsisVerticalIcon;
export const Bookmark = BookmarkIcon;
export const Pin = BookmarkIcon;                  // 固定 → 书签
export const Plus = PlusIcon;
export const PlusCircle = PlusCircleIcon;
export const RefreshCw = ArrowPathIcon;           // 刷新 → 循环箭头
export const Replace = ArrowsRightLeftIcon;       // 替换 → 左右交换
export const Save = DocumentCheckIcon;            // 保存 → 文档打勾
export const Scissors = ScissorsIcon;
export const Trash2 = TrashIcon;               // 垃圾桶 (lucide Trash2 → heroicons Trash)
export const Search = MagnifyingGlassIcon;
export const Settings = Cog6ToothIcon;            // 设置 → 齿轮
export const Upload = ArrowUpTrayIcon;
export const X = XMarkIcon;
export const XCircle = XCircleIcon;
export const ZoomIn = MagnifyingGlassPlusIcon;
export const ZoomOut = MagnifyingGlassMinusIcon;

// 状态 / 反馈
export const AlertCircle = ExclamationCircleIcon;
export const AlertTriangle = ExclamationTriangleIcon;
export const Info = InformationCircleIcon;
export const Loader2 = ArrowPathIcon;             // 加载旋转 → 循环箭头 (配 animate-spin)
export const ShieldAlert = ShieldExclamationIcon;
export const ShieldCheck = ShieldCheckIcon;
export const Shield = ShieldCheckIcon;            // heroicons 无纯盾牌，用 ShieldCheck 近似

// 文件 / 文件夹
export const FileCode = CodeBracketSquareIcon;    // 代码文件 → 代码方括号
export const FilePlus = DocumentPlusIcon;
export const FileText = DocumentTextIcon;
export const Folder = FolderIcon;
export const FolderOpen = FolderOpenIcon;
export const FolderPlus = FolderPlusIcon;
export const FolderTree = QueueListIcon;          // 目录树 → 队列列表
export const Eraser = PaintBrushIcon;              // 橡皮擦 → 画刷 (清除会话用)
export const Clipboard = ClipboardIcon;
export const ClipboardPaste = ClipboardDocumentListIcon;

// 代码 / 开发
export const Code = CodeBracketIcon;
export const Code2 = WindowIcon;                  // 代码窗口 → 窗口图标
export const Terminal = CommandLineIcon;          // 终端 → 命令行
export const GitBranch = ArrowPathIcon;           // Git 分支 → 循环箭头
export const GitCommitHorizontal = EllipsisHorizontalCircleIcon; // 提交点
export const Cpu = CpuChipIcon;

// AI / 智能
export const Bot = CpuChipIcon;                   // 机器人 → 芯片
export const Brain = LightBulbIcon;               // 大脑 → 灯泡 (智能/想法)
export const Sparkles = SparklesIcon;

// 设备 / 预览
export const Monitor = ComputerDesktopIcon;
export const MonitorSmartphone = Squares2X2Icon;  // 多设备 → 网格
export const Smartphone = DevicePhoneMobileIcon;
export const Tablet = DeviceTabletIcon;
export const Watch = ViewfinderCircleIcon;        // 手表 → 取景器 (小屏)
export const Maximize2 = ArrowsPointingOutIcon;
export const Minimize2 = ArrowsPointingInIcon;

// 媒体 / 播放
export const Camera = CameraIcon;
export const Pause = PauseIcon;
export const Play = PlayIcon;
export const Square = StopIcon;                   // 停止方块 → Stop
export const Send = PaperAirplaneIcon;            // 发送 → 纸飞机

// 数据 / 存储
export const Database = CircleStackIcon;          // 数据库 → 圆形堆栈
export const HardDrive = ServerIcon;              // 硬盘 → 服务器
export const Network = WifiIcon;                  // 网络 → WiFi

// 通信 / 社交
export const MessageSquare = ChatBubbleLeftIcon;
export const MessageSquarePlus = ChatBubbleLeftIcon; // 无 Plus 变体，用基础气泡
export const Share2 = ShareIcon;
export const User = UserIcon;
export const Users = UsersIcon;
export const Crown = StarIcon;                    // 皇冠 → 星标 (高级/所有者)
export const Heart = HeartIcon;

// 反馈
export const ThumbsUp = HandThumbUpIcon;
export const ThumbsDown = HandThumbDownIcon;

// 工具 / 配置
export const Compass = Squares2X2Icon;            // 指南针 → 网格浏览
export const GripVertical = Bars3Icon;            // 拖拽手柄 → 三横线
export const Hammer = WrenchScrewdriverIcon;      // 锤子 → 扳手螺丝刀
export const Key = KeyIcon;
export const Lock = LockClosedIcon;
export const Palette = SwatchIcon;                // 调色板 → 色板
export const Puzzle = PuzzlePieceIcon;
export const Radio = RadioIcon;
export const Sliders = AdjustmentsHorizontalIcon;
export const SlidersHorizontal = AdjustmentsHorizontalIcon;
export const Unlock = LockOpenIcon;
export const Wrench = WrenchIcon;

// 法律 / 审核
export const Gavel = ScaleIcon;                   // 法槌 → 天平
export const Scale = ScaleIcon;

// 统计 / 图表
export const Activity = PresentationChartBarIcon; // 活动图表
export const Award = TrophyIcon;                  // 奖项 → 奖杯
export const BadgeCheck = CheckBadgeIcon;         // 认证徽章
export const BarChart3 = ChartBarIcon;            // 柱状图
export const Gauge = SignalIcon;                  // 仪表盘 → 信号
export const LineChart = PresentationChartLineIcon; // 折线图
export const PieChart = ChartPieIcon;             // 饼图
export const TrendingUp = ArrowTrendingUpIcon;

// 布局 / 结构
export const Layers = Square3Stack3DIcon;         // 图层 → 3D 堆叠
export const ListChecks = ClipboardDocumentCheckIcon; // 清单 → 剪贴板打勾
export const ListOrdered = NumberedListIcon;      // 有序列表
export const Menu = Bars3Icon;                    // 菜单 → 三横线
export const PanelBottom = Bars3BottomLeftIcon;   // 底部面板
export const RectangleGroup = Squares2X2Icon;

// 时间 / 日历
export const Calendar = CalendarDaysIcon;
export const Clock = ClockIcon;
export const History = ClockIcon;                 // 历史 → 时钟

// 主题 / 天气
export const CloudSnow = CloudIcon;               // 雪天 → 云
export const Moon = MoonIcon;
export const Sun = SunIcon;
export const Zap = BoltIcon;                      // 闪电 → Bolt
export const Flame = FireIcon;
export const Rocket = RocketLaunchIcon;

// 其他
export const Box = CubeIcon;                      // 3D 盒子 → 立方体
export const Laptop = ComputerDesktopIcon;        // 笔记本 → 桌面电脑
export const MousePointer = CursorArrowRaysIcon;  // 鼠标指针
export const Workflow = QueueListIcon;            // 工作流 → 队列列表
