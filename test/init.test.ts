import assert from "node:assert/strict";
import test from "node:test";
import { gridPlan, harnessPanes, switchboardLayout, upsertZshBlock, zshLauncher } from "../src/init.ts";

test("the grid layout opens every harness in the repo", () => {
  const layout = switchboardLayout("/Users/ishprasad/Switchboard");
  assert.match(layout, /tab name="switchboard" cwd="\/Users\/ishprasad\/Switchboard"/);
  for (const name of ["Orchestrator", "Grok", "Claude", "Codex", "Kimi", "Muse", "Antigravity", "Bus"]) {
    assert.match(layout, new RegExp(`pane name="${name}"`));
  }
  assert.doesNotMatch(layout, /pane name="Cursor"/);
  assert.match(layout, /pane name="Orchestrator" command="\/Users\/ishprasad\/\.local\/bin\/cursor-agent"/);
  assert.match(layout, /split_direction="horizontal"/);
  assert.doesNotMatch(layout, /--continue/);
  assert.match(layout, /args "--yolo" "--approve-mcps" "--trust"/);
  assert.match(layout, /args "--yolo"/);
  assert.match(layout, /args "--dangerously-skip-permissions" "--mode" "auto"/);
});

test("resume layout continues the latest session of each harness", () => {
  const layout = switchboardLayout("/Users/ishprasad/Switchboard", harnessPanes(true));
  assert.match(layout, /args "--always-approve" "--model" "grok-4.7" "--reasoning-effort" "xhigh" "--continue"/);
  assert.match(layout, /args "--dangerously-bypass-approvals-and-sandbox" "--model" "gpt-6.1-sol" "resume" "--last"/);
  assert.match(layout, /args "--yolo" "--approve-mcps" "--trust" "--continue"/);
  assert.match(layout, /args "--yolo" "--continue"/);
  assert.match(layout, /args "--dangerously-skip-permissions" "--mode" "auto" "--continue"/);
});

test("an open grid is attached, and a dead one is replaced by the resume layout", () => {
  const dir = "/Users/ishprasad/.config/zellij/layouts";
  assert.deepEqual(gridPlan(true, "switchboard [Created 1m ago]", dir), {
    action: "attach",
    session: "switchboard",
  });
  assert.deepEqual(gridPlan(true, "switchboard [Created 1m ago] (EXITED - attach to resurrect)", dir), {
    action: "start",
    session: "switchboard",
    layout: "/Users/ishprasad/.config/zellij/layouts/switchboard-resume.kdl",
    deleteFirst: true,
  });
  assert.deepEqual(gridPlan(false, null, dir), {
    action: "start",
    session: "switchboard",
    layout: "/Users/ishprasad/.config/zellij/layouts/switchboard.kdl",
    deleteFirst: false,
  });
});

test("the zshrc block is replaced instead of duplicated", () => {
  const body = zshLauncher("/Users/ishprasad/Switchboard/dist/cli.js");
  const first = upsertZshBlock("export PATH=old\n", body);
  const second = upsertZshBlock(first, body);
  assert.equal(second, first);
  assert.equal(second.match(/# >>> switchboard >>>/g)?.length, 1);
  assert.match(second, /command node '\/Users\/ishprasad\/Switchboard\/dist\/cli.js'/);
  assert.match(second, /switchboard-resume\.kdl/);
  assert.match(second, /\$1 == --resume/);
  assert.match(second, /^export PATH=old\n/);
});
