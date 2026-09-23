import assert from "node:assert/strict";
import { inspectWorkflowText } from "./Check-WorkflowSecurity.mjs";

const fixtures = [
  {
    name: "pull_request_target sequence syntax",
    yaml: `on: [pull_request_target]\njobs: { test: { runs-on: ubuntu-latest, steps: [] } }`,
    contains: "pull_request_target"
  },
  {
    name: "quoted write-all",
    yaml: `on: push\npermissions: "write-all"\njobs: { test: { runs-on: ubuntu-latest, steps: [] } }`,
    contains: "write-all"
  },
  {
    name: "aliased mutable action",
    yaml: `on: push\nx-ref: &ref actions/checkout@main\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: *ref\n`,
    contains: "immutable"
  },
  {
    name: "author association in expression value",
    yaml: `on: pull_request\njobs:\n  test:\n    if: \${{ github.event.pull_request.author_association == 'MEMBER' }}\n    runs-on: ubuntu-latest\n    steps: []\n`,
    contains: "author_association"
  },
  {
    name: "reusable workflow inherits every caller secret",
    yaml: `on: push\njobs:\n  deploy:\n    uses: owner/repository/.github/workflows/deploy.yml@0123456789012345678901234567890123456789\n    secrets: inherit\n`,
    contains: "secrets: inherit"
  },
  {
    name: "unpinned container action",
    yaml: `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker://alpine:latest\n`,
    contains: "sha256 digest"
  },
  {
    name: "mutable reusable workflow ref",
    yaml: `on: push\njobs:\n  deploy:\n    uses: owner/repository/.github/workflows/deploy.yml@main\n`,
    contains: "immutable"
  },
  {
    name: "author association in mapping key",
    yaml: `on: pull_request\nauthor_association: MEMBER\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n`,
    contains: "author_association"
  }
];

for (const fixture of fixtures) {
  const violations = inspectWorkflowText(fixture.yaml);
  assert.ok(
    violations.some((value) => value.includes(fixture.contains)),
    `${fixture.name} was not rejected: ${JSON.stringify(violations)}`
  );
}

const malformedFixtures = [
  {
    name: "duplicate permission key",
    yaml: `on: push\npermissions:\n  contents: read\n  contents: write\njobs: { test: { runs-on: ubuntu-latest, steps: [] } }`,
    contains: "invalid YAML"
  },
  {
    name: "alias expansion bomb",
    yaml: `a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]\non: push\njobs: { test: { runs-on: ubuntu-latest, steps: [] } }`,
    contains: "unsafe/unresolvable YAML aliases"
  }
];

for (const fixture of malformedFixtures) {
  const violations = inspectWorkflowText(fixture.yaml);
  assert.ok(
    violations.some((value) => value.includes(fixture.contains)),
    `${fixture.name} was not rejected: ${JSON.stringify(violations)}`
  );
}

const safe = inspectWorkflowText(`on: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n`);
assert.deepEqual(safe, []);
console.log("GitHub Actions security policy adversarial fixtures: PASS");
