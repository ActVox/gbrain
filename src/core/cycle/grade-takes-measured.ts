/**
 * What the W6 take-grading eval measured (evals/take-grading/; verdicts in
 * gbrain-evals).
 *
 * `GRADE_TAKES_MEASURED_MODELS`: the judge models that met the preregistered
 * rule on the counted split (evals/take-grading/PREREGISTRATION.md): among
 * verdicts the auto-resolve rule would apply (not `unresolvable`, confidence
 * at or above `GRADE_TAKES_AUTO_RESOLVE_THRESHOLD`), the one-sided 95% upper
 * bound on the wrong share is at most 1%. Empty until the counted run.
 *
 * Nothing auto-resolves today: the cycle runs grade_takes with auto-resolve
 * off. `gbrain takes grades` marks each cached verdict whose judge is not on
 * this list, so a reviewer knows which verdicts no measurement backs.
 */
import { splitProviderModelId } from '../model-id.ts';

export const GRADE_TAKES_MEASURED_MODELS: readonly string[] = [];

/** True when a stored `judge_model_id` (a bare model id, as grade_takes stores it) is on the measured list. */
export function gradeJudgeMeasured(judgeModelId: string): boolean {
  const bare = splitProviderModelId(judgeModelId).model || judgeModelId;
  return GRADE_TAKES_MEASURED_MODELS.some(m => (splitProviderModelId(m).model || m) === bare);
}
