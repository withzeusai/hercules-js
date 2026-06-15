// Canonical Convex `tokenIdentifier` parser, shared by the component-side
// authorization paths (effective.ts, checks.ts, queries.ts).
//
// Convex composes a verified identity's `tokenIdentifier` as `${issuer}|${subject}`.
// This split is security-load-bearing: the evaluator resolves a caller to a
// principal by `subject` and fences on `issuer`, so every consumer MUST agree on
// the exact parse. Keep it in one place so the issuer/subject boundary cannot
// drift between call sites.
export function parseTokenIdentifier(tokenIdentifier: string) {
  const separatorIndex = tokenIdentifier.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === tokenIdentifier.length - 1) {
    return null;
  }
  return {
    issuer: tokenIdentifier.slice(0, separatorIndex),
    subject: tokenIdentifier.slice(separatorIndex + 1),
  };
}
