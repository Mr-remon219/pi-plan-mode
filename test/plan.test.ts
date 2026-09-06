import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProposedPlan } from '../src/state.ts';

test('strict block parser rejects nested, stray and fenced pseudo plans', () => {
  assert.throws(() => extractProposedPlan('<proposed_plan>\na\n<proposed_plan>\nb\n</proposed_plan>'));
  assert.throws(() => extractProposedPlan('<proposed_plan>\na\n</proposed_plan>\n</proposed_plan>'));
  assert.equal(extractProposedPlan('```xml\n<proposed_plan>\na\n</proposed_plan>\n```'), undefined);
  assert.equal(extractProposedPlan('<proposed_plan>\r\na\r\n</proposed_plan>'), 'a');
  assert.equal(extractProposedPlan('<proposed_plan>\na\n```xml\n</proposed_plan>\n```\nb\n</proposed_plan>'), 'a\n```xml\n</proposed_plan>\n```\nb');
});
