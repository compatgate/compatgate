// Methods of library objects: the receiver is an import, so `union` and `take` are no findings.
import _ from 'lodash';
import * as R from 'ramda';

export const merged = _.union([1], [2]);
export const first = R.take(1, [1, 2]);
