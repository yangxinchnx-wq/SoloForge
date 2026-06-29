// @lobehub/ui 包 stub(index,对应 bare import '@lobehub/ui')
// 背景:见 vite.config.ts 中的 alias 注释。目录结构是为了让 @lobehub/ui/icons 子路径也能解析到 icons.mjs。
function makeStub(name) {
  const fn = function () {
    return makeStub(name + '()');
  };
  return new Proxy(fn, {
    get(_, p) {
      if (p === Symbol.toPrimitive) return () => name;
      if (p === 'toString') return () => name;
      if (p === Symbol.iterator) return undefined;
      if (p === 'displayName') return name;
      if (p === '$$typeof') return undefined;
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

const stub = makeStub('@lobehub/ui');

export const Center = stub;
export const Flexbox = stub;
export const Tag = stub;
export const Icon = stub;
export const Avatar = stub;
export const ActionIcon = stub;
export const Box = stub;
export const Button = stub;
export const Text = stub;
export const Highlighter = stub;
export const Markdown = stub;

export default stub;