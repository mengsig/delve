import assert from 'node:assert/strict';

type Feedback = { focus?: 'arrival' | 'claim' | 'shutter'; feedback: string };
type Decision = 'current' | 'expired' | 'arrival';

const offlineLimit = 'I can’t judge this reasoning offline. ';
const leaseModel = 'The writer compares the submitted claim with its active generation at commit time. Even the first result can carry an expired claim.';
const shutterModel = 'At the same subject speed, a shorter exposure records a shorter motion trail. At a fixed shutter time, changing ISO changes recorded brightness while motion trails keep their length.';

const validityWords = /\b(current|active|expired|stale) (?:lease|claim|generation|token)\b/g;
const namedClaim = /^(?:(?:the|an?) )?(current|expired) claim(?:'s result)?$/;
const winningClaim = /^(?:(?:the|an?) )?(current|expired) claim (?:wins|should win|(?:should be|is) (?:accepted|saved|committed))$/;

function chosenClaim(decision: string): string | undefined {
  const subject = winningClaim.exec(decision);
  if (subject) return subject[1];
  const action = decision.replace(/^(?:i|we|the writer|the queue) (?:(?:would|will|should|must) )?/, '');
  const selected = /^(?:accept|save|commit|write|choose|pick) (.+)$/.exec(action)?.[1];
  if (!selected) return;
  const claim = selected.replace(/^(?:the|a) (?:result|write) (?:from|under|with) /, '');
  return namedClaim.exec(claim)?.[1];
}

// Match the entire explanation. An unrecognized qualification or second statement keeps it unassessed.
function leaseDecision(statement: string): Decision | undefined {
  if (/^(?:the first result wins|arrival order decides which result is accepted)$/.test(statement)) return 'arrival';
  const normalized = statement.replace(validityWords, (_, word: string) =>
    word === 'active' || word === 'current' ? 'current claim' : 'expired claim');
  const [decision, alternative, ...more] = normalized.split(/\s+(?:over|instead of|rather than)\s+/);
  if (!decision || more.length) return;
  const chosen = chosenClaim(decision);
  if (chosen !== 'current' && chosen !== 'expired') return;
  if (alternative === undefined) return chosen;
  const rejected = namedClaim.exec(alternative)?.[1];
  return rejected && rejected !== chosen ? chosen : undefined;
}

function leaseFeedback(statement: string): Feedback {
  switch (leaseDecision(statement)) {
    case 'current': return { focus: 'claim', feedback: 'That matches the key idea. ' + leaseModel };
    case 'expired': return { focus: 'claim', feedback: 'An expired claim cannot authorize a write. ' + leaseModel };
    case 'arrival': return { focus: 'arrival', feedback: 'Arrival order cannot authorize a write. ' + leaseModel };
    default: return { feedback: offlineLimit + leaseModel };
  }
}

function shutterFeedback(statement: string): Feedback {
  const relation = /^(?:a )?(shorter|longer) (?:exposure|shutter time) (reduces|increases) motion blur$/.exec(statement);
  if (!relation) return { feedback: offlineLimit + shutterModel };
  const matches = (relation[1] === 'shorter') === (relation[2] === 'reduces');
  return { focus: 'shutter', feedback: (matches ? 'That matches the key idea. ' : '') + shutterModel };
}

export function reasoningFeedback(id: string, reasoning: string, modelReasoning: string): Feedback {
  assert.ok(id && modelReasoning.trim(), 'each demo check needs model reasoning');
  assert.ok(reasoning.trim(), 'only a supplied explanation needs feedback');
  const statement = reasoning.trim().toLowerCase().replaceAll('’', "'").replace(/\s+/g, ' ').replace(/\.$/, '');
  if (id === 'lease') return leaseFeedback(statement);
  if (id === 'exposure' || id === 'iso' || id === 'shutter') return shutterFeedback(statement);
  return { feedback: offlineLimit + modelReasoning };
}
