// @vitest-environment node
//
// The real e2e adapter (aws.ts) against a LOCAL capture server, never AWS:
// proves the run middleware really reaches the wire request spawn-ts's
// EC2Provider sends (run tags on the instance, its volumes and interfaces, the
// ClientToken, spawn:managed dropped for the control only) and that the cost
// guard stops a third launch before anything is sent.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TAG, RUN_TAG } from "./config.js";
import { e2eApi } from "./aws.js";
import { LaunchBudget } from "./run.js";

const NS = 'xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"';
const bodies: URLSearchParams[] = [];
let server: Server;
let endpoint = "";

function reply(action: string | null, n: number): string {
  switch (action) {
    case "DescribeImages":
      return `<DescribeImagesResponse ${NS}><requestId>r</requestId><imagesSet><item><imageId>ami-0e2e</imageId><creationDate>2026-11-01T00:00:00.000Z</creationDate></item></imagesSet></DescribeImagesResponse>`;
    case "RunInstances":
      return `<RunInstancesResponse ${NS}><requestId>r</requestId><reservationId>r-1</reservationId><instancesSet><item><instanceId>i-0e2e00000000000${n}</instanceId><instanceType>t4g.nano</instanceType><instanceState><code>0</code><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`;
    case "DescribeInstances":
      return `<DescribeInstancesResponse ${NS}><requestId>r</requestId><reservationSet/></DescribeInstancesResponse>`;
    default:
      return `<Response><Errors><Error><Code>Unsupported</Code><Message>${action}</Message></Error></Errors><RequestID>r</RequestID></Response>`;
  }
}

beforeAll(async () => {
  let runs = 0;
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const p = new URLSearchParams(data);
      bodies.push(p);
      const action = p.get("Action");
      if (action === "RunInstances") runs += 1;
      res.writeHead(action && ["DescribeImages", "RunInstances", "DescribeInstances"].includes(action) ? 200 : 400, { "content-type": "text/xml" });
      res.end(reply(action, runs));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** The tags of one TagSpecification in an EC2 Query body, by resource type. */
function tagSpec(p: URLSearchParams, type: string): Record<string, string> | null {
  for (let i = 1; p.has(`TagSpecification.${i}.ResourceType`); i++) {
    if (p.get(`TagSpecification.${i}.ResourceType`) !== type) continue;
    const out: Record<string, string> = {};
    for (let j = 1; p.has(`TagSpecification.${i}.Tag.${j}.Key`); j++) out[p.get(`TagSpecification.${i}.Tag.${j}.Key`)!] = p.get(`TagSpecification.${i}.Tag.${j}.Value`) ?? "";
    return out;
  }
  return null;
}

describe("e2e adapter: the run middleware on spawn-ts's own EC2 client", () => {
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-secret", sessionToken: "t" };

  it("sends the portal's launch with the run tags, a ClientToken and the instance profile", async () => {
    bodies.length = 0;
    const budget = new LaunchBudget();
    const api = e2eApi(creds, "r1abc", { budget, endpoint });
    const managed = await api.launch("managed");
    const control = await api.launch("control");
    expect([managed, control]).toEqual(["i-0e2e000000000001", "i-0e2e000000000002"]);

    const runs = bodies.filter((b) => b.get("Action") === "RunInstances");
    expect(runs).toHaveLength(2);
    const [m, c] = runs;
    expect(m.get("InstanceType")).toBe("t4g.nano");
    expect(m.get("IamInstanceProfile.Name")).toBe("spored-instance-profile");
    expect(m.get("ClientToken")).toBe("spore-e2e-r1abc-1");
    expect(c.get("ClientToken")).toBe("spore-e2e-r1abc-2");
    expect(m.get("InstanceInitiatedShutdownBehavior")).toBe("terminate");
    expect(m.has("InstanceMarketOptions.MarketType")).toBe(false);

    const mt = tagSpec(m, "instance")!;
    expect(mt).toMatchObject({ "spawn:managed": "true", "spawn:ttl": "15m", [RUN_TAG]: "r1abc", [ROLE_TAG]: "managed", Name: "spore-e2e-r1abc-managed" });
    expect(mt["spawn:dns-name"]).toBeUndefined(); // DNS off: no spore.host record outside the leak check
    expect(tagSpec(m, "volume")).toEqual({ [RUN_TAG]: "r1abc", [ROLE_TAG]: "managed" });
    expect(tagSpec(m, "network-interface")).toEqual({ [RUN_TAG]: "r1abc", [ROLE_TAG]: "managed" });

    const ct = tagSpec(c, "instance")!;
    expect(ct["spawn:managed"]).toBeUndefined();
    expect(ct).toMatchObject({ "spawn:ttl": "15m", [RUN_TAG]: "r1abc", [ROLE_TAG]: "control" });
    expect(budget.count).toBe(2);
  });

  it("refuses a third launch before sending it", async () => {
    bodies.length = 0;
    const api = e2eApi(creds, "r2abc", { budget: new LaunchBudget(), endpoint });
    await api.launch("managed");
    await api.launch("control");
    await expect(api.launch("managed")).rejects.toThrow(/cost guard: this run has already launched 2 instance\(s\), the cap is 2/);
    expect(bodies.filter((b) => b.get("Action") === "RunInstances")).toHaveLength(2);
  });
});
