// antd 本地空实现 stub
// 背景:@lobehub/icons / antd-style 的某些子入口会 `import { theme, version, Grid, ... } from 'antd'`,
//       但本项目未安装 antd。esbuild 做静态导出分析,必须把每个被引用的名字都显式 export。
// 策略:所有名字都赋值为 Proxy stub。任何访问/调用/构造都返回更深的 stub,渲染期调用不会抛错。

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

const stub = makeStub('antd');
const comp = (n) => makeStub('antd.' + n);

// 通用组件 / API 表面
export const Affix = comp('Affix');
export const Alert = comp('Alert');
export const Anchor = comp('Anchor');
export const App = comp('App');
export const AutoComplete = comp('AutoComplete');
export const Avatar = comp('Avatar');
export const BackTop = comp('BackTop');
export const Badge = comp('Badge');
export const Breadcrumb = comp('Breadcrumb');
export const Button = comp('Button');
export const Calendar = comp('Calendar');
export const Card = comp('Card');
export const Carousel = comp('Carousel');
export const Cascader = comp('Cascader');
export const Checkbox = comp('Checkbox');
export const Col = comp('Col');
export const Collapse = comp('Collapse');
export const Comment = comp('Comment');
export const ConfigProvider = comp('ConfigProvider');
export const ConfigContext = comp('ConfigContext');
export const DatePicker = comp('DatePicker');
export const Descriptions = comp('Descriptions');
export const Divider = comp('Divider');
export const Drawer = comp('Drawer');
export const Dropdown = comp('Dropdown');
export const Empty = comp('Empty');
export const Flex = comp('Flex');
export const FloatButton = comp('FloatButton');
export const Form = comp('Form');
export const Grid = comp('Grid');
export const Image = comp('Image');
export const Input = comp('Input');
export const InputNumber = comp('InputNumber');
export const Layout = comp('Layout');
export const List = comp('List');
export const Menu = comp('Menu');
export const Mentions = comp('Mentions');
export const message = comp('message');
export const Modal = comp('Modal');
export const notification = comp('notification');
export const PageHeader = comp('PageHeader');
export const Pagination = comp('Pagination');
export const Popconfirm = comp('Popconfirm');
export const Popover = comp('Popover');
export const Progress = comp('Progress');
export const QRCode = comp('QRCode');
export const Radio = comp('Radio');
export const Rate = comp('Rate');
export const Result = comp('Result');
export const Row = comp('Row');
export const Segmented = comp('Segmented');
export const Select = comp('Select');
export const Skeleton = comp('Skeleton');
export const Slider = comp('Slider');
export const Space = comp('Space');
export const Spin = comp('Spin');
export const Splitter = comp('Splitter');
export const Statistic = comp('Statistic');
export const Steps = comp('Steps');
export const Switch = comp('Switch');
export const Table = comp('Table');
export const Tabs = comp('Tabs');
export const Tag = comp('Tag');
export const theme = stub;
export const TimePicker = comp('TimePicker');
export const Timeline = comp('Timeline');
export const Tooltip = comp('Tooltip');
export const Tour = comp('Tour');
export const Transfer = comp('Transfer');
export const Tree = comp('Tree');
export const TreeSelect = comp('TreeSelect');
export const Typography = comp('Typography');
export const Upload = comp('Upload');
export const version = '0.0.0-stub';
export const Watermark = comp('Watermark');

export default stub;