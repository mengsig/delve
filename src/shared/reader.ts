import type { LessonBlock } from './lesson-blocks';
export type { CodeSpan, LessonBlock } from './lesson-blocks';
import type { Depth, ProviderId } from './domain';

export interface LessonAddress {
  workspaceId: string;
  conceptId: number;
  depth: Depth;
}

export const lessonKey = ({ workspaceId, conceptId, depth }: LessonAddress) => [workspaceId, conceptId, depth].join('/');

export interface ReaderMessage {
  id: number;
  role: 'learner' | 'tutor' | 'system';
  text: string;
  blocks?: LessonBlock[];
  observation?: string;
  reasoningFeedback?: string;
  correct?: boolean;
  recommendation?: { action: string; reason: string; targetId?: number | null };
}

export interface ActiveMasteryCheck {
  kind: 'recognition' | 'applied';
  prompt: string;
  options?: string[];
  hint?: string;
}

export interface ReaderMastery {
  stage: 'teaching' | 'checking' | 'review' | 'understood' | 'skipped';
  revision: string | null;
  activeCheck: ActiveMasteryCheck | null;
  attempts: number;
  maxAttempts: number;
  correctAnswers: number;
  requiredCorrectAnswers: number;
  appliedPassed: boolean;
  needsAdaptation: boolean;
}

export interface ReaderLesson {
  blocks: LessonBlock[];
  revision: string | null;
  source: string | null;
  invalidLatest: boolean;
  reused: boolean;
  messages: ReaderMessage[];
  earlierMessages: boolean;
  mastery: ReaderMastery;
}

export interface ReaderContract {
  'reader:start-topic': { request: { workspaceId: string }; response: number };
  'reader:lesson': { request: LessonAddress; response: ReaderLesson };
  'reader:message': { request: LessonAddress & { text: string }; response: ReaderMessage[] };
  'reader:skip': {
    request: LessonAddress & { revision: string };
    response: ReaderLesson;
  };
}

export type TutorIntent =
  | { kind: 'teach' }
  | { kind: 'review'; revision: string }
  | { kind: 'adapt'; revision: string }
  | { kind: 'ask'; text: string }
  | { kind: 'answer'; revision: string; answer: number | string; reasoning?: string };

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
  modelSource: 'demo' | 'override' | 'codex-config' | 'default';
  token: string;
}

export interface TopicPreviewRequest {
  title: string;
  depth: Depth;
  provider: ProviderId;
}

export type TopicPreview = Omit<TutorPreview, 'token'>;

export type SavedTutorJob = {
  id: string;
  title: string;
  request: TutorRequest;
  submittedAnswer?: string;
} & ({ phase: 'running' | 'ready' } | { phase: 'failed'; code: string; message: string });

export type UnreadableTutorJobIdentity = { jobKey: string; version: string };
export type UnreadableTutorJob = UnreadableTutorJobIdentity & { phase: 'unreadable'; message: string };
export type TutorJobEntry = SavedTutorJob | UnreadableTutorJob;

export interface TutorContract {
  'tutor:preview-topic': { request: TopicPreviewRequest; response: TopicPreview };
  'tutor:preview': { request: TutorRequest; response: TutorPreview };
  'tutor:run': { request: TutorRequest & { token: string; requestId: string }; response: ReaderLesson };
  'tutor:cancel': { request: { requestId: string }; response: boolean };
  'tutor:jobs': { request: null; response: TutorJobEntry[] };
  'tutor:wait': { request: { requestId: string }; response: ReaderLesson };
  'tutor:retry': { request: { requestId: string; provider: TutorRequest['provider'] }; response: ReaderLesson };
  'tutor:dismiss': { request: { requestId: string }; response: boolean };
  'tutor:dismiss-unreadable': { request: UnreadableTutorJobIdentity; response: 'dismissed' | 'changed' | 'active' };
}
