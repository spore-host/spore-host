// IAM coverage gate, step 1: which AWS SDK commands survive in the bundle.
//
// A Rollup/Vite plugin. After tree-shaking, every module that rendered code
// into an output chunk is listed in chunk.modules with its renderedLength.
// AWS SDK v3 puts each command in its own module,
// @aws-sdk/client-<service>/dist-es/commands/<Name>Command.js, so the commands
// the shipped portal can send are exactly the command modules that rendered
// any code. That is a property of the built artefact, not of the source: an
// import that tree-shakes away is not counted, and an aggregated client
// (`new EC2()`), which keeps every command, shows up as hundreds of commands
// and fails the closed table, which is the right outcome.
//
// The report is written OUTSIDE the build output, so it can never be deployed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Plugin } from "vite";

const COMMAND_MODULE = /[\\/]@aws-sdk[\\/]client-([a-z0-9-]+)[\\/]dist-(?:es|cjs)[\\/]commands[\\/]([A-Za-z0-9]+)Command\.js$/;

export interface SdkCommand {
  /** "<client package suffix>:<Operation>", e.g. "sts:GetCallerIdentity". */
  command: string;
  /** Output chunks it was rendered into. */
  chunks: string[];
}

export interface RenderedModuleInfo {
  renderedLength: number;
}

/** Pure: find command modules with rendered code in a set of chunks. */
export function commandsInChunks(chunks: { fileName: string; modules: Record<string, RenderedModuleInfo> }[]): SdkCommand[] {
  const found = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    for (const [id, info] of Object.entries(chunk.modules)) {
      if (info.renderedLength <= 0) continue;
      const m = id.match(COMMAND_MODULE);
      if (!m) continue;
      const key = `${m[1]}:${m[2]}`;
      if (!found.has(key)) found.set(key, new Set());
      found.get(key)!.add(chunk.fileName);
    }
  }
  return [...found.entries()].map(([command, c]) => ({ command, chunks: [...c].sort() })).sort((a, b) => a.command.localeCompare(b.command));
}

export function sdkCommandsPlugin(opts: { reportFile: string }): Plugin {
  return {
    name: "spore-portal-sdk-commands",
    apply: "build",
    generateBundle(_out, bundle) {
      const chunks = Object.values(bundle).flatMap((o) => (o.type === "chunk" ? [{ fileName: o.fileName, modules: o.modules }] : []));
      const commands = commandsInChunks(chunks);
      mkdirSync(dirname(opts.reportFile), { recursive: true });
      writeFileSync(opts.reportFile, `${JSON.stringify({ commands }, null, 2)}\n`);
    },
  };
}
