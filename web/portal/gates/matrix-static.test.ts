// Gate: the CLI⇄GUI matrix, static half. The matrix is well formed, every
// row's command and flags exist in the generated CLI reference (docs/gen,
// synced from the shipped binaries), and every basic row either names GUI
// controls or is pending on its slice. e2e/matrix.spec.ts checks the rendered
// controls against it. Includes deliberately broken matrices to prove it fails.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cliProblems, renderedProblems, structuralProblems, type DocReader, type Matrix } from "../parity/matrix.js";

const matrix = JSON.parse(readFileSync(resolve(import.meta.dirname, "../parity/cli-gui-matrix.json"), "utf8")) as Matrix;
const gen = resolve(import.meta.dirname, "../../../docs/gen");
const read: DocReader = (cli, file) => {
  const p = resolve(gen, cli, `${file}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

function clone(): Matrix {
  return JSON.parse(JSON.stringify(matrix)) as Matrix;
}

describe("CLI⇄GUI matrix gate (static)", () => {
  it("is well formed", () => {
    expect(structuralProblems(matrix)).toEqual([]);
  });

  it("names only commands and flags the CLIs really have", () => {
    expect(cliProblems(matrix, read)).toEqual([]);
  });

  it("covers the basic commands of all three CLIs", () => {
    const cmds = new Set(matrix.rows.filter((r) => r.level === "basic").map((r) => r.cli));
    for (const c of ["spawn launch", "spawn list", "spawn status", "spawn connect", "spawn extend", "spawn stop", "spawn start", "spawn terminate", "spawn cost", "truffle find", "truffle spot", "truffle quotas", "truffle available", "lagotto watch", "lagotto list", "lagotto status", "lagotto ack", "lagotto cancel", "lagotto history"]) {
      expect(cmds.has(c), c).toBe(true);
    }
  });

  it("fails a basic row with no GUI control that is not pending", () => {
    const m = clone();
    const row = m.rows.find((r) => r.id === "spawn-extend")!;
    row.gui = [];
    delete row.pending;
    expect(structuralProblems(m)).toContain('basic row "spawn-extend" (spawn extend) has no GUI control and is not pending on a slice');
  });

  it("fails a pending row on an issue that is not a slice", () => {
    const m = clone();
    m.rows[0].pending = 999;
    expect(structuralProblems(m)[0]).toMatch(/pending 999 is not a slice issue/);
  });

  it("fails a control mapped to two commands", () => {
    const m = clone();
    m.rows.find((r) => r.id === "spawn-stop")!.gui.push("instance.terminate");
    expect(structuralProblems(m)).toContain('control "instance.terminate" is in rows "spawn-stop" and "spawn-terminate"; one control maps to one command');
  });

  it("fails a command or flag the CLI does not have", () => {
    const m = clone();
    m.rows.push({ id: "bogus", cli: "spawn reboot", level: "basic", gui: [], pending: 686 });
    m.rows.find((r) => r.id === "spawn-launch-ttl")!.flags = ["--lifetime"];
    const problems = cliProblems(m, read);
    expect(problems).toContain('row "bogus": no generated reference for "spawn reboot" (docs/gen/spawn/reboot.md)');
    expect(problems).toContain('row "spawn-launch-ttl": "spawn launch" has no flag --lifetime');
  });

  it("fails a rendered control with no CLI row, and an element with no control id", () => {
    const observed = new Map([["instance.reboot", ["#/instances"]]]);
    expect(renderedProblems(matrix, observed, ["button \"Reboot\""])).toEqual([
      'interactive element with no data-control: button "Reboot"',
      'GUI control "instance.reboot" (on #/instances) has no CLI row and is not chrome',
    ]);
  });

  it("fails a shipped basic row whose control no route renders", () => {
    const m = clone();
    delete m.rows.find((r) => r.id === "spawn-list")!.pending;
    expect(renderedProblems(m, new Map())).toContain('basic row "spawn-list" (spawn list) names controls no route renders: nav.instances');
    expect(renderedProblems(m, new Map([["nav.instances", ["#/instances"]]]))).toEqual([]);
  });
});
