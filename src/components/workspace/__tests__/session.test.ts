import {afterEach,expect,it,vi} from 'vitest';
import {getUser} from '../../../lib/sdrApi';
afterEach(()=>vi.unstubAllGlobals());
function saved(raw:string|null){vi.stubGlobal('localStorage',{getItem:()=>raw});}
it('keeps malformed or invalid saved identity from crashing other work areas',()=>{
 for(const raw of ['{broken','null','[]','{}','{"username":"user"}']){saved(raw);expect(getUser()).toBeNull();}
 saved(null);expect(getUser()).toBeNull();
});
it('retains a valid existing staff session',()=>{
 const user={id:'staff-id',username:'staff',email:'staff@example.test',display_name:'Staff User',role:'sdr'};
 saved(JSON.stringify(user));expect(getUser()).toEqual(user);
});
