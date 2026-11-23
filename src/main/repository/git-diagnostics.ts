import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import { OBJECT_ID } from './source-policy';
import type { CommandResult } from './source-process';

const DIAGNOSTIC_LIMIT = 1024;
const BOOLEAN_CONFIG = 'bad boolean config value';
const CONFIG_KEY = / for '([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)'$/i;
const OBJECT_CLASS = /^(?:bad object|could not read|could not parse|cannot read commit object|failed to read object|Failed to traverse parents of commit) ([a-f0-9]+)$/i;
const CORRUPT_OBJECT = /^(?:loose|packed) object ([a-f0-9]+) \(stored in .+\) is corrupt$/i;
const MESSAGE_CLASSES = [
  BOOLEAN_CONFIG, 'bad numeric config value', 'bad config value', 'bad config line', 'invalid config format',
  'unknown date format', 'bad --ignore-submodules argument', 'invalid color value', 'unsupported object format',
  'not a git repository', 'detected dubious ownership', 'revision walk setup failed', 'git cat-file: could not get object info',
  'Failed to traverse parents of commit', 'bad object', 'loose object', 'packed object', 'could not parse',
  'cannot read commit object', 'failed to read object', 'failed to read', 'could not read', 'cannot read',
  'cannot open', 'unable to open', 'could not reach', 'ambiguous argument',
];

function safeReason(message: string, completeDiagnostic?: string): string | undefined {
  // Only known Git classes and structured fields can cross the renderer boundary.
  const reason = MESSAGE_CLASSES.find(key => message === key || message.startsWith(key + ' ') || message.startsWith(key + ':'));
  if (!completeDiagnostic || !reason) return reason;
  if (reason === BOOLEAN_CONFIG && message.startsWith(BOOLEAN_CONFIG + " '")) {
    const key = CONFIG_KEY.exec(completeDiagnostic)?.[1];
    if (key) return reason + ' for ' + key;
  }
  const object = OBJECT_CLASS.exec(message)?.[1] ?? CORRUPT_OBJECT.exec(message)?.[1];
  if (object && OBJECT_ID.test(object)) return reason + ' ' + object;
  return reason;
}

function diagnosticSummary(result: CommandResult): string {
  const { diagnostic, truncated } = result;
  const match = /^fatal:.*/m.exec(diagnostic) ?? /^error:.*/m.exec(diagnostic) ?? /^warning:.*/m.exec(diagnostic);
  if (!match) return '';
  const [line] = match;
  const end = line.indexOf(':') + 1;
  const level = line.slice(0, end);
  const completeDiagnostic = !truncated && match.index === 0 ? diagnostic.trimEnd() : undefined;
  const reason = safeReason(line.slice(end).trimStart(), completeDiagnostic);
  const summary = (reason ? level + ' ' + reason : level).slice(0, DIAGNOSTIC_LIMIT).trimEnd();
  assert.ok(summary.length <= DIAGNOSTIC_LIMIT && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(summary));
  assert.match(summary, /^(?:fatal|error|warning):/);
  return summary;
}

export function gitReadState(result: CommandResult, outputLimit?: number): 'complete' | 'limited' | 'failed' {
  assert.ok(Number.isInteger(result.status));
  assert.ok(Buffer.isBuffer(result.output));
  if (result.truncated) {
    // Node caps each stream independently. Stderr can contain advice during a successful read.
    const stdoutLimited = outputLimit !== undefined && result.output.length === outputLimit
      && Buffer.byteLength(result.diagnostic) < outputLimit;
    return stdoutLimited && result.status === 0 && !/^(?:fatal|error):/m.test(result.diagnostic) ? 'limited' : 'failed';
  }
  return result.status === 0 && !/^fatal:/m.test(result.diagnostic) ? 'complete' : 'failed';
}

export function gitReadFailed(result: CommandResult, message: string): never {
  const detail = diagnosticSummary(result);
  throw new DomainError('SOURCE_READ_FAILED', detail ? message + ' ' + detail : message);
}

export function gitOutput(result: CommandResult, message: string, outputLimit?: number): Buffer {
  if (gitReadState(result, outputLimit) === 'failed') gitReadFailed(result, message);
  return result.output;
}
