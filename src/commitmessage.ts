/**
 * Reading commit messages, kept apart from the collector that fetches them so
 * the rule can be tested without reaching GitHub — the same split `worktype.ts`
 * makes for labels and titles.
 */

/** GitHub's own wording for both merge strategies that leave a trace: a merge
 *  commit ("Merge pull request #12 from …") and a squash ("Fix the thing (#12)"). */
const MERGED_VIA_PULL_REQUEST = /^Merge pull request #\d+|\(#\d+\)\s*$/;

/**
 * Whether a commit on the default branch is already accounted for by a
 * `pr_merged` row, and so must not be counted a second time as pushed work.
 * More than one parent means the commit is the merge itself rather than
 * authored work.
 */
export function arrivedViaPullRequest(subject: string, parentCount: number): boolean {
  return parentCount > 1 || MERGED_VIA_PULL_REQUEST.test(subject);
}
