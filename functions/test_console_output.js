#!/usr/bin/env node
/**
 * Test script for Story System console output
 * 
 * This script demonstrates the console logging functionality
 * without requiring Firebase connection.
 * 
 * Usage: node test_console_output.js
 */

const { StoryLogger } = require('./storyLogger');

console.log('='.repeat(70));
console.log('Story System Console Output Test');
console.log('='.repeat(70));
console.log();

// Test V2 Logger
const logV2 = new StoryLogger('[StoryV2-Test]');

console.log('--- Testing V2 Plan Creation Log ---');
logV2.planCreated({
  runId: 'r1634567890',
  totalNodes: 15,
  fieldNodes: 10,
  nonFieldNodes: 5,
  keyEvents: 5
});
console.log();

console.log('--- Testing V2 Rules Creation Log ---');
logV2.rulesCreated({
  enemyGrades: 5,
  dropRarities: 7,
  difficulties: 6
});
console.log();

console.log('--- Testing V2 Field Stats Log ---');
logV2.fieldStatsCreated({
  count: 50,
  fieldCount: 10,
  gradesPerField: 5
});
console.log();

// Test V3 Logger
const logV3 = new StoryLogger('[StoryV3-Test]');

console.log('--- Testing V3 Monster Enrichment Log ---');
logV3.monstersEnriched({
  byDifficulty: ['easy', 'normal', 'hard', 'vhard', 'legend', 'impossible'],
  totalDifficulties: 6
});
console.log();

console.log('--- Testing V3 Shop Enrichment Log ---');
logV3.shopsEnriched({
  nodeCount: 5,
  dropLoreCount: 14
});
console.log();

// Test other log levels
console.log('--- Testing Other Log Levels ---');
logV2.info('This is an info message', { detail: 'Some additional info' });
logV2.warn('This is a warning message', { reason: 'Low memory' });
logV2.debug('This is a debug message', { variable: 42, array: [1, 2, 3] });
logV2.error('This is an error message', new Error('Test error'), { context: 'Testing' });
console.log();

console.log('--- Testing Preroll Log ---');
logV2.prerollConsumed({ roll: 73, cursor: 25, remaining: 25 });
console.log();

console.log('--- Testing NPC Creation Log ---');
logV2.npcCreated({
  nodeId: 'N1',
  npcCount: 7,
  groupAttitude: 'friendly'
});
console.log();

console.log('--- Testing Connection Log ---');
logV2.connectionCreated({
  from: 'N1',
  to: 'F1',
  description: '자연어 연결: N1→F1'
});
console.log();

console.log('='.repeat(70));
console.log('✅ All console output tests completed successfully!');
console.log('='.repeat(70));
