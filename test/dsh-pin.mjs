// The exact @deepseek-ai/dsh release this bundle is tested against.
//
// One source for the pin: the replay boots this version, README and the replay
// evidence claim it, and package.json declares the supported range. A test
// keeps them in agreement instead of leaving four prose copies to drift.
export const DSH_PIN = '0.2.2-rc.1'

// The range package.json advertises. Its lower bound must be the pin above:
// a bundle exercised only on a release newer than the floor it claims would
// ship untested support for that floor.
export const DSH_RANGE = '>=0.2.2-rc.1 <0.3.0'
