/**
 * CanvasWindowManagerNative — s3.1: Node FFI 重写
 *
 * 用 koffi 直接调用 Win32 API，替代 PowerShell 方案。
 * 作为 .cjs 文件避免 TypeScript 编译器处理 koffi 类型定义（TS 5.8 兼容性）。
 *
 * 相比 PowerShell:
 *   - 零进程启动开销 (PowerShell 每次 ~50-100ms, 缓存后 ~10ms)
 *   - koffi FFI 调用 ~0.1ms, 快 100x+
 *   - 无编码/转义问题
 *   - 无 shell 注入风险
 *
 * 导出的 API 与 main.cjs 直接对接，也可供 CanvasWindowManager.ts 使用。
 */

const koffi = require('koffi');

// ── Win32 constants ──
const GWL_STYLE = -16;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;

const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_SHOWNA = 8;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_FRAMECHANGED = 0x0020;
const WM_CLOSE = 0x0010;
const WM_NCLBUTTONDOWN = 0x00A1;
const HTCAPTION = 0x0002;

// ── 加载 user32.dll ──
let _user32 = null;
function getUser32() {
  if (!_user32) {
    _user32 = koffi.load('user32.dll');
  }
  return _user32;
}

// ── FFI 函数绑定 (lazy init) ──
let _fn = null;
// 模块级单例 — Koffi 3.0 的 proto() 注册的是全局类型,多次调用会报 "Duplicate type name"
//   所以必须在模块级一次性创建,函数内部复用
let _EnumWindowsProc = null;
function getFns() {
  if (_fn) return _fn;
  const u32 = getUser32();
  // Koffi 3.0: 用 proto() 替代已删除的 callback/proxy
  //   proto 定义回调函数类型本身
  //   pointer(proto) 包装成"指向回调的指针" — 这是 EnumWindows 参数需要的
  if (!_EnumWindowsProc) {
    _EnumWindowsProc = koffi.proto('bool EnumWindowsProc(intptr_t hWnd, intptr_t lParam)');
  }
  _fn = {
    // 窗口父子关系
    SetParent: u32.func('intptr_t SetParent(intptr_t hWndChild, intptr_t hWndNewParent)'),
    GetParent: u32.func('intptr_t GetParent(intptr_t hWnd)'),

    // 窗口样式
    GetWindowLongPtrW: u32.func('intptr_t GetWindowLongPtrW(intptr_t hWnd, int nIndex)'),
    SetWindowLongPtrW: u32.func('intptr_t SetWindowLongPtrW(intptr_t hWnd, int nIndex, intptr_t dwNewLong)'),

    // 窗口位置/大小
    SetWindowPos: u32.func('bool SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'),
    MoveWindow: u32.func('bool MoveWindow(intptr_t hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint)'),

    // 窗口显示/隐藏
    ShowWindow: u32.func('bool ShowWindow(intptr_t hWnd, int nCmdShow)'),

    // 消息
    PostMessage: u32.func('bool PostMessageW(intptr_t hWnd, uint32_t Msg, intptr_t wParam, intptr_t lParam)'),
    SendMessageW: u32.func('intptr_t SendMessageW(intptr_t hWnd, uint32_t Msg, intptr_t wParam, intptr_t lParam)'),
    ReleaseCapture: u32.func('bool ReleaseCapture()'),

    // 进程/窗口查询
    //   关键:out 参数用 _Out_ uint32_t * + Uint32Array(1) + k.as() 才能写回
    //   普通 [0] array 在 Koffi 3.0 不会写回
    GetWindowThreadProcessId: u32.func('uint32_t GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *lpdwProcessId)'),
    IsWindow: u32.func('bool IsWindow(intptr_t hWnd)'),
    IsWindowVisible: u32.func('bool IsWindowVisible(intptr_t hWnd)'),

    // 窗口枚举 (用于 findWindowByPid)
    //   参数是 void * (回调指针 opaque),在调用时传 koffi.register() 返回的 BigInt handle
    EnumWindows: u32.func('bool EnumWindows(void *lpEnumFunc, intptr_t lParam)'),
    GetWindowTextW: u32.func('int GetWindowTextW(intptr_t hWnd, char *lpString, int nMaxCount)'),
  };
  return _fn;
}

// ── 公共 API ──

/**
 * s3.1: 完整嵌入窗口 — 修改样式 + SetParent + 调整位置
 *
 * 将 Flutter 独立窗口转为嵌入式子窗口:
 *   1. 移除标题栏/边框/系统菜单/最小化/最大化按钮
 *   2. 添加 WS_CHILD | WS_VISIBLE
 *   3. SetParent 嵌入到父窗口
 *   4. SetWindowPos 刷新框架
 *   5. ShowWindow 显示
 *
 * @param {number} flutterHwnd - Flutter 窗口句柄
 * @param {number} parentHwnd  - Electron host 窗口句柄
 * @param {number} [x=0]
 * @param {number} [y=0]
 * @param {number} [w=800]
 * @param {number} [h=600]
 * @returns {boolean}
 */
function embedWindowFull(flutterHwnd, parentHwnd, x, y, w, h) {
  try {
    const f = getFns();
    x = x || 0; y = y || 0; w = w || 800; h = h || 600;

    // 1. 读取当前样式
    const oldStyle = f.GetWindowLongPtrW(flutterHwnd, GWL_STYLE);
    if (oldStyle === 0) {
      console.warn('[Native] GetWindowLongPtrW returned 0 for hwnd=', flutterHwnd);
      return false;
    }

    // 2. 移除标题栏/边框/系统菜单/最小化/最大化 + 添加 WS_CHILD | WS_VISIBLE
    let newStyle = oldStyle & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU
      & ~WS_MINIMIZEBOX & ~WS_MAXIMIZEBOX;
    newStyle = newStyle | WS_CHILD | WS_VISIBLE;

    f.SetWindowLongPtrW(flutterHwnd, GWL_STYLE, newStyle);

    // 3. SetParent 嵌入
    f.SetParent(flutterHwnd, parentHwnd);

    // 4. SetWindowPos: 刷新框架 + 调整位置大小 + 不抢焦点
    f.SetWindowPos(flutterHwnd, 0, x, y, w, h,
      SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);

    // 5. ShowWindow
    f.ShowWindow(flutterHwnd, SW_SHOW);

    return true;
  } catch (e) {
    console.warn('[Native] embedWindowFull failed:', e.message);
    return false;
  }
}

/**
 * s3.1: 验证嵌入是否成功
 *
 * 检查:
 *   1. child 窗口仍然存在 (IsWindow)
 *   2. parent 窗口仍然存在 (IsWindow)
 *   3. child 的父窗口确实是 parent (GetParent)
 *
 * @returns {{ ok: boolean, childOk: boolean, parentOk: boolean, isEmbedded: boolean, error?: string }}
 */
function verifyEmbed(flutterHwnd, parentHwnd) {
  try {
    const f = getFns();
    const childOk = f.IsWindow(flutterHwnd);
    const parentOk = f.IsWindow(parentHwnd);
    const curParent = f.GetParent(flutterHwnd);
    const isEmbedded = Number(curParent) === Number(parentHwnd);
    return {
      ok: childOk && parentOk && isEmbedded,
      childOk: !!childOk,
      parentOk: !!parentOk,
      isEmbedded: !!isEmbedded,
    };
  } catch (e) {
    return { ok: false, childOk: false, parentOk: false, isEmbedded: false, error: e.message };
  }
}

/**
 * 嵌入窗口 (简化版, 兼容旧 API)
 * @returns {boolean}
 */
function embedWindow(flutterHwnd, electronHwnd) {
  return embedWindowFull(flutterHwnd, electronHwnd, 0, 0, 0, 0);
}

/**
 * 调整画布窗口大小和位置
 * @returns {boolean}
 */
function moveWindow(hwnd, x, y, w, h) {
  try {
    const f = getFns();
    return !!f.MoveWindow(hwnd, x, y, w, h, true);
  } catch (e) {
    console.warn('[Native] moveWindow failed:', e.message);
    return false;
  }
}

/**
 * 调整画布窗口大小 (SetWindowPos, 兼容旧 API)
 * @returns {boolean}
 */
function resizeCanvas(hwnd, width, height) {
  try {
    const f = getFns();
    f.SetWindowPos(hwnd, 0, 0, 0, width, height,
      SWP_NOMOVE | SWP_NOZORDER | SWP_SHOWWINDOW);
    return true;
  } catch (e) {
    console.warn('[Native] resizeCanvas failed:', e.message);
    return false;
  }
}

/**
 * 显示画布窗口
 * @returns {boolean}
 */
function showCanvas(hwnd) {
  try {
    const f = getFns();
    f.ShowWindow(hwnd, SW_SHOWNA);
    return true;
  } catch (e) {
    console.warn('[Native] showCanvas failed:', e.message);
    return false;
  }
}

/**
 * 隐藏画布窗口
 * @returns {boolean}
 */
function hideCanvas(hwnd) {
  try {
    const f = getFns();
    f.ShowWindow(hwnd, SW_HIDE);
    return true;
  } catch (e) {
    console.warn('[Native] hideCanvas failed:', e.message);
    return false;
  }
}

/**
 * 销毁画布窗口 (发送 WM_CLOSE)
 * @returns {boolean}
 */
function destroyCanvas(hwnd) {
  try {
    const f = getFns();
    f.PostMessage(hwnd, WM_CLOSE, 0, 0);
    return true;
  } catch (e) {
    console.warn('[Native] destroyCanvas failed:', e.message);
    return false;
  }
}

/**
 * 获取窗口所属进程 ID
 *
 * Koffi 3.0 关键改动:out 参数 (uint32_t *) 必须用 _Out_ + Uint32Array(1) + k.as()
 *   普通 [0] 数组在 Koffi 3.0 不会写回(2026-06-28 实测确认)
 *
 * @returns {number | null}
 */
function getWindowProcessId(hwnd) {
  try {
    const f = getFns();
    const ext = new Uint32Array(1);
    const ptr = koffi.as(ext, 'uint32_t*');
    f.GetWindowThreadProcessId(hwnd, ptr);
    const pid = ext[0];
    return pid && pid !== 0 ? pid : null;
  } catch (e) {
    console.warn('[Native] getWindowProcessId failed:', e.message);
    return null;
  }
}

/**
 * 检查窗口是否仍然存在
 * @returns {boolean}
 */
function isWindowAlive(hwnd) {
  try {
    const f = getFns();
    return !!f.IsWindow(hwnd);
  } catch (e) {
    return false;
  }
}

/**
 * 检查窗口是否可见
 * @returns {boolean}
 */
function isWindowVisible(hwnd) {
  try {
    const f = getFns();
    return !!f.IsWindowVisible(hwnd);
  } catch (e) {
    return false;
  }
}

/**
 * s3.1: 通过 PID 查找窗口 (FFI 版)
 *
 * 三级回退 (2026-06-28 修复 HWND not found 错误):
 *   1. 可见 + 顶层窗口 (理想情况)
 *   2. 不可见但顶层 (Flutter 启动初期窗口可能未 ShowWindow)
 *   3. 任意属于该 PID 的窗口 (含子窗口/隐藏窗口)
 *
 * Koffi 3.0 API (2026-06-28 实测确认):
 *   - koffi.proxy() 已被移除
 *   - 用 koffi.proto() 定义回调原型
 *   - 用 koffi.pointer(proto) 包装成"指向回调的指针"类型
 *   - 用 koffi.register(FN, pointerType) 注册 — 注意参数顺序:函数在前
 *   - 返回 BigInt handle,传给 EnumWindows(void *) 作为回调
 *   - GetWindowThreadProcessId 的 out 参数必须用 Uint32Array(1) + k.as()
 *
 * @param {number} pid
 * @returns {number} HWND, 0 表示未找到
 */
function findWindowByPid(pid) {
  let callbackHandle = null;
  try {
    const f = getFns();
    let level1 = 0;  // 可见 + 顶层
    let level2 = 0;  // 顶层 (不管可见)
    let level3 = 0;  // 任意属于该 PID

    // Koffi 3.0: register(fn, pointerType) — fn 在前,type 在后
    callbackHandle = koffi.register((hwnd, _lParam) => {
      // 检查 PID (out buffer 用 Uint32Array + k.as)
      const ext = new Uint32Array(1);
      const ptr = koffi.as(ext, 'uint32_t*');
      f.GetWindowThreadProcessId(hwnd, ptr);
      if (ext[0] !== pid) return true;

      // PID 匹配 → 至少 level3
      if (level3 === 0) level3 = Number(hwnd);

      // 检查是否顶层 (无父窗口)
      const parent = f.GetParent(hwnd);
      const isTopLevel = Number(parent) === 0;
      if (!isTopLevel) return true;  // 子窗口,跳过

      // 顶层 → level2
      if (level2 === 0) level2 = Number(hwnd);

      // 可见 → level1
      if (level1 === 0 && f.IsWindowVisible(hwnd)) {
        level1 = Number(hwnd);
        return false;  // 理想命中,停止枚举
      }

      return true; // 继续找
    }, koffi.pointer(_EnumWindowsProc));

    f.EnumWindows(callbackHandle, 0);

    // 优先级: 可见顶层 > 任意顶层 > 任意属于该 PID
    return level1 || level2 || level3;
  } catch (e) {
    console.warn('[Native] findWindowByPid FFI failed:', e.message);
    return 0;
  } finally {
    if (callbackHandle) {
      try { koffi.unregister(callbackHandle); } catch (_) {}
    }
  }
}

/**
 * s3.1: 嵌入健康检查 — 验证所有嵌入窗口是否仍然正常
 *
 * 检查项:
 *   1. child 窗口仍然存在 (IsWindow)
 *   2. parent 窗口仍然存在 (IsWindow)
 *   3. child 的父窗口确实是 parent (GetParent)
 *
 * @param {Array<{childHwnd: number, parentHwnd: number, sessionId: string}>} sessions
 * @returns {{ healthy: Array, broken: Array }}
 */
function healthCheck(sessions) {
  const healthy = [];
  const broken = [];
  try {
    const f = getFns();
    for (const s of sessions) {
      const childOk = f.IsWindow(s.childHwnd);
      const parentOk = f.IsWindow(s.parentHwnd);
      const curParent = childOk ? f.GetParent(s.childHwnd) : 0;
      const isEmbedded = Number(curParent) === Number(s.parentHwnd);
      if (childOk && parentOk && isEmbedded) {
        healthy.push(s);
      } else {
        broken.push({
          ...s,
          childOk: !!childOk,
          parentOk: !!parentOk,
          isEmbedded: !!isEmbedded,
          curParent: Number(curParent),
        });
      }
    }
  } catch (e) {
    // 出错时全部标记为 broken
    for (const s of sessions) {
      broken.push({ ...s, childOk: false, parentOk: false, isEmbedded: false, error: e.message });
    }
  }
  return { healthy, broken };
}

/**
 * s3.1: 尝试恢复嵌入 (re-embed)
 *
 * 当健康检查发现窗口脱离时, 重新执行 embedWindowFull.
 * 与首次嵌入不同: 这里不需要读旧样式 (样式可能已损坏), 直接设置目标样式.
 *
 * @param {number} flutterHwnd
 * @param {number} parentHwnd
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
function reEmbed(flutterHwnd, parentHwnd, x, y, w, h) {
  try {
    const f = getFns();
    x = x || 0; y = y || 0; w = w || 800; h = h || 600;

    // 直接设置目标样式 (不读旧样式, 避免读到损坏的值)
    const targetStyle = WS_CHILD | WS_VISIBLE;
    f.SetWindowLongPtrW(flutterHwnd, GWL_STYLE, targetStyle);

    // SetParent
    const oldParent = f.SetParent(flutterHwnd, parentHwnd);

    // SetWindowPos: 刷新框架 + 调整位置 + 不抢焦点
    f.SetWindowPos(flutterHwnd, 0, x, y, w, h,
      SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);

    // ShowWindow
    f.ShowWindow(flutterHwnd, SW_SHOW);

    // 验证
    const curParent = f.GetParent(flutterHwnd);
    const isEmbedded = Number(curParent) === Number(parentHwnd);
    console.log('[Native] reEmbed: oldParent=', Number(oldParent),
      'newParent=', Number(curParent), 'embedded=', isEmbedded);

    return isEmbedded;
  } catch (e) {
    console.warn('[Native] reEmbed failed:', e.message);
    return false;
  }
}
/**
 * 启动原生窗口拖动（Win32 ReleaseCapture + SendMessage WM_NCLBUTTONDOWN）
 *
 * 调用后 Windows 接管拖动，零 IPC 开销，丝滑流畅。
 * SendMessage 会阻塞直到用户松开鼠标，所以必须在 mousedown 事件中调用。
 *
 * @param {number|bigint} hwnd - 窗口句柄
 * @returns {boolean}
 */
function startNativeDrag(hwnd) {
  try {
    const f = getFns();
    // koffi v3: 指针类型 (intptr_t/HANDLE) 必须是 BigInt
    //   readInt32LE 返回普通 Number, 直接传会触发 TypeError
    //   用 BigInt() 包装最稳, 接受 Number 和 BigInt 两种入参
    const h = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd);
    f.ReleaseCapture();
    f.SendMessageW(h, WM_NCLBUTTONDOWN, HTCAPTION, 0n);
    return true;
  } catch (e) {
    console.warn('[Native] startNativeDrag failed:', e.message);
    return false;
  }
}
module.exports = {
  // 核心嵌入 API
  embedWindowFull,
  embedWindow,
  verifyEmbed,
  moveWindow,
  // s3.1: 健康检查 + 恢复
  healthCheck,
  reEmbed,

  // 原生窗口拖动（Win32 ReleaseCapture + WM_NCLBUTTONDOWN）
  startNativeDrag,

  // 兼容旧 API
  resizeCanvas,
  showCanvas,
  hideCanvas,
  destroyCanvas,

  // 查询 API
  getWindowProcessId,
  isWindowAlive,
  isWindowVisible,
  findWindowByPid,
};