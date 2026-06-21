#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include <cstdlib>
#include <iostream>
#include <string>

#include "flutter_window.h"
#include "utils.h"

bool ParseArg(const std::string& prefix, const std::string& arg, std::string& out) {
  if (arg.find(prefix) == 0) {
    auto val = arg.substr(prefix.size());
    if (!val.empty() && val[0] == '=') val = val.substr(1);
    out = val;
    return true;
  }
  return false;
}

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> args = GetCommandLineArguments();
  project.set_dart_entrypoint_arguments(std::move(args));

  HWND parentHwnd = nullptr;
  int port = 0;
  int canvasWidth = 800;
  int canvasHeight = 600;

  for (const auto& arg : GetCommandLineArguments()) {
    std::string val;
    if (ParseArg("--parent-hwnd", arg, val)) {
      parentHwnd = reinterpret_cast<HWND>(std::stoull(val, nullptr, 0));
    } else if (ParseArg("--port", arg, val)) {
      port = std::stoi(val);
    } else if (ParseArg("--canvas-width", arg, val)) {
      canvasWidth = std::stoi(val);
    } else if (ParseArg("--canvas-height", arg, val)) {
      canvasHeight = std::stoi(val);
    }
  }

  FlutterWindow window(project, parentHwnd);
  Win32Window::Point origin(0, 0);
  Win32Window::Size size(canvasWidth, canvasHeight);

  DWORD style = WS_POPUP;
  if (parentHwnd) {
    style = WS_CHILD | WS_VISIBLE;
  } else {
    style = WS_POPUP | WS_VISIBLE;
  }

  if (!window.CreateWithStyle(L"canvas_preview", style, 0, origin, size)) {
    return EXIT_FAILURE;
  }

  window.SetQuitOnClose(true);

  if (parentHwnd) {
    HWND flutterHwnd = window.GetHandle();
    if (flutterHwnd) {
      ::SetWindowLongPtr(flutterHwnd, GWL_STYLE,
                         WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS);
      ::SetParent(flutterHwnd, parentHwnd);
      ::SetWindowPos(flutterHwnd, nullptr, 0, 0, canvasWidth, canvasHeight,
                     SWP_NOZORDER | SWP_NOACTIVATE);
      ::ShowWindow(flutterHwnd, SW_SHOW);
    }
  }

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
