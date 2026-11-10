import { describe, expect, it } from "vitest";
import { commandsInChunks } from "./sdk-commands-plugin.js";

const nm = "/repo/web/node_modules/@aws-sdk";

describe("SDK command detection", () => {
  it("lists command modules that rendered code, keyed by client and operation", () => {
    const found = commandsInChunks([
      {
        fileName: "assets/index-abc.js",
        modules: {
          [`${nm}/client-sts/dist-es/commands/GetCallerIdentityCommand.js`]: { renderedLength: 412 },
          [`${nm}/client-ec2/dist-es/commands/RunInstancesCommand.js`]: { renderedLength: 300 },
          [`${nm}/client-service-quotas/dist-es/commands/GetServiceQuotaCommand.js`]: { renderedLength: 280 },
          "/repo/web/portal/src/main.ts": { renderedLength: 900 },
        },
      },
      { fileName: "assets/lazy-def.js", modules: { [`${nm}/client-ec2/dist-es/commands/RunInstancesCommand.js`]: { renderedLength: 300 } } },
    ]);
    expect(found).toEqual([
      { command: "ec2:RunInstances", chunks: ["assets/index-abc.js", "assets/lazy-def.js"] },
      { command: "service-quotas:GetServiceQuota", chunks: ["assets/index-abc.js"] },
      { command: "sts:GetCallerIdentity", chunks: ["assets/index-abc.js"] },
    ]);
  });

  it("ignores command modules tree-shaken to nothing", () => {
    expect(commandsInChunks([{ fileName: "a.js", modules: { [`${nm}/client-ec2/dist-es/commands/TerminateInstancesCommand.js`]: { renderedLength: 0 } } }])).toEqual([]);
  });

  it("handles Windows paths and dist-cjs", () => {
    const found = commandsInChunks([{ fileName: "a.js", modules: { "C:\\repo\\node_modules\\@aws-sdk\\client-ssm\\dist-cjs\\commands\\StartSessionCommand.js": { renderedLength: 1 } } }]);
    expect(found.map((f) => f.command)).toEqual(["ssm:StartSession"]);
  });
});
