// The entry: it imports every module of the fixture, so that each bundler checks them all.
import * as pkgA from 'pkg-a';

import * as allow from './allow.js';
import * as ambiguous from './ambiguous.js';
import * as guards from './guards.js';
import * as legacy from './legacy/stream.js';
import * as libraries from './libraries.js';
import * as localIntl from './local-intl.js';
import * as probe from './probe.js';
import * as types from './types.ts';

console.log(pkgA, allow, ambiguous, guards, legacy, libraries, localIntl, probe, types);
