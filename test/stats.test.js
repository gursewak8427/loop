const test = require('node:test');
const assert = require('node:assert');
const { macMemUsed } = require('../src/main/stats');

// Made-up `vm_stat` output in the shape an Apple silicon Mac (16 KB pages) prints
// after running for a while: few free pages, much of the rest cache.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5021.
Pages active:                            301118.
Pages inactive:                          297412.
Pages speculative:                         2905.
Pages throttled:                              0.
Pages wired down:                        150231.
Pages purgeable:                           9214.
"Translation faults":                 912870245.
Pages copy-on-write:                   21875102.
Pages zero filled:                    411002345.
Pages reactivated:                      9871234.
Pages purged:                           1203456.
File-backed pages:                       249612.
Anonymous pages:                         351823.
Pages stored in compressor:              402371.
Pages occupied by compressor:             85117.
Decompressions:                        10234567.
Compressions:                          15678901.
Pageins:                                8765432.
Pageouts:                                 98765.
Swapins:                                      0.
Swapouts:                                     0.
`;

test('on macOS, used memory leaves out the cache that the system gives back', () => {
  const used = macMemUsed(VM_STAT);
  // app memory (anonymous - purgeable) + wired + compressed
  assert.strictEqual(used, (351823 - 9214 + 150231 + 85117) * 16384);
  // about 9.5 GB, where total - freemem() on a 16 GB Mac would say over 17 GB
  assert.ok(Math.abs(used / 1e9 - 9.47) < 0.01);
});

test('Intel Macs have 4 KB pages', () => {
  const text = VM_STAT.replace('16384', '4096');
  assert.strictEqual(macMemUsed(text), (351823 - 9214 + 150231 + 85117) * 4096);
});

test('output that is not vm_stat gives no figure, so the meter falls back', () => {
  assert.strictEqual(macMemUsed(''), null);
  assert.strictEqual(macMemUsed('Pages free: 12.\nPages wired down: 3.'), null);
});
