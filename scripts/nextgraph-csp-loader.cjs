// Build-only compatibility fix for @ng-org/web 0.1.2-alpha.17 (MIT/Apache-2.0).
// Its embedded async-proxy uses an empty Function subclass solely as a callable
// Proxy target. Constructing that subclass invokes Function(), which strict CSP
// rejects even though the SDK does not need to compile any code at runtime.
// Return an ordinary callable/constructable function instead. Keep this patch
// pinned to the audited bytes; a dependency update must be reviewed explicitly.
const { createHash } = require('node:crypto');

const PINNED_SHA256 = 'c3b4dac56ad4d3817480ab42cc86001a5031093f8c803abe0a642a82d0a15e56';
const ORIGINAL = 'class i extends Function{}';

module.exports = function nextgraphCspLoader(source) {
  if (createHash('sha256').update(source).digest('hex') !== PINNED_SHA256 ||
      source.split(ORIGINAL).length !== 2) {
    throw new Error('Nextgraph CSP compatibility patch requires the audited @ng-org/web 0.1.2-alpha.17 UMD bytes. Review the SDK before updating this patch.');
  }
  return source.replace(ORIGINAL, 'function i(){return function(){}}');
};
