import assert from 'node:assert/strict';

type Feedback = { focus?: 'arrival' | 'claim' | 'iso' | 'shutter'; feedback: string };

const arrival = /\b(?:(?:arrival|completion) order|(?:the )?first (?:one|result|worker|write|writer|to (?:finish|report|arrive))|who(?:ever)? (?:arrives|reports|finishes) first|(?:arriv(?:e[ds]?|ing)|finish(?:ed|es|ing)?|report(?:ed|s|ing)?|got back) first)\b/;
const leaseNames = /\b(current|active|valid|newer|latest|updated|stale|expired|old|older|outdated) (?:lease|claim|generation|token)\b/g;
const expired = /^(?:stale|expired|old|older|outdated)$/;
const claimAsSubject = /^(?:(?:the|an?) )?(current|expired) claim (?:wins?|should win|(?:should be|can be|is) (?:accepted|saved|committed))$/;
const namedClaim = /^(?:(?:the|an?) )?(current|expired) claim(?:'s result)?$/;
const holdsCurrent = /^(?:worker )?[a-z0-9-]+ (?:still |now )?(?:holds|has|owns) (?:the |a )?current claim(?: now)?$/;
const negation = /\b(?:no|not|never|neither|cannot|can't|doesn't|don't|isn't|wasn't)\b/;
const uncertainty = /\b(?:maybe|perhaps|might|may|not sure|unsure|could be|depends|if)\b/;

const iso = /\b(?:iso|sensor gain)\b/;
const brightness = /\b(?:bright(?:er|ens?|ening|ness)?|dark(?:er|ens?|ening|ness)?|signal level|exposure compensation)\b/;
const shutter = /\b(?:shutter(?: (?:speed|time|duration))?|(?:shorter|longer|shorten|lengthen) (?:the )?(?:exposure|capture)(?: (?:time|duration))?|exposure (?:time|duration))\b/;
const motion = /\b(?:motion|blur|smear|streaks?|trails?|movement|freez\w+|sharp\w+)\b/;
const shorter = /\b(?:short(?:er|ens?|ening)?|faster|less time|halv\w+)\b/;
const longer = /\b(?:long(?:er|er-lasting)?|lengthen\w*|slower|more time|doubl\w+)\b/;
const moreBlur = /\b(?:more|extra|adds?|longer|increases?|lengthens?|worse) (?:motion(?: blur)?|blur|smear|streaks?|trails?)\b/;
const lessBlur = /\b(?:less|shorter|reduces?|limits?|cuts?|stops?) (?:motion(?: blur)?|blur|smear|streaks?|trails?)\b|\b(?:freez\w+|sharp\w+)\b/;
const unchangedMotion = /\b(?:unchanged|stays? the same|without (?:adding|increasing|changing|affecting))\b/;
const effect = /\b(?:affects?|controls?|changes?|shortens?|lengthens?|reduces?|limits?|cuts?|freez\w+|stops?|keeps?|gives?|makes?|mak(?:ing|e)|helps?|decides?|determines?|moves?|brightens?|darkens?|adjusts?|boosts?|compensates?|restores?|unchanged|stays? (?:the same|fixed))\b/;

function selectedResultClaim(decision: string): string | undefined {
  const action = decision.replace(/^(?:i|we|the writer|the queue) (?:(?:would|will|should|must) )?/, '');
  const selected = /^(?:accept|save|commit|write|choose|pick) (.+)$/.exec(action)?.[1];
  if (!selected) return;
  const claim = selected.replace(/^(?:the|a) (?:result|write) (?:from|under|with) /, '');
  return namedClaim.exec(claim)?.[1];
}

// Recognize an explicit choice only when its entire decision clause and any contrasted alternative fit.
function statedClaim(clause: string): string | undefined {
  const [decision, alternative, ...extra] = clause.split(/\s+(?:over|instead of|rather than)\s+/);
  if (!decision || extra.length) return;
  const chosen = claimAsSubject.exec(decision)?.[1] ?? selectedResultClaim(decision);
  if (!chosen || alternative === undefined) return chosen;
  const other = namedClaim.exec(alternative)?.[1];
  return other && other !== chosen ? chosen : undefined;
}

function leaseFeedback(clauses: string[]): Feedback | undefined {
  const normalized = clauses.map(clause => clause.trim().replace(leaseNames,
    (_, adjective: string) => expired.test(adjective) ? 'expired claim' : 'current claim'));
  const decisions = normalized.map(statedClaim);
  if (decisions.includes('expired') && decisions.includes('current')) return { focus: 'claim',
    feedback: 'Those choices would authorize different workers. Which returned claim matches the active generation at commit time?' };
  if (decisions.includes('expired')) return { focus: 'claim',
    feedback: 'An expired claim cannot authorize a write. The writer accepts a result only when its claim matches the active generation.' };
  const mentionsOrder = clauses.some(clause => arrival.test(clause));
  const mentionsClaim = normalized.some(clause => /\b(?:current|expired) claim\b/.test(clause));
  if (mentionsOrder && mentionsClaim) return { focus: 'arrival',
    feedback: 'Arrival order and lease ownership can point to different workers. Which claim would your rule accept, and how would it identify the current owner?' };
  if (mentionsOrder) return { focus: 'arrival',
    feedback: 'You mentioned arrival order. Even the first result can carry an expired claim. Compare it with the active generation.' };
  if (decisions.includes('current')) return { focus: 'claim',
    feedback: 'Choosing the current claim matches the commit rule. The writer checks the submitted claim against its active generation.' };
  if (normalized.some(clause => holdsCurrent.test(clause))) return { focus: 'claim',
    feedback: 'The writer checks the submitted claim against its active generation. Which returned claim matches that value at commit time?' };
  if (mentionsClaim) return { focus: 'claim',
    feedback: 'The writer has to compare the generation on the result with the generation on the active lease. Which values would your rule compare, and how would it identify the current owner?' };
}

function cameraFeedback(clauses: string[]): Feedback | undefined {
  const isoMotion = clauses.filter(clause => iso.test(clause) && motion.test(clause) && effect.test(clause) && !shutter.test(clause));
  const isoMistake = isoMotion.some(clause => !negation.test(clause) && !uncertainty.test(clause)
    && !/\b(?:same|unchanged|still|without)\b/.test(clause));
  const isoSeparate = isoMotion.some(clause => /\b(?:does not|doesn't|cannot|can't|never) (?:affect|control|change|reduce|shorten|freeze|stop)\b/.test(clause)
    || unchangedMotion.test(clause));
  const shutterEffects = clauses.filter(clause => shutter.test(clause) && motion.test(clause)
    && !iso.test(clause) && !negation.test(clause) && !uncertainty.test(clause));
  const wrongDirection = shutterEffects.some(clause =>
    (shorter.test(clause) && moreBlur.test(clause)) || (longer.test(clause) && lessBlur.test(clause)));
  const shutterMotion = shutterEffects.some(clause => effect.test(clause)
    || (shorter.test(clause) && lessBlur.test(clause)) || (longer.test(clause) && moreBlur.test(clause)));
  const isoBrightness = clauses.some(clause => iso.test(clause) && brightness.test(clause)
    && (effect.test(clause) || /\b(?:raise|raising|lower|lowering|increase|decrease|for)\b/.test(clause))
    && (!motion.test(clause) || unchangedMotion.test(clause)) && !negation.test(clause) && !uncertainty.test(clause));
  if (isoMistake) {
    if (isoSeparate) return;
    return { focus: 'iso',
      feedback: 'ISO changes displayed brightness. Shortening the shutter time is what limits the distance the rider moves during exposure.' };
  }
  if (wrongDirection) return { focus: 'shutter',
    feedback: 'At the same subject speed, a shorter exposure records a shorter motion trail. A longer exposure gives the subject more time to move.' };
  if (shutterMotion || isoSeparate || isoBrightness) return { focus: 'shutter',
    feedback: 'Shutter duration controls how much movement appears. ISO changes the rendered brightness at a fixed shutter time.' };
}

export function reasoningFeedback(id: string, reasoning: string, detail: string, mechanics: string): Feedback {
  assert.ok(id && mechanics.trim() && detail.trim(), 'feedback requires a demo concept and its teaching material');
  assert.ok(reasoning.trim(), 'only a nonblank reason needs feedback');
  const text = reasoning.trim().toLowerCase().replaceAll('’', "'").replace(/\s+/g, ' ');
  if (id === 'lease') return leaseFeedback(text.split(/[.!]+/))
    ?? { feedback: 'Which claim would your rule allow the writer to accept, and how would it identify the current owner?' };
  const clauses = text.split(/[.!?;,:]|\b(?:but|because|since|whereas|and)\b/).filter(clause => clause.trim());
  if (id === 'exposure' || id === 'iso' || id === 'shutter') return cameraFeedback(clauses)
    ?? { feedback: 'Which camera setting does your explanation change, and what would happen to the motion trail?' };
  if ([mechanics, detail].some(rule => rule.toLowerCase().replace(/[.!?]+$/, '') === text.replace(/[.!?]+$/, ''))) {
    return { feedback: 'You identified the rule that governs the scenario. ' + detail };
  }
  return { feedback: 'Which fact in this case supports your choice, and what would change if that fact were different?' };
}
