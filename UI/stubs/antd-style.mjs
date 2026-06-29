// antd-style 本地空实现 stub
// 背景:antd-style 包本身在 node_modules 中存在,但它会 `import { theme, version, ConfigProvider, message, Modal, notification } from 'antd'`,
//       而 antd 未安装。通过给 antd 别名到 stub,antd-style 就能正常加载(它内部的 theme/ConfigProvider 等会变成 Proxy stub)。

function makeStub(name) {
  const fn = function () {
    return makeStub(name + '()');
  };
  return new Proxy(fn, {
    get(_, p) {
      if (p === Symbol.toPrimitive) return () => name;
      if (p === 'toString') return () => name;
      if (p === Symbol.iterator) return undefined;
      return makeStub(name + '.' + String(p));
    },
    apply() {
      return makeStub(name + '()');
    },
    construct() {
      return makeStub(name + '#instance');
    },
  });
}

const stub = makeStub('antd-style');

export const createStyles = stub;
export const createUseStyles = stub;
export const createStaticStyles = stub;
export const createThemeProvider = stub;
export const cssVar = stub;
export const useThemeMode = stub;
export const useAntdTheme = stub;
export const useAntdToken = stub;
export const useAntdStylish = stub;
export const useResponsive = stub;
export const extractStaticStyle = stub;
export const extractStyle = stub;
export const StyleProvider = stub;
export const AntdProvider = stub;
export const ConfigProvider = stub;

export default stub;