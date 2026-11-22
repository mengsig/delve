import assert from 'node:assert/strict';

type Feedback = { focus?: 'arrival' | 'claim' | 'iso' | 'shutter'; feedback: string };

const arrival = /\b(?:(?:arrival|completion) order|(?:the )?first (?:one|result|worker|write|writer|to (?:finish|report|arrive))|who(?:ever)? (?:arrives|reports|finishes) first|(?:arriv(?:e[ds]?|ing)|finish(?:ed|es|ing)?|report(?:ed|s|ing)?|got back) first)\b/;
const ownership = /\b(?:(?:current|active|valid|newer|latest|updated|stale|expired) (?:lease|claim|generation|token)|(?:lease|claim|generation|token) (?:(?:is|was|has) )?(?:already )?(?:current|active|valid|stale|expired|does not match)|(?:generation|claim number|token) (?:must match|has to match|matches|decides))\b/;
const claimComparison = /\b(?:compare|match|check|verify)(?:s|ed|ing)?\b[^.!?;]*\b(?:generation|claim|lease|ownership|token)\b/;
const arrivalDecision = /\b(?:matters?|mattered|decides?|wins?|won|gets? (?:accepted|saved|committed)|should be (?:accepted|saved|committed)|is what counts|determines?|pick(?:ed)?|chos[eo]|go with|went with|should get|take)\b/;
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

function leaseFeedback(clauses: string[]): Feedback | undefined {
  const order = clauses.filter(clause => arrival.test(clause) && arrivalDecision.test(clause));
  const favorsOrder = order.some(clause => !negation.test(clause) && !uncertainty.test(clause));
  const rejectsOrder = order.some(clause =>
    /\b(?:does not|doesn't|never|cannot|can't|does not always) (?:matter|decide|win|determine)\b/.test(clause));
  const claim = clauses.some(clause => {
    if (uncertainty.test(clause)) return false;
    if (/\b(?:generation|claim) (?:does not|doesn't) match\b/.test(clause)) return true;
    return !negation.test(clause) && (ownership.test(clause) || claimComparison.test(clause));
  });
  if (favorsOrder) {
    if (claim || rejectsOrder) return;
    return { focus: 'arrival', feedback: 'You looked at arrival order. Even the first result can carry an expired claim. Compare it with the active generation.' };
  }
  if (claim && (order.length === 0 || rejectsOrder)) return { focus: 'claim',
    feedback: 'Your reasoning uses the claim and its active generation to identify the owner. That comparison is what protects the write.' };
  if (rejectsOrder) return { focus: 'claim',
    feedback: 'Right that arrival order alone cannot decide. The writer needs to match the submitted claim with the active generation.' };
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
  const clauses = text.split(/[.!?;,:]|\b(?:but|because|since|whereas|and)\b/).filter(clause => clause.trim());
  if (id === 'lease') return leaseFeedback(clauses)
    ?? { feedback: 'Which claim would your rule allow the writer to accept, and how would it identify the current owner?' };
  if (id === 'exposure' || id === 'iso' || id === 'shutter') return cameraFeedback(clauses)
    ?? { feedback: 'Which camera setting does your explanation change, and what would happen to the motion trail?' };
  if ([mechanics, detail].some(rule => rule.toLowerCase().replace(/[.!?]+$/, '') === text.replace(/[.!?]+$/, ''))) {
    return { feedback: 'You identified the rule that governs the scenario. ' + detail };
  }
  return { feedback: 'Which fact in this case supports your choice, and what would change if that fact were different?' };
}
