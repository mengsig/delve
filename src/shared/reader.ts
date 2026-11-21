import type { LessonBlock } from './lesson-blocks';
export type { CodeSpan, LessonBlock } from './lesson-blocks';
import type { Depth, ProviderId } from './domain';

export interface LessonAddress {
  workspaceId: string;
  conceptId: number;
  depth: Depth;
}

export interface ReaderMessage {
  id: number;
  role: 'learner' | 'tutor' | 'system';
  text: string;
  blocks?: LessonBlock[];
  observation?: string;
  recommendation?: { action: string; reason: string; targetId?: number | null };
}

export interface ReaderLesson {
  blocks: LessonBlock[];
  revision: string | null;
  source: string | null;
  invalidLatest: boolean;
  reused: boolean;
  messages: ReaderMessage[];
  earlierMessages: boolean;
}

export interface ReaderContract {
  'reader:start-topic': { request: { workspaceId: string }; response: number };
  'reader:lesson': { request: LessonAddress; response: ReaderLesson };
  'reader:message': { request: LessonAddress & { text: string }; response: ReaderMessage[] };
  'reader:answer': {
    request: LessonAddress & { revision: string; option: number };
    response: { demonstrated: boolean; feedback: string };
  };
}

export type TutorIntent =
  | { kind: 'teach' }
  | { kind: 'ask'; text: string }
  | { kind: 'answer'; revision: string; answer: number | string };

export interface TutorRequest extends LessonAddress {
  intent: TutorIntent;
  provider: ProviderId | 'demo';
}

export interface TutorPreview {
  prompt: string;
  bytes: number;
  files: string[];
  /** Model Delve requests explicitly, or null when the CLI chooses it. */
  model: string | null;
  token: string;
}

export interface TutorContract {
  'tutor:preview': { request: TutorRequest; response: TutorPreview };
  'tutor:run': { request: TutorRequest & { token: string; requestId: string }; response: ReaderLesson };
  'tutor:cancel': { request: { requestId: string }; response: boolean };
}
