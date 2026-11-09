// Build-time feature flags for the no-build marketing pages, mirroring
// app/features.ts for the portal. A page marks a flagged block with
//
//   <!-- experimental:chat -->  …  <!-- /experimental:chat -->
//
// and copy-static.mjs keeps the block only when VITE_EXPERIMENTAL_CHAT is
// exactly "true" (read through Vite's loadEnv, so .env files and the process
// environment both count, as they do for the portal). Off by default: chat
// integrations are walled off for 1.0 (spore-host#611).

/** Flags a page may use, and the env var that turns each on. */
export const FLAGS = { chat: "VITE_EXPERIMENTAL_CHAT" };

/**
 * Apply the flags to one page's HTML. Disabled blocks are removed; enabled ones
 * keep their content and lose only the marker comments. Throws on an unknown
 * flag, a nested block or an unbalanced marker, so a typo can never ship a
 * block that should have been hidden.
 */
export function applyStaticFlags(html, env, page = "page") {
  const marker = /<!--\s*(\/?)experimental:([a-z-]+)\s*-->/g;
  let out = "";
  let last = 0;
  let open = null; // { flag, start, keep }
  for (const m of html.matchAll(marker)) {
    const [text, closing, flag] = m;
    if (!(flag in FLAGS)) throw new Error(`${page}: unknown flag experimental:${flag}`);
    if (!closing) {
      if (open) throw new Error(`${page}: experimental:${flag} opened inside experimental:${open.flag}`);
      out += html.slice(last, m.index);
      open = { flag, keep: env[FLAGS[flag]] === "true" };
    } else {
      if (!open || open.flag !== flag) throw new Error(`${page}: unmatched /experimental:${flag}`);
      if (open.keep) out += html.slice(last, m.index);
      open = null;
    }
    last = m.index + text.length;
  }
  if (open) throw new Error(`${page}: experimental:${open.flag} is never closed`);
  return out + html.slice(last);
}
