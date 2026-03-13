// metro.config.js — Monorepo-aware Metro configuration
// Ensures Metro can resolve hoisted node_modules from the workspace root.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Only watch this package's source — not the entire monorepo.
// The monorepo root is only needed for module resolution (hoisted node_modules).
config.watchFolders = [];

// Tell Metro where to find hoisted node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

module.exports = config;
