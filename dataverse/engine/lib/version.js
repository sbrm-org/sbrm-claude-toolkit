'use strict';
// Toolkit version order (moved out of review.js in 1.11.9, DESIGN.md §12: the review, the check-ins and the
// nudge all compare versions, and one definition keeps "1.11.10 is newer than 1.11.9" true everywhere).

function isVersion(v) {
  return /^\d+(?:\.\d+)*$/.test(String(v || ''));
}

function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The newest of a list of versions (non-versions ignored), or null.
function newest(list) {
  const v = list.filter(isVersion);
  return v.length ? v.reduce((a, b) => (cmpVersion(a, b) >= 0 ? a : b)) : null;
}

module.exports = { isVersion, cmpVersion, newest };
