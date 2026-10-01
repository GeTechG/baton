import { test } from 'node:test'; import assert from 'node:assert';
import { hello } from '../src/a.js'; import { bye } from '../src/b.js';
test('hello', () => assert.strictEqual(hello('x'), 'hello x'));
test('bye', () => assert.strictEqual(bye('x'), 'bye x'));
