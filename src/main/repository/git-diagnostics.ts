import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import { sourceText } from './source-policy';
import type { CommandResult } from './source-process';

const DIAGNOSTIC_LIMIT = 1024;
const BAD_VALUE = /^((?:fatal|error|warning): bad (?:[a-z-]+ )*value)\b/i;
const CONFIG_KEY = / for '([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)'(?:: (?:invalid unit|out of range))?$/i;
const VALUE_START = /(?<assignment>(?<![\w.-])[\w.-]+=)|['"`]|(?<![\w+.-])[a-z][\w+.-]*:\/\/[^/\s]*@|(?<![\w./\\-])(?:\/|[a-z]:[/\\]|\\\\)/iu;

function diagnosticSummary(diagnostic: string): string {
  const text = diagnostic.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => character === '\n' ? '\n' : ' ').trim();
  // Git can interpolate unescaped quotes and newlines. Keep only the prefix before a value.
  const value = VALUE_START.exec(text);
  const prefix = value ? text.slice(0, value.index) + (value.groups?.assignment ?? '') + '[redacted]' : text;
  const lines = prefix.split('\n');
  const detail = lines.find(line => line.startsWith('fatal:')) ?? lines.find(line => line.startsWith('error:'))
    ?? lines.find(line => line.startsWith('warning:'));
  if (!detail?.startsWith('fatal:') && /^fatal:/m.test(text)) return 'fatal:';
  if (!detail) return '';

  const badValue = BAD_VALUE.exec(detail);
  if (badValue) {
    const key = CONFIG_KEY.exec(text)?.[1];
    return (key ? `${badValue[0]} for ${key}` : badValue[0]).slice(0, DIAGNOSTIC_LIMIT);
  }

  const level = detail.slice(0, detail.indexOf(':') + 1);
  return sourceText(Buffer.from(detail)) === null ? level : detail.slice(0, DIAGNOSTIC_LIMIT).trimEnd();
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
  const detail = diagnosticSummary(result.diagnostic);
  throw new DomainError('SOURCE_READ_FAILED', detail ? message + ' ' + detail : message);
}

export function gitOutput(result: CommandResult, message: string, outputLimit?: number): Buffer {
  if (gitReadState(result, outputLimit) === 'failed') gitReadFailed(result, message);
  return result.output;
}
