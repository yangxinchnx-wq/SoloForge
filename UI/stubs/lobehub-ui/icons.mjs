// @lobehub/ui/icons 子路径 stub
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

const stub = makeStub('@lobehub/ui/icons');

export const ProviderIcon = stub;
export const ModelIcon = stub;
export const ProviderCombine = stub;
export const ModelCombine = stub;
export const TitleIcon = stub;
export const Avatar = stub;

export default stub;