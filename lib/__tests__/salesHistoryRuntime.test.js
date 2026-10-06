import {expect,it,vi} from 'vitest';
import {createSalesHistoryRuntime} from '../salesHistoryRuntime.js';

function fixture(overrides={}) {
 const db={query:vi.fn().mockResolvedValue({rows:[{locked:true}]}),release:vi.fn()};
 const deps={pool:{connect:vi.fn().mockResolvedValue(db)},apiToken:'test',fetchHistory:vi.fn().mockResolvedValue({deals:[]}),storeHistory:vi.fn().mockResolvedValue({deals:0}),schedule:vi.fn().mockReturnValue(1),cancel:vi.fn(),onError:vi.fn(),...overrides};
 return {db,deps,runtime:createSalesHistoryRuntime(deps)};
}
it('does nothing until explicitly enabled and schedules only reporting collection',async()=>{
 const {deps,runtime}=fixture();runtime.start();expect(deps.schedule).not.toHaveBeenCalled();
 runtime.start({enabled:true});await new Promise(resolve=>setImmediate(resolve));
 expect(deps.fetchHistory).toHaveBeenCalledWith({apiToken:'test'});
 expect(deps.storeHistory).toHaveBeenCalledWith(deps.pool,{deals:[]});
 expect(deps.schedule.mock.calls[0][1]).toBe(6*60*60*1000);
 runtime.stop();expect(deps.cancel).toHaveBeenCalledWith(1);
});
it('skips concurrent replicas when the reporting refresh lock is held',async()=>{
 const {db,deps,runtime}=fixture();db.query.mockResolvedValueOnce({rows:[{locked:false}]});
 expect(await runtime.run()).toEqual({skipped:'locked'});
 expect(deps.fetchHistory).not.toHaveBeenCalled();expect(db.release).toHaveBeenCalledOnce();
});
it('does not replace retained facts after a failed source read and releases its lock',async()=>{
 const {db,deps,runtime}=fixture({fetchHistory:vi.fn().mockRejectedValue(new Error('source_unavailable'))});
 await expect(runtime.run()).rejects.toThrow('source_unavailable');
 expect(deps.storeHistory).not.toHaveBeenCalled();
 expect(db.query.mock.calls.at(-1)[0]).toContain('pg_advisory_unlock');expect(db.release).toHaveBeenCalledOnce();
});
