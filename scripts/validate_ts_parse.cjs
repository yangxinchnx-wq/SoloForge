// 验证 .ts / .tsx 文件能解析 (AST 阶段)
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

// 脚本在 C:\Users\yangx\Desktop\SoloForge\scripts\ 下
// 仓库根 = 父级父级
const repoRoot = path.resolve(__dirname, "..");

const files = [
  // 浏览器使用服务 (TypeScript 后端)
  "src/core/browser-use/mcp-client.ts",
  "src/core/browser-use/orchestrator.ts",
  "src/core/browser-use/routes.ts",
  "src/core/browser-use/event-bus.ts",
  "src/core/browser-use/task-store.ts",
  "src/core/browser-use/obscura-config.ts",
  "src/core/browser-use/index.ts",
  // UI 组件
  "UI/src/components/ReactStepBubble.tsx",
  "UI/src/components/BrowserTaskCard.tsx",
  "UI/src/components/BrowserUsePanel.tsx",
  "UI/src/components/BrowserUseSettingsModal.tsx",
  "UI/src/components/browser-use.ts",
  "UI/src/hooks/useBrowserUseStream.ts",
];

let total = 0, ok = 0, errors = 0;
for (const rel of files) {
  total++;
  const abs = path.resolve(repoRoot, rel);
  if (!fs.existsSync(abs)) {
    console.log(`MISS ${rel}  (not found)`);
    errors++;
    continue;
  }
  const code = fs.readFileSync(abs, "utf-8");
  const sf = ts.createSourceFile(
    rel, code, ts.ScriptTarget.Latest, true,
    rel.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const diags = sf.parseDiagnostics || [];
  if (diags.length > 0) {
    console.log(`FAIL ${rel}`);
    for (const d of diags) {
      const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
      console.log(`  L${line + 1}:${character + 1}  ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
      errors++;
    }
  } else {
    console.log(`OK   ${rel}`);
    ok++;
  }
}
console.log(`\n${ok}/${total} files parse OK, ${errors} errors`);
process.exit(errors > 0 ? 1 : 0);
