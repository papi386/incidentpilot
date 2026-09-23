import assert from "node:assert/strict";
import test from "node:test";
import { total } from "../src/total.js";

test("adds all invoice values", () => {
  assert.equal(total([10, 20, 12]), 42);
});
