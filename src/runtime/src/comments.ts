/**
 * Linear comment templates. eval-recovery matches on these prefixes to
 * reconstruct outcomes after a dropped connection — change them ONLY here,
 * never inline, or recovery silently breaks.
 */
export const COMMENT_PREFIX = {
  prReady: "**Agent: PR ready for review.**",
  blocked: "**Agent: not picking this up yet.**",
  securityBlocked: "**Agent: not picking this up — human security review needed.**",
  failed: "**Agent: pipeline failed.**",
} as const;
