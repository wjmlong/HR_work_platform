import test from "node:test";
import assert from "node:assert/strict";
import { DialogStack } from "../src/lib/dialog.ts";
const modal = () => ({
  open: false,
  isConnected: true,
  showModal() {
    this.open = true;
  },
  close() {
    this.open = false;
  },
});
test("shared modal container displays only the current dialog and restores its parent after cancel", () => {
  const stack = new DialogStack(),
    parent = modal(),
    child = modal();
  const parentClose = stack.activate(parent);
  assert.equal(parent.open, true);
  const childClose = stack.activate(child);
  assert.equal(parent.open, false);
  assert.equal(child.open, true);
  childClose();
  assert.equal(child.open, false);
  assert.equal(parent.open, true);
  childClose();
  assert.equal(parent.open, true);
  parentClose();
  assert.equal(parent.open, false);
});
test("closing an older modal cannot hide the active dialog or restore a disconnected node", () => {
  const stack = new DialogStack(),
    parent = modal(),
    child = modal(),
    release = stack.activate(parent),
    releaseChild = stack.activate(child);
  parent.isConnected = false;
  release();
  assert.equal(child.open, true);
  releaseChild();
  assert.equal(parent.open, false);
  assert.equal(child.open, false);
});
