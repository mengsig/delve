# Guided lesson mastery

A guided lesson explains the concept and asks the learner to predict an outcome or choose an action
in a scenario with four choices. Learners can ask for an explanation, example, or diagram while
a check is active. Asking keeps the current check and its revision.

| Depth | Consecutive correct answers | Attempts per round |
| --- | ---: | ---: |
| High | 2 | 4 |
| Medium | 2 | 5 |
| Low | 3 | 6 |

At least one correct answer in the streak must apply the concept to a specific situation. Delve
grades the selected choice locally against its saved key. Learners can submit up to 4,000 characters
of optional reasoning. The tutor explains the choice, addresses the reasoning when present, and uses
it to pick a fresh scenario when another check is due. A correct choice earns credit even when the
explanation needs correction. A miss resets the streak and its application pass. Conversation and
instrument practice can guide teaching without changing the check's grade or progress.

When the budget runs out, the learner can review or skip. Review resets the attempt budget and starts
with a fresh scenario. Learners can also review an understood or skipped lesson. Skip pauses practice
without awarding mastery.

The exact provider preview includes the selected answer, reasoning, trusted verdict and answer
reference. Approval binds these values to the active check revision. Delve saves the learner's words,
tutor feedback, next check, progress and evidence in one transaction. Cancellation, failed feedback
and stale submissions leave the saved progress intact. Reset invalidates previous approvals.

Saved `delve.lesson/1` lessons, transcripts, grades and inherited mastery remain readable at their
original scope. Saved checks with two to four choices retain their wording and order. A saved written
check or a check with more than four choices gets a replacement at the same depth. Preparing that
replacement uses the regular provider preview and approval flow, or the local demo. A successful
replacement updates only the active check and its revision. If preparation fails, the original
lesson stays readable and the learner can retry. A separate generation cache version keeps legacy
checks available for reading while fresh generation uses the current format.
