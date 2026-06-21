export interface FileNode {
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  content?: string;
  isOpen?: boolean;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  avatar: string;
  name: string;
  time: string;
  text: string;
  steps?: {
    title: string;
    status: 'completed' | 'progress' | 'pending';
    progress?: number;
    duration?: string;
    substeps?: { title: string; status: 'completed' | 'progress' | 'pending'; progress?: number; duration?: string }[];
  }[];
}

export interface ChatHistoryItem {
  id: string;
  title: string;
  time: string;
  active?: boolean;
}

export interface SecondaryModel {
  id: string;
  name: string;
  weight: number; // Relative weight, e.g. 1 to 10
}

export interface ThemePreset {
  id: string;
  name: string;
  bg: string;
  surface: string;
  surfaceBright: string;
  primary: string;
  onSurface: string;
  outline: string;
}


