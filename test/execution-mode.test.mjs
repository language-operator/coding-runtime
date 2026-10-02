import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executionMode, taskCommand } from '../src/cli.mjs';

test('only "task" means task; everything else is a service', () => {
  // The variable is the only signal the container gets, and an unset value has
  // to mean service: operators predating it do not inject it, and a service pod
  // started before an operator upgrade keeps its old environment. Getting this
  // backwards would exit every long-running agent the moment it started.
  assert.equal(executionMode({}), 'service', 'unset is the pre-upgrade case');
  assert.equal(executionMode({ AGENT_EXECUTION_MODE: '' }), 'service');
  assert.equal(executionMode({ AGENT_EXECUTION_MODE: '   ' }), 'service');
  assert.equal(executionMode({ AGENT_EXECUTION_MODE: 'service' }), 'service');
  assert.equal(executionMode({ AGENT_EXECUTION_MODE: 'batch' }), 'service', 'an unknown mode must not exit early');

  assert.equal(executionMode({ AGENT_EXECUTION_MODE: 'task' }), 'task');
  assert.equal(executionMode({ AGENT_EXECUTION_MODE: 'TASK' }), 'task');
  assert.equal(executionMode({ AGENT_EXECUTION_MODE: ' task\n' }), 'task', 'a trailing newline is not a different mode');
});

test('this rule matches deepagents-adapter, so the two runtimes agree', () => {
  // agent_config.execution_mode(): os.environ.get(...).strip().lower() == "task"
  // Same inputs, same answers — a value that means task in one runtime must not
  // mean service in the other.
  for (const raw of ['task', 'TASK', ' Task ', 'service', '', 'taskish', 'tasks']) {
    const python = raw.trim().toLowerCase() === 'task' ? 'task' : 'service';
    assert.equal(executionMode({ AGENT_EXECUTION_MODE: raw }), python, `disagreement on ${JSON.stringify(raw)}`);
  }
});

const terminal = { name: 'x', serve: { surface: 'terminal' }, terminal: { launch: ['launch-x'] } };

test('a terminal adapter supplies its task command explicitly', () => {
  assert.equal(taskCommand(terminal), null, 'terminal.launch is a TUI and must never be used as the task command');
  assert.deepEqual(taskCommand({ ...terminal, task: { exec: ['launch-x-task'] } }), ['launch-x-task']);
});

test('surface none falls back to serve.exec, which already exits on its own', () => {
  const none = { name: 'y', serve: { surface: 'none', exec: ['python', 'server.py'] } };
  assert.deepEqual(taskCommand(none), ['python', 'server.py']);

  // An explicit task.exec still wins: the agent's own process may need
  // different arguments for a one-shot run.
  assert.deepEqual(taskCommand({ ...none, task: { exec: ['python', 'once.py'] } }), ['python', 'once.py']);
});

test('an unusable command reads as absent rather than being spawned', () => {
  // These shapes are refused by validateManifest, but serve must not depend on
  // validation having run: a hand-edited manifest reaching spawn() with no
  // argv[0] fails inside the container, where nobody is watching.
  for (const task of [{ exec: [] }, { exec: 'launch' }, { exec: [7] }, {}]) {
    assert.equal(taskCommand({ ...terminal, task }), null, JSON.stringify(task));
  }
  assert.equal(taskCommand({ name: 'z', serve: { surface: 'none' } }), null, 'surface none without exec has nothing to run');
  assert.equal(taskCommand({ name: 'z' }), null, 'a manifest with no serve block at all');
});
