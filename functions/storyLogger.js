// functions/storyLogger.js
// Story system development console logger
// Provides detailed logging for development and debugging

const { logger } = require('firebase-functions');

/**
 * Story system logger with console output for development
 * Logs to both Firebase Functions logger and console for visibility
 */
class StoryLogger {
  constructor(prefix = '[Story]') {
    this.prefix = prefix;
  }

  info(message, data = {}) {
    const logMsg = `${this.prefix} ${message}`;
    console.log(logMsg, data);
    logger.info(logMsg, data);
  }

  warn(message, data = {}) {
    const logMsg = `${this.prefix} ${message}`;
    console.warn(logMsg, data);
    logger.warn(logMsg, data);
  }

  error(message, error = null, data = {}) {
    const logMsg = `${this.prefix} ${message}`;
    const errorInfo = error ? { error: String(error), stack: error?.stack } : {};
    console.error(logMsg, { ...data, ...errorInfo });
    logger.error(logMsg, { ...data, ...errorInfo });
  }

  debug(message, data = {}) {
    const logMsg = `${this.prefix} ${message}`;
    console.log(logMsg, data);
    logger.debug(logMsg, data);
  }

  // V2 specific loggers
  planCreated(planInfo) {
    this.info('✅ Story plan created successfully', {
      runId: planInfo.runId,
      totalNodes: planInfo.totalNodes,
      fieldNodes: planInfo.fieldNodes,
      nonFieldNodes: planInfo.nonFieldNodes,
      keyEvents: planInfo.keyEvents
    });
    console.table({
      'Run ID': planInfo.runId,
      'Total Nodes': planInfo.totalNodes,
      'Field Nodes': planInfo.fieldNodes,
      'Non-Field Nodes': planInfo.nonFieldNodes,
      'Key Events': planInfo.keyEvents
    });
  }

  rulesCreated(rulesInfo) {
    this.info('✅ Story rules created', rulesInfo);
    console.table({
      'Enemy Grades': rulesInfo.enemyGrades,
      'Drop Rarities': rulesInfo.dropRarities,
      'Difficulties': rulesInfo.difficulties
    });
  }

  fieldStatsCreated(stats) {
    this.info('✅ Field stats materialized', stats);
    console.table({
      'Total Stats Created': stats.count,
      'Fields': stats.fieldCount,
      'Grades per Field': stats.gradesPerField
    });
  }

  // V3 specific loggers
  monstersEnriched(enrichInfo) {
    this.info('✅ Monsters enriched by AI', enrichInfo);
    console.table(enrichInfo.byDifficulty || {});
  }

  shopsEnriched(shopInfo) {
    this.info('✅ Shops and drops enriched by AI', {
      nodeCount: shopInfo.nodeCount,
      dropLoreCount: shopInfo.dropLoreCount
    });
  }

  // Preroll logging
  prerollConsumed(rollInfo) {
    this.debug('🎲 Preroll consumed', rollInfo);
  }

  // NPC logging
  npcCreated(npcInfo) {
    this.info('👥 NPC group created', npcInfo);
  }

  // Connection logging
  connectionCreated(connInfo) {
    this.debug('🔗 Field connection created', connInfo);
  }
}

module.exports = { StoryLogger };
