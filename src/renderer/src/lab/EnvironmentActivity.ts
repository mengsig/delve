import { createContext } from 'react';

export const EnvironmentActivity = createContext<{
  resumeKey?: string;
  onUse: (key: string, title: string) => void;
} | null>(null);
