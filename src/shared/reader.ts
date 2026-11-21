import type { Depth } from './domain';

export interface LessonAddress {
  workspaceId: string;
  conceptId: number;
  depth: Depth;
}

export interface CodeSpan {
  line: number;
  start: number;
  end: number;
}

export type LessonBlock =
  | { type: 'prose'; heading: string; text: string }
  | { type: 'diagram'; nodes: string[] }
  | { type: 'trace'; steps: string[] }
  | { type: 'code'; source: string; lines: string[]; span?: CodeSpan }
  | { type: 'check'; prompt: string; options: string[] }
  | { type: 'environment'; fallback?: string }
  | { type: 'unknown'; name: string };

export interface ReaderMessage {
  id: number;
  role: 'learner' | 'tutor' | 'system';
  text: string;
}

export interface ReaderLesson {
  blocks: LessonBlock[];
  revision: string | null;
  source: string | null;
  invalidLatest: boolean;
  messages: ReaderMessage[];
  earlierMessages: boolean;
}

export interface ReaderContract {
  'reader:lesson': { request: LessonAddress; response: ReaderLesson };
  'reader:message': { request: LessonAddress & { text: string }; response: ReaderMessage[] };
  'reader:answer': {
    request: LessonAddress & { revision: string; option: number };
    response: { demonstrated: boolean; feedback: string };
  };
}
