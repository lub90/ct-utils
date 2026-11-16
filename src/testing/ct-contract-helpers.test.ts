import { describe, expect, it } from 'vitest';
import { eventuallyCt, expectSaveAdds, requireUnassigned, secondCategory, tempLabel, throwawayPerson } from './index.js';

describe('contract helpers of the testing entry', () => {
    it('exports the helpers consumers need for their own contract cases', () => {
        for (const helper of [eventuallyCt, expectSaveAdds, requireUnassigned, secondCategory, tempLabel, throwawayPerson]) {
            expect(typeof helper).toBe('function');
        }
    });

    it('tempLabel names temporary objects after the module key', () => {
        expect(tempLabel('m')).toBe('m extension contract test');
    });
});
