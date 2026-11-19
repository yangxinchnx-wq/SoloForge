// SoloForge Tauri 壳 — 加载现有 UI (4000 端口)
// 重写方案阶段 3: Electron → Tauri (内存减半, 打包体积缩小)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
