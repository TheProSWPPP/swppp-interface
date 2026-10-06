import {expect,it} from 'vitest';
import {moveRange} from '../dateRange';
it('keeps inclusive date handles ordered and within the 366-day API limit',()=>{
 expect(moveRange({from:'2026-07-01',through:'2026-09-30'},'from','2026-10-01')).toEqual({from:'2026-10-01',through:'2026-10-01'});
 expect(moveRange({from:'2025-01-01',through:'2025-09-30'},'through','2026-10-01')).toEqual({from:'2025-10-01',through:'2026-10-01'});
 expect(moveRange({from:'2026-07-01',through:'2026-09-30'},'from','2026-08-01')).toEqual({from:'2026-08-01',through:'2026-09-30'});
});
