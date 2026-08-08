// The gate's sticky PR comment: a human-readable report plus a hidden verdict
// cache.
//
// Why a comment at all: the job summary lives in the Actions tab, where PR
// authors don't look. A red check whose reason requires three clicks to find
// reads as flaky CI, and gets bypassed rather than answered.
//
// Why a cache: verification is a model call, and model calls are not
// deterministic. Without memory, every re-run re-judges every open blocker —
// paying again each time and occasionally flipping a verdict, which makes the
// gate flap between red and green with no code change. Verdicts are therefore
// sticky per finding fingerprint: judged once, reused until the thread is
// resolved.
//
// The cache payload is base64-encoded because verdict reasons are model prose —
// a literal "-->" inside one would end the HTML comment and dump JSON into the
// visible report.

export const REPORT_MARKER = "<!-- preason:gate-report -->";

const CACHE_RE = /<!-- preason:verdicts ([A-Za-z0-9+/=]+) -->/;

export function renderVerdictCache(verdicts) {
  const payload = Buffer.from(JSON.stringify(verdicts), "utf8").toString("base64");
  return `<!-- preason:verdicts ${payload} -->`;
}

export function parseVerdictCache(body) {
  const m = String(body || "").match(CACHE_RE);
  if (!m) return {};
  try {
    const parsed = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function buildGateComment(reportText, verdicts) {
  return [REPORT_MARKER, reportText, "", renderVerdictCache(verdicts)].join("\n");
}

export function isGateComment(body) {
  return String(body || "").includes(REPORT_MARKER);
}
