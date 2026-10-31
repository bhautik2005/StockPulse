/** Scratch diagnostic (not a deliverable). */
import { describe, expect, it } from 'vitest';

import * as clientReact from 'react';
import * as rootProbe from '@testing-library/react';

describe('diagnostic', () => {
  it('reports the runtime', () => {
    console.log('typeof window           :', typeof window);
    console.log('typeof localStorage     :', typeof localStorage);
    console.log('typeof globalThis.local :', typeof globalThis.localStorage);
    console.log('typeof document         :', typeof document);
    console.log('react.version (import)  :', clientReact.version);
    console.log('testing-library keys    :', Object.keys(rootProbe).length);
    expect(true).toBe(true);
  });
});
