#include "flutter_window.h"

#include <dwmapi.h>
#include <optional>

#include "flutter/generated_plugin_registrant.h"

#pragma comment(lib, "dwmapi.lib")

FlutterWindow::FlutterWindow(const flutter::DartProject& project, HWND parent_hwnd)
    : project_(project), parent_hwnd_(parent_hwnd) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);

  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  flutter_controller_->ForceRedraw();

  HWND current_hwnd = hwnd();
  if (current_hwnd) {
    BOOL dark = TRUE;
    DwmSetWindowAttribute(current_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE,
                          &dark, sizeof(dark));

    MARGINS margins = {0, 0, 0, 0};
    DwmExtendFrameIntoClientArea(current_hwnd, &margins);
  }

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }
  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
    case WM_SIZE: {
      if (flutter_controller_ && parent_hwnd_) {
        RECT parent_rect;
        if (GetClientRect(parent_hwnd_, &parent_rect)) {
          int new_w = parent_rect.right - parent_rect.left;
          int new_h = parent_rect.bottom - parent_rect.top;
          if (new_w > 0 && new_h > 0) {
            SetWindowPos(hwnd, nullptr, 0, 0, new_w, new_h,
                         SWP_NOZORDER | SWP_NOACTIVATE);
          }
        }
      }
      break;
    }
    case WM_ERASEBKGND:
      return 1;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
