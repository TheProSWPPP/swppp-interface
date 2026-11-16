import {describe,it,expect} from 'vitest';
import {softGuardState} from '../softVerdictGuard.js';
describe('soft guard requires actual observation coverage',()=>{
 it('withholds soft enrollment when a readable database has no reporting coverage',async()=>{
  const db={query:async sql=>({rows:sql.includes('count(*)')?[{n:0}]:[]})};
  expect(await softGuardState(db,{soft_verdict_daily_cap:40})).toMatchObject({available:false,remaining:0});
 });
});
