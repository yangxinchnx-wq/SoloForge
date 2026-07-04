/**
 * 统一的文件树节点类型
 *
 * 历史：FileNode 曾在 3 处重复定义且字段不一致
 *   - src/types.ts: { name, type, children?, content?, isOpen? }（UI 树用）
 *   - src/services/fileSystem.ts: { name, type, path, children?, size?, mtime? }（文件系统用）
 *   - src/components/FileExplorer.tsx: { name, type, path, children? }（组件局部用）
 *
 * 现在统一为单一 source-of-truth，所有字段可选（按使用场景填充）
 */
export interface FileNode {
  name: string;
  type: 'file' | 'folder';
  /** 完整路径（fileSystem / FileExplorer 用，UI 树可不带） */
  path?: string;
  /** 子节点（folder 用） */
  children?: FileNode[];
  /** 文件内容缓存（UI 树展开时用） */
  content?: string;
  /** 树节点展开状态（UI 用） */
  isOpen?: boolean;
  /** 文件大小，字节（元数据） */
  size?: number;
  /** 修改时间，Unix ms（元数据） */
  mtime?: number;
}
