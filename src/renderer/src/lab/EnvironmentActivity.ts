import { createContext } from 'react';

export const EnvironmentActivity = createContext<{
  resumeKey?: string;
  onRead: () => void;
  onUse: (key: string, title: string) => void;
} | null>(null);
