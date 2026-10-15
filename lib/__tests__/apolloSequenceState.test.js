import {describe,it,expect,beforeEach} from 'vitest';
import {sequencePaused,clearSequenceStateCache} from '../apolloSequenceState.js';
const detail=campaign=>async()=>({emailer_campaign:campaign});
describe('paused Apollo sequence detection',()=>{
  beforeEach(()=>clearSequenceStateCache());
  it('reports an auto-paused sequence with its reason',async()=>{
    expect(await sequencePaused('pb',{getDetail:detail({active:false,status_reason:'auto_pause_high_bounce',auto_paused_at:'2026-09-16T02:03:56Z'})}))
      .toEqual({reason:'auto_pause_high_bounce',pausedAt:'2026-09-16T02:03:56Z'});
  });
  it('treats an active sequence as sendable',async()=>{expect(await sequencePaused('agc',{getDetail:detail({active:true})})).toBeNull();});
  it('keeps current behavior when Apollo cannot be read',async()=>{
    expect(await sequencePaused('x',{getDetail:async()=>{throw Error('down')}})).toBeNull();
    expect(await sequencePaused('y',{getDetail:detail({})})).toBeNull();
    expect(await sequencePaused(null)).toBeNull();
  });
  it('reads Apollo once per sequence within five minutes',async()=>{
    let n=0;const getDetail=async()=>{n++;return {emailer_campaign:{active:false}}};
    await sequencePaused('pb',{getDetail,now:0});await sequencePaused('pb',{getDetail,now:60000});await sequencePaused('pb',{getDetail,now:400000});
    expect(n).toBe(2);
  });
});
