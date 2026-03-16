// metro.config.js — Monorepo-aware Metro configuration
// Ensures Metro can resolve hoisted node_modules from the workspace root.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Fix monorepo hoisting: when expo is hoisted to root node_modules,
// expo/AppEntry.js does `import App from '../../App'` which resolves
// relative to root node_modules/expo/ instead of packages/mobile-app/.
// Intercept that import and redirect to our actual App.tsx.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Catch expo/AppEntry trying to import ../../App
  if (
    moduleName === '../../App' &&
    context.originModulePath &&
    context.originModulePath.includes(path.join('expo', 'AppEntry'))
  ) {
    return { type: 'sourceFile', filePath: path.resolve(projectRoot, 'App.tsx') };
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Watch the monorepo root for hoisted dependencies, but keep Expo's defaults
config.watchFolders = [...(config.watchFolders || []), monorepoRoot];

// Tell Metro where to find hoisted node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

module.exports = config;
