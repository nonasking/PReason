// Pure candidate ranking for reviewer assignment.
//
// The criteria come from reviewers.criteria.rank and are applied in order:
//   load       — fewer open review requests first (ascending)
//   expertise  — more recent commits to the changed files first (descending)
// Remaining ties break on login, so re-running the workflow never reshuffles
// the pick.

import { normalizeLogin } from "./conventions.mjs";

const DIRECTION = { load: 1, expertise: -1 };

export function rankCandidates(candidates, rank, { expertise = new Map(), load = new Map() } = {}) {
  const scoreOf = (key, login) =>
    (key === "load" ? load : expertise).get(normalizeLogin(login)) || 0;

  return [...candidates].sort((a, b) => {
    for (const key of rank) {
      const diff = (scoreOf(key, a) - scoreOf(key, b)) * DIRECTION[key];
      if (diff !== 0) return diff;
    }
    return normalizeLogin(a).localeCompare(normalizeLogin(b));
  });
}
