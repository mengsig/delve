export interface CodeSpan {
  line: number;
  start: number;
  end: number;
}

export interface DiagramEdge {
  from: number;
  to: number;
  label?: string;
}

export const CHECK_ANSWER_LIMIT = 4000;

export type ChoiceCheck = {
  type: 'check';
  kind?: 'choice' | 'prediction';
  prompt: string;
  options: string[];
};

export type WrittenCheck = {
  type: 'check';
  kind: 'short-answer' | 'prediction';
  prompt: string;
  options?: never;
};

export type LessonBlock =
  | { type: 'prose'; heading: string; text: string }
  | { type: 'analogy'; heading: string; text: string }
  | { type: 'callout'; heading: string; text: string }
  | { type: 'example'; heading: string; setup: string; steps: string[]; takeaway: string }
  | { type: 'comparison'; heading: string; columns: string[]; rows: string[][] }
  | { type: 'comparison'; heading: string; before: string; after: string }
  | { type: 'diagram'; nodes: string[]; edges?: DiagramEdge[] }
  | { type: 'trace'; steps: string[] }
  | { type: 'code'; source: string; lines: string[]; span?: CodeSpan; spans?: CodeSpan[] }
  | { type: 'environment'; fallback?: string; runtime?: 'delve.env/1'; pack?: string }
  | ChoiceCheck
  | WrittenCheck
  | { type: 'unknown'; name: string };
